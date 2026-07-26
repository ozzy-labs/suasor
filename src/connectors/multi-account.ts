/**
 * Multi-account ingestion as a **generic connector capability** (ADR-0050,
 * Issue #441).
 *
 * The substrate a secretary needs — mail, calendar, files — is split across a
 * personal and a work account for most operators, and until now only Slack could
 * ingest more than one credential's worth of it. [ADR-0014] solved that for Slack
 * with a per-alias config table, per-alias secret naming, and per-alias error
 * isolation; [ADR-0042] later retired the *alias* for Slack, because a Slack
 * channel id is globally unique so the config could collapse to one flat list of
 * ids read by an unnamed token pool.
 *
 * That collapse does **not** transfer to google / ms-graph, and this module is
 * where the difference is encoded: their ingest scope is written in
 * *account-relative* names — `calendarIds = ["primary"]`,
 * `user = "someone@contoso.com"`, `resources = ["gmail"]` — which denote a
 * different object per credential (a UPN names a user *inside a tenant*). An
 * unnamed pool would have no way to say *whose* `primary`. So these connectors
 * keep the named account, and this module lifts exactly the parts of the
 * ADR-0014 pattern that survive that reasoning:
 *
 * - **per-account config table** — `[connectors.<name>.accounts.<account>]`,
 *   inheriting the flat `[connectors.<name>]` keys as defaults ({@link accountSlices});
 * - **per-account secret naming** — `connector:<name>:<account>:<secret>` with
 *   the matching `SUASOR_CONNECTOR_<NAME>_<ACCOUNT>_<SECRET>` env override
 *   ({@link accountSecretName}), keeping the keychain/env discipline of NFR-PRV-4
 *   with no new mechanism;
 * - **per-account identity namespacing** — {@link accountIdPrefix}, because
 *   Gmail message ids and Calendar event ids are *not* globally unique (the same
 *   meeting carries one event id in every attendee's calendar), so two accounts
 *   would otherwise collapse into one source;
 * - **per-account error isolation** — {@link syncAccountsIsolated}: one account's
 *   dead credential does not stop the others, and the pass throws only when every
 *   attempted account failed (the ADR-0014 invariant, mapped from workspaces to
 *   accounts, above the per-resource layer in `./per-resource.ts`).
 *
 * **Backward compatibility is structural, not a migration**: a config with no
 * `accounts` table resolves to exactly one account named `default`, whose secrets
 * and external ids are *unprefixed*. An existing single-account install keeps its
 * keychain entry, its env override and its already-ingested source lineage
 * untouched, and gains a second account by adding one table (see
 * docs/design/config.md).
 *
 * Import-clean (ADR-0007): `zod` + contract types only.
 *
 * [ADR-0014]: ../../docs/adr/0014-slack-multi-workspace.md
 * [ADR-0042]: ../../docs/adr/0042-slack-workspace-less-connector.md
 */
import { z } from "zod";
import type { ConnectorConfig, SourceRecord, SyncContext } from "./contract.ts";

/** Config key holding the per-account table: `[connectors.<name>.accounts.<x>]`. */
export const ACCOUNTS_KEY = "accounts";

/**
 * The account whose secrets and external ids stay **unprefixed**. A config with
 * no `accounts` table resolves to this one account, which is what makes
 * multi-account support a pure addition: the existing keychain account
 * (`connector:google:refreshToken`), env override and ingested `google:<resource>:<id>`
 * lineage all keep working untouched. Spelling it explicitly
 * (`[connectors.google.accounts.default]`) is how an operator adds a *second*
 * account without moving the first one's identity.
 */
export const DEFAULT_ACCOUNT_NAME = "default";

/**
 * Account names accepted in `[connectors.<name>.accounts.<account>]`. Restricted
 * to a conservative charset because the name is projected into three different
 * namespaces (keychain account, env var, external id) — a name with a `.` or a
 * space would produce an env var nobody can set, and a `:` would make the
 * external-id segmentation ambiguous.
 */
export const ACCOUNT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Whether a value is a plain object (a TOML table). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The env-var segment an account name contributes, using the **same**
 * normalization `secretEnvName` applies to the whole secret name (uppercase,
 * non-alphanumeric → `_`). Exported so the collision check below and the docs
 * agree with what `resolveSecret` actually reads.
 */
export function accountEnvSegment(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/**
 * Build the `accounts` field schema for a connector's config slice.
 *
 * `value` is the connector's own slice schema made **partial and strict**: strict
 * so a typo inside an account table fails at load like every other connector key
 * (`loadConfig` only applies `.strict()` at the top level, so nested strictness
 * has to be declared here), partial so a future account key without a schema
 * default is not demanded of every account.
 *
 * This schema **validates**; it does not resolve inheritance. Zod applies a
 * field's `.default(...)` even through `.partial()`, so the parsed accounts here
 * come back with schema defaults filled in and cannot distinguish "absent" from
 * "explicitly set to the default" — which is exactly the distinction inheritance
 * needs. {@link accountSlices} therefore merges the **raw** slice, and callers
 * parse the merged result. (Verified, not assumed: `accounts.work = {}` parses to
 * a full settings object, so treating the parse output as the effective config
 * would silently discard every inherited value.)
 *
 * Two rules are enforced as refinements rather than left to a runtime surprise:
 * the name charset ({@link ACCOUNT_NAME_PATTERN}), and **env-override
 * distinctness** — `work-mail` and `work_mail` are different accounts but
 * normalize to the same `SUASOR_CONNECTOR_<NAME>_WORK_MAIL_<SECRET>`, so one
 * would silently answer for the other.
 */
export function accountsRecord<T extends z.ZodType>(
  value: T,
): z.ZodType<Record<string, z.infer<T>>, Record<string, unknown>> {
  return z
    .record(z.string(), value)
    .default({})
    .superRefine((accounts, ctx) => {
      const byEnvSegment = new Map<string, string[]>();
      for (const name of Object.keys(accounts)) {
        if (!ACCOUNT_NAME_PATTERN.test(name)) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message:
              `invalid account name '${name}' — use letters, digits, '_' or '-' ` +
              `(the name becomes a keychain account, an env var and an external-id segment)`,
          });
          continue;
        }
        const segment = accountEnvSegment(name);
        byEnvSegment.set(segment, [...(byEnvSegment.get(segment) ?? []), name]);
      }
      for (const [segment, names] of byEnvSegment) {
        if (names.length < 2) continue;
        ctx.addIssue({
          code: "custom",
          path: [names[1] as string],
          message:
            `account names ${names.map((n) => `'${n}'`).join(" and ")} both map to the ` +
            `env override segment '${segment}', so one would answer for the other — rename one`,
        });
      }
    }) as unknown as z.ZodType<Record<string, z.infer<T>>, Record<string, unknown>>;
}

/** One account's raw, inheritance-resolved config slice. */
export interface AccountSlice {
  /** Account name (`default` when the config declares no `accounts` table). */
  readonly name: string;
  /**
   * Whether this account owns the **unprefixed** secret names and external ids
   * (true for the account literally named `default`, however it was declared).
   */
  readonly isDefault: boolean;
  /**
   * Whether the account came from an explicit `accounts` table. `false` for the
   * implicit single account, which is what lets every message, warning and CLI
   * block stay byte-identical to the single-account output it had before.
   */
  readonly declared: boolean;
  /**
   * The effective raw slice: the flat `[connectors.<name>]` keys (minus
   * `accounts`) overridden by this account's own keys. Still raw — the caller
   * parses it with the connector's Zod schema.
   */
  readonly slice: Record<string, unknown>;
}

/**
 * Resolve a connector config slice into its accounts, applying flat-key
 * inheritance. Deliberately raw (no Zod): the same resolution has to work for the
 * connector (which parses afterwards), for `doctor` (which inspects an already-
 * loaded config), and for the `auth` verbs (which read one account's settings).
 *
 * - no `accounts` table (or an empty one) → exactly one implicit `default`
 *   account carrying the flat keys, which is the pre-multi-account behaviour;
 * - an `accounts` table → one account per entry, sorted by name for a
 *   deterministic order, each inheriting the flat keys it does not override.
 *
 * Note the deliberate asymmetry: once an `accounts` table exists, the flat keys
 * are **inheritance defaults only** and are not themselves an ingested account.
 * Making them implicitly a second account would mean an operator could never
 * express "one OAuth client id, two mailboxes" without ingesting a phantom third.
 * The cost — an operator who adds a named account to an existing flat config
 * stops ingesting the flat one — is not left to be discovered: `doctor` reports
 * it, and reports it as an *error-grade* warning precisely when a credential for
 * the unnamed default is still stored (see `noop-check.ts`).
 */
export function accountSlices(raw: ConnectorConfig | undefined): AccountSlice[] {
  const slice = isRecord(raw) ? raw : {};
  const base: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slice)) {
    if (key !== ACCOUNTS_KEY) base[key] = value;
  }
  const table = slice[ACCOUNTS_KEY];
  if (!isRecord(table) || Object.keys(table).length === 0) {
    return [{ name: DEFAULT_ACCOUNT_NAME, isDefault: true, declared: false, slice: base }];
  }
  return Object.keys(table)
    .sort()
    .map((name) => {
      const override = table[name];
      return {
        name,
        isDefault: name === DEFAULT_ACCOUNT_NAME,
        declared: true,
        slice: { ...base, ...(isRecord(override) ? override : {}) },
      };
    });
}

/** Whether a config slice declares an explicit `accounts` table. */
export function hasDeclaredAccounts(raw: ConnectorConfig | undefined): boolean {
  const slice = isRecord(raw) ? raw : {};
  const table = slice[ACCOUNTS_KEY];
  return isRecord(table) && Object.keys(table).length > 0;
}

/**
 * The secret name an account resolves via `ctx.secret(...)`: the base name for
 * `default`, `<account>:<base>` otherwise. Combined with `secrets.ts` this yields
 * keychain account `connector:<name>:<account>:<base>` and env override
 * `SUASOR_CONNECTOR_<NAME>_<ACCOUNT>_<BASE>` — no new mechanism, just a
 * structured secret name (ADR-0014 決定 2, generalized).
 */
export function accountSecretName(account: Pick<AccountSlice, "isDefault" | "name">, base: string) {
  return account.isDefault ? base : `${account.name}:${base}`;
}

/**
 * The external-id segment an account contributes: empty for `default`,
 * `<account>:` otherwise, so ids read `google:<resource>:<id>` /
 * `google:<account>:<resource>:<id>`.
 *
 * Prefixing is a correctness requirement, not cosmetics: Gmail message ids are
 * unique per mailbox and Calendar event ids are shared across every attendee's
 * copy of a meeting, so two accounts ingesting the same meeting would otherwise
 * write one source that flip-flops between them. Leaving `default` unprefixed is
 * what keeps an existing install's ingested lineage addressable (ADR-0050 決定 3).
 */
export function accountIdPrefix(account: Pick<AccountSlice, "isDefault" | "name">): string {
  return account.isDefault ? "" : `${account.name}:`;
}

/** One account's outcome in a per-account isolated pass. */
export interface AccountOutcome {
  /** Account name. */
  readonly account: string;
  /** `ok` — ran; `failed` — threw; `skipped` — precheck refused (e.g. no credential). */
  readonly status: "ok" | "failed" | "skipped";
  /** Why it failed / was skipped (absent for `ok`). */
  readonly message?: string;
}

/** Aggregated outcome of a per-account isolated pass. */
export interface AccountIsolationResult {
  /** Per-account outcomes, in the order the accounts ran. */
  readonly outcomes: readonly AccountOutcome[];
  /**
   * At least one account failed or was skipped while at least one succeeded. The
   * connector forwards it on `SyncResult.partialFailure` so the CLI exits
   * non-zero (ADR-0027): a configured account that ingested nothing is a fact
   * cron / CI must be able to gate on, not something to hide behind exit 0.
   */
  readonly partialFailure: boolean;
  /** Human-readable summary line(s); omitted when every account ran cleanly. */
  readonly summaryLines?: readonly string[];
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run a per-account ingest with account-level error isolation — the outer layer
 * above `syncResourcesIsolated` (ADR-0014's per-workspace invariant, mapped onto
 * accounts).
 *
 * For each account, `precheck` runs first and may refuse it with a reason (the
 * tokenless-account case ADR-0007 requires to be a warned skip rather than a
 * total failure). Accounts that pass stream through `body`, which receives a
 * context whose `onWarn` is **prefixed with the account name** — but only when
 * more than the implicit single account exists, so single-account output stays
 * byte-identical.
 *
 * Termination rules, in order:
 * - every account skipped → throw. The central credential check (ADR-0007)
 *   should have caught this first; reaching it anyway means the pass would
 *   otherwise report a clean 0-record success for a config that ingests nothing.
 * - every *attempted* account failed → rethrow the last error (a total failure is
 *   an error, not a partial success).
 * - otherwise → aggregate one warn naming each failed / skipped account and
 *   report {@link AccountIsolationResult} through `onResult`.
 */
export async function* syncAccountsIsolated<A extends AccountSlice>(
  accounts: readonly A[],
  ctx: SyncContext,
  precheck: (account: A) => Promise<string | null>,
  body: (account: A, accountCtx: SyncContext) => AsyncIterable<SourceRecord>,
  onResult: (result: AccountIsolationResult) => void,
): AsyncIterable<SourceRecord> {
  const multi = accounts.some((account) => account.declared);
  const outcomes: AccountOutcome[] = [];
  let okCount = 0;
  let attempted = 0;
  let lastError: unknown;

  for (const account of accounts) {
    const prefix = multi ? `account '${account.name}': ` : "";
    const accountCtx: SyncContext = multi
      ? { ...ctx, ...(ctx.onWarn ? { onWarn: (m: string) => ctx.onWarn?.(`${prefix}${m}`) } : {}) }
      : ctx;

    const refusal = await precheck(account);
    if (refusal !== null) {
      outcomes.push({ account: account.name, status: "skipped", message: refusal });
      ctx.onWarn?.(`account '${account.name}' skipped: ${refusal}`);
      continue;
    }

    attempted += 1;
    try {
      yield* body(account, accountCtx);
      okCount += 1;
      outcomes.push({ account: account.name, status: "ok" });
    } catch (error) {
      // Per-account isolation: one account's failure must not abort the others.
      lastError = error;
      outcomes.push({ account: account.name, status: "failed", message: errorMessage(error) });
    }
  }

  if (accounts.length > 0 && attempted === 0) {
    const names = outcomes.map((o) => `'${o.account}' (${o.message ?? "skipped"})`).join(", ");
    throw new Error(`no account could be synced: ${names}`);
  }
  if (attempted > 0 && okCount === 0) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const degraded = outcomes.filter((o) => o.status !== "ok");
  if (degraded.length > 0) {
    const detail = degraded.map((o) => `${o.account} (${o.message ?? o.status})`).join(", ");
    ctx.onWarn?.(
      `${okCount} account OK, ${degraded.length} not synced (records preserved) — ${detail}`,
    );
  }

  onResult({
    outcomes,
    partialFailure: degraded.length > 0,
    ...(degraded.length > 0
      ? {
          summaryLines: [
            `accounts: ${outcomes
              .map((o) => (o.status === "ok" ? `${o.account}=ok` : `${o.account}=${o.status}`))
              .join(", ")}`,
          ],
        }
      : {}),
  });
}
