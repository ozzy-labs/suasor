/**
 * Multi-account ingestion as a generic connector capability (ADR-0050 / #441).
 *
 * The module is pure (no SDK, no network), so account resolution, secret naming,
 * external-id namespacing and per-account error isolation are exercised directly.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  type AccountIsolationResult,
  type AccountSlice,
  accountEnvSegment,
  accountIdPrefix,
  accountSecretName,
  accountSlices,
  accountsRecord,
  hasDeclaredAccounts,
  syncAccountsIsolated,
} from "../../src/connectors/multi-account.ts";

function record(externalId: string): SourceRecord {
  return {
    externalId,
    sourceType: "test",
    body: externalId,
    observedAt: "2026-07-01T00:00:00.000Z",
    meta: {},
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<string[]> {
  const out: string[] = [];
  for await (const r of it) out.push(r.externalId);
  return out;
}

describe("accountSlices — resolution + inheritance", () => {
  test("no accounts table ⇒ one implicit, undeclared default account", () => {
    expect(accountSlices({ clientId: "c" })).toEqual([
      { name: "default", isDefault: true, declared: false, slice: { clientId: "c" } },
    ]);
  });

  test("an empty accounts table is treated as no table at all", () => {
    const [only] = accountSlices({ clientId: "c", accounts: {} });
    expect(only?.declared).toBe(false);
    expect(only?.slice).toEqual({ clientId: "c" });
  });

  test("declared accounts inherit the flat keys they do not override", () => {
    const accounts = accountSlices({
      clientId: "shared",
      resources: ["gmail"],
      accounts: { work: { resources: ["gmail", "calendar"] }, personal: {} },
    });
    // Sorted by name, so the order does not depend on TOML parse order.
    expect(accounts.map((a) => a.name)).toEqual(["personal", "work"]);
    expect(accounts[0]?.slice).toEqual({ clientId: "shared", resources: ["gmail"] });
    expect(accounts[1]?.slice).toEqual({ clientId: "shared", resources: ["gmail", "calendar"] });
  });

  test("the `accounts` key itself never leaks into an account's own slice", () => {
    const [account] = accountSlices({ clientId: "c", accounts: { work: {} } });
    expect(account?.slice).not.toHaveProperty("accounts");
  });

  test("an explicitly declared `default` is still the unprefixed account", () => {
    const accounts = accountSlices({ accounts: { default: {}, work: {} } });
    expect(accounts.map((a) => [a.name, a.isDefault, a.declared])).toEqual([
      ["default", true, true],
      ["work", false, true],
    ]);
  });

  test("hasDeclaredAccounts distinguishes the two shapes", () => {
    expect(hasDeclaredAccounts({ clientId: "c" })).toBe(false);
    expect(hasDeclaredAccounts({ accounts: {} })).toBe(false);
    expect(hasDeclaredAccounts({ accounts: { work: {} } })).toBe(true);
  });
});

describe("secret + identity namespacing", () => {
  const def = { name: "default", isDefault: true };
  const work = { name: "work", isDefault: false };

  test("the default account keeps the pre-ADR-0050 secret name and id shape", () => {
    // This is the whole backward-compatibility claim: an existing install's
    // keychain entry and already-ingested external ids must keep resolving.
    expect(accountSecretName(def, "refreshToken")).toBe("refreshToken");
    expect(accountIdPrefix(def)).toBe("");
  });

  test("a named account is namespaced in both", () => {
    expect(accountSecretName(work, "refreshToken")).toBe("work:refreshToken");
    expect(accountIdPrefix(work)).toBe("work:");
  });

  test("the env segment matches what secretEnvName normalizes to", () => {
    expect(accountEnvSegment("work-mail")).toBe("WORK_MAIL");
    expect(accountEnvSegment("Work2")).toBe("WORK2");
  });
});

describe("accountsRecord — validation", () => {
  const schema = z.object({ clientId: z.string().default("") }).extend({
    accounts: accountsRecord(
      z
        .object({ clientId: z.string().default("") })
        .partial()
        .strict(),
    ),
  });

  test("accepts a well-formed table", () => {
    expect(schema.safeParse({ accounts: { work: { clientId: "c" } } }).success).toBe(true);
  });

  test("rejects a name that cannot become a keychain / env / id segment", () => {
    const result = schema.safeParse({ accounts: { "bad name": {} } });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("invalid account name");
  });

  test("rejects two names that collide in the env override", () => {
    // `work-mail` and `work_mail` are distinct accounts but both read
    // SUASOR_CONNECTOR_<NAME>_WORK_MAIL_<SECRET>, so one would answer for the
    // other — silently, and only for whichever the env happened to set.
    const result = schema.safeParse({ accounts: { "work-mail": {}, work_mail: {} } });
    expect(result.success).toBe(false);
    expect(result.success ? "" : result.error.issues[0]?.message).toContain("WORK_MAIL");
  });

  test("rejects a typo inside an account table (nested strictness)", () => {
    const result = schema.safeParse({ accounts: { work: { clientid: "c" } } });
    expect(result.success).toBe(false);
  });
});

describe("syncAccountsIsolated — per-account error isolation", () => {
  const declared = (name: string): AccountSlice => ({
    name,
    isDefault: name === "default",
    declared: true,
    slice: {},
  });
  const implicitDefault: AccountSlice = {
    name: "default",
    isDefault: true,
    declared: false,
    slice: {},
  };

  async function run(
    accounts: readonly AccountSlice[],
    precheck: (a: AccountSlice) => Promise<string | null>,
    body: (a: AccountSlice, ctx: SyncContext) => AsyncIterable<SourceRecord>,
  ): Promise<{ ids: string[]; warns: string[]; result: AccountIsolationResult | null }> {
    const warns: string[] = [];
    const ctx: SyncContext = {
      cursor: null,
      secret: async () => null,
      onWarn: (m) => warns.push(m),
    };
    let result: AccountIsolationResult | null = null;
    const ids = await collect(
      syncAccountsIsolated(accounts, ctx, precheck, body, (r) => {
        result = r;
      }),
    );
    return { ids, warns, result };
  }

  test("one account's failure does not stop the others", async () => {
    const { ids, warns, result } = await run(
      [declared("personal"), declared("work")],
      async () => null,
      async function* (account) {
        if (account.name === "personal") throw new Error("token revoked");
        yield record("work:1");
      },
    );
    expect(ids).toEqual(["work:1"]);
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines).toEqual(["accounts: personal=failed, work=ok"]);
    expect(warns.join("\n")).toContain("personal (token revoked)");
  });

  test("a tokenless account is a warned skip, not a failure", async () => {
    const { ids, warns, result } = await run(
      [declared("personal"), declared("work")],
      async (account) => (account.name === "work" ? "no refreshToken configured" : null),
      async function* () {
        yield record("personal:1");
      },
    );
    expect(ids).toEqual(["personal:1"]);
    expect(result?.outcomes.map((o) => o.status)).toEqual(["ok", "skipped"]);
    // Still a partial failure: a configured account that ingested nothing must
    // not hide behind exit 0 in cron / CI (ADR-0027 exit-code parity).
    expect(result?.partialFailure).toBe(true);
    expect(warns.join("\n")).toContain("account 'work' skipped: no refreshToken configured");
  });

  test("every account failing rethrows rather than reporting an empty success", async () => {
    const attempt = run(
      [declared("personal"), declared("work")],
      async () => null,
      async function* (account) {
        if (account.declared) throw new Error("all dead");
        yield record("unreachable");
      },
    );
    expect(attempt).rejects.toThrow("all dead");
  });

  test("every account skipped throws — a config that ingests nothing is not a clean run", async () => {
    const attempt = run(
      [declared("personal")],
      async () => "no credential",
      async function* () {},
    );
    expect(attempt).rejects.toThrow("no account could be synced");
  });

  test("warnings from a declared account are prefixed with its name", async () => {
    const { warns } = await run(
      [declared("personal"), declared("work")],
      async () => null,
      async function* (_account, accountCtx) {
        accountCtx.onWarn?.("2 resource OK, 1 failed");
        yield record("x");
      },
    );
    expect(warns).toContain("account 'personal': 2 resource OK, 1 failed");
  });

  test("the implicit single account emits no account wording at all", async () => {
    // Byte-identical single-account output is the backward-compatibility
    // contract: no prefix, no summary line, no partial-failure flag.
    const { ids, warns, result } = await run(
      [implicitDefault],
      async () => null,
      async function* (_account, accountCtx) {
        accountCtx.onWarn?.("resources: drive=ok");
        yield record("google:drive:1");
      },
    );
    expect(ids).toEqual(["google:drive:1"]);
    expect(warns).toEqual(["resources: drive=ok"]);
    expect(result?.partialFailure).toBe(false);
    expect(result?.summaryLines).toBeUndefined();
  });
});
