/**
 * `suasor <connector> auth set` / `suasor <connector> auth test` for the
 * non-Slack token-bearing connectors (github / ms-graph / google / box; Issue
 * #85). Extends ADR-0011's Slack-only operational verbs to the other connectors
 * so every credential has a keychain onboarding path (`auth set`) and a pre-sync
 * verification path (`auth test`) — closing the gap where these tokens could
 * only be validated by running `sync` and watching it fail (ADR-0007's
 * "no silent wrong answer").
 *
 * One `auth set` + one `auth test` command is registered per connector, derived
 * from the {@link import("../../connectors/auth-specs.ts").AUTH_SPECS} SSOT. The
 * verbs are connector-specific CLI commands (the generic connector contract stays
 * `sync`-only, ADR-0007); Slack keeps its own richer `slack auth set/test`.
 *
 * Lazy-import discipline (NFR-PRF-1): top-level imports are clipanion + the auth
 * spec **names** + the import-clean secret-entry helper (`read-secret.ts`, no
 * SDK) only — all cheap, loading no native binding. The keychain (`secrets.ts`,
 * which lazy-loads the native keyring), the config loader, and the per-connector
 * `fetch`-only auth probes are imported inside `execute`. No connector SDK is
 * pulled by any of these verbs.
 */
import { Command, type CommandClass, Option } from "clipanion";
import { authConnectorNames } from "../../connectors/auth-specs.ts";
import type { AccountSlice } from "../../connectors/multi-account.ts";
import { connectorBundledInBinary } from "../../connectors/registry.ts";
import type { ResourceReachabilityState } from "../../connectors/resource-probe.ts";
import type { KeychainBackend } from "../../connectors/secrets.ts";
import { secretEnvName } from "../../connectors/secrets.ts";
import { standaloneGate } from "../build-target.ts";
import { ambiguousAccountMessage, resolveConnectorAccounts } from "../connector-account.ts";
import { isInteractiveStdin, readSecretLine } from "../read-secret.ts";

/**
 * Whether the config declares a `[connectors.<name>]` slice (Issue #529).
 *
 * A stored credential is inert without one — nothing enumerates a connector the
 * config does not mention. Failing to load the config is treated as "cannot
 * tell": the note is an advisory, and a broken/absent config is a different
 * problem that other commands report properly.
 */
async function hasConnectorSlice(connector: string): Promise<boolean> {
  try {
    const { loadConfig } = await import("../../config/index.ts");
    const config = await loadConfig();
    return config.connectors[connector] !== undefined;
  } catch {
    return true;
  }
}

/** Base class for `<connector> auth set` — stores the connector secret in the keychain. */
class ConnectorAuthSetCommand extends Command {
  static connectorName = "";

  token = Option.String("--token", { description: "Secret value (omit to read from stdin)." });

  account = Option.String("--account", {
    description:
      "Account to store the credential for, on connectors with a [connectors.<name>.accounts.<account>] table (ADR-0050).",
  });

  override async execute(): Promise<number> {
    const connector = (this.constructor as typeof ConnectorAuthSetCommand).connectorName;
    const { AUTH_SPECS } = await import("../../connectors/auth-specs.ts");
    const spec = AUTH_SPECS[connector];
    if (!spec) {
      this.context.stderr.write(`error: no auth spec for connector '${connector}'\n`);
      return 1;
    }

    const resolved = await resolveConnectorAccounts(connector, this.account, {
      tolerateConfigError: true,
    });
    if (!resolved.ok) {
      this.context.stderr.write(resolved.message);
      return 1;
    }
    // `auth set` writes exactly one secret, so an ambiguous target is refused
    // rather than resolved by picking one — storing a work token under the
    // personal account's name is invisible until the wrong mailbox syncs.
    if (resolved.accounts.length > 1) {
      this.context.stderr.write(ambiguousAccountMessage(connector, resolved.accounts));
      return 1;
    }
    const target = resolved.accounts[0] as AccountSlice;
    const { accountSecretName } = await import("../../connectors/multi-account.ts");
    const secretName = accountSecretName(target, spec.secretName);

    // `auth set` writes to the OS keychain (@napi-rs/keyring), which is external
    // to the standalone binary (ADR-0010). In the binary, secrets must come from
    // the env override instead — so gate keychain writes and point there.
    const setGate = standaloneGate(
      `'${connector} auth set' (the OS keychain is not available in the binary)`,
      {
        hint:
          `set the secret via the env override instead: ` +
          `${secretEnvName(connector, secretName)}=<value>`,
      },
    );
    if (!setGate.ok) {
      this.context.stderr.write(setGate.message);
      return 1;
    }

    let value = this.token?.trim();
    if (!value) {
      // On a TTY prompt to stderr so the user isn't staring at a blank line
      // waiting; over a pipe stay silent (stdout stays machine-readable). The
      // read is line-based and echo-suppressed (Issue #383).
      if (isInteractiveStdin(this.context.stdin)) {
        this.context.stderr.write(
          `Paste the ${connector} ${spec.secretLabel} and press Enter (input is not echoed):\n`,
        );
      }
      value = (
        await readSecretLine(this.context.stdin, this.context.stderr, { mask: true })
      ).trim();
    }
    if (!value) {
      this.context.stderr.write(
        `error: no ${spec.secretLabel} provided (pass --token or pipe it on stdin)\n`,
      );
      return 1;
    }

    const keychain = (this.context as { keychain?: KeychainBackend }).keychain;
    const { storeSecret, storeSecretErrorMessage } = await import("../../connectors/secrets.ts");
    try {
      await storeSecret(connector, secretName, value, keychain ? { keychain } : {});
    } catch (cause) {
      // A headless host (Docker, a server) has no Secret Service — the write
      // throws *after* the secret was pasted. Print the env-override recovery
      // instead of the raw native error (Issue #557).
      this.context.stderr.write(storeSecretErrorMessage(connector, secretName, cause));
      return 1;
    }
    const forAccount = target.declared ? ` for account '${target.name}'` : "";
    this.context.stdout.write(
      `Stored ${connector} ${spec.secretLabel}${forAccount} in the OS keychain ` +
        `(service 'suasor', account 'connector:${connector}:${secretName}').\n`,
    );
    this.context.stdout.write(
      `next: verify it with \`suasor ${connector} auth test${target.declared ? ` --account ${target.name}` : ""}\`.\n`,
    );
    // A stored secret alone does not enable a connector: `[connectors.<name>]`
    // has to exist in the config for anything to read it. ADR-0029 called the
    // auth/config disconnect structurally fixed, but only the wizard path
    // closes it — `auth set` on its own left the operator with a working
    // credential and a connector that silently never syncs.
    if (!(await hasConnectorSlice(connector))) {
      this.context.stdout.write(
        `note: config has no [connectors.${connector}] section, so this credential is not used yet — ` +
          `add it with \`suasor onboard --connector ${connector}\` (or by hand).\n`,
      );
    }
    return 0;
  }
}

/** Base class for `<connector> auth test` — verifies the stored credential. */
class ConnectorAuthTestCommand extends Command {
  static connectorName = "";

  json = Option.Boolean("--json", false, { description: "Emit the result as JSON." });
  noProbe = Option.Boolean("--no-probe", false, {
    description:
      "Skip the per-resource reachability probe (google / ms-graph); report scope readiness only.",
  });

  account = Option.String("--account", {
    description:
      "Test only this account, on connectors with a [connectors.<name>.accounts.<account>] table (ADR-0050). Omit to test every configured account.",
  });

  override async execute(): Promise<number> {
    const connector = (this.constructor as typeof ConnectorAuthTestCommand).connectorName;
    const { AUTH_SPECS } = await import("../../connectors/auth-specs.ts");
    const spec = AUTH_SPECS[connector];
    if (!spec) {
      this.context.stderr.write(`error: no auth spec for connector '${connector}'\n`);
      return 1;
    }

    // `auth test` runs the connector's live probe, which needs its SDK. For the
    // connectors kept external to the binary (ms-graph / google / box) the probe
    // can't load there; gate them. The keychain is also external, but `auth test`
    // resolves env-override secrets first, so the bundled-SDK connectors (github)
    // still verify in the binary via SUASOR_CONNECTOR_<NAME>_<SECRET>.
    if (!connectorBundledInBinary(connector)) {
      const testGate = standaloneGate(
        `'${connector} auth test' (the ${connector} connector SDK is not shipped in the binary)`,
      );
      if (!testGate.ok) {
        this.context.stderr.write(testGate.message);
        return 1;
      }
    }

    const resolved = await resolveConnectorAccounts(connector, this.account, {
      tolerateConfigError: false,
    });
    if (!resolved.ok) {
      this.context.stderr.write(resolved.message);
      return 1;
    }
    const { accountSecretName } = await import("../../connectors/multi-account.ts");
    const { makeSecretResolver } = await import("../../connectors/secrets.ts");

    // Every configured account is tested unless one is named (ADR-0050). Testing
    // only the first would report `ok` for an install whose work account has a
    // dead credential — the same "one green line hides a broken half" shape the
    // scope / reachability split exists to prevent.
    const reports: Array<{
      account: string | null;
      report: Awaited<ReturnType<typeof spec.test>>;
    }> = [];
    let failed = false;
    for (const account of resolved.accounts) {
      const label = account.declared ? account.name : null;
      const secret = (name: string) =>
        makeSecretResolver(connector)(accountSecretName(account, name));
      try {
        // The reachability probe defaults ON (ADR-0049): the whole point of the
        // verb is "will this credential actually work", and the operator should
        // not have to know to ask for the layer that answers it. It costs one
        // extra read-only GET per configured resource on an explicit health
        // command; --no-probe opts out for a scopes-only run.
        reports.push({
          account: label,
          report: await spec.test({ secret, config: account.slice, probe: !this.noProbe }),
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const hint = message.startsWith(`no ${connector} `)
          ? ` (run \`suasor ${connector} auth set${label ? ` --account ${label}` : ""}\` or set the env override)`
          : "";
        // One account's failure is reported and the rest still run: the operator
        // asked "are my credentials live", and stopping at the first dead one
        // answers that question for only part of the install.
        this.context.stderr.write(
          `error: ${label ? `account '${label}': ` : ""}${message}${hint}\n`,
        );
        failed = true;
      }
    }

    if (this.json) {
      // Nothing verified → no JSON at all, the pre-ADR-0050 behaviour. Emitting
      // an empty `{accounts:{}}` would look like a successful probe that found
      // no accounts, when in fact every probe failed (the errors went to stderr).
      if (reports.length === 0) return 1;
      // Shape is stable per config: a single unnamed account keeps the bare
      // report object every existing consumer reads; a declared `accounts` table
      // yields one entry per account, keyed by name.
      const payload =
        reports.length === 1 && reports[0]?.account === null
          ? reports[0].report
          : {
              accounts: Object.fromEntries(
                reports.map(({ account, report }) => [account ?? "default", report]),
              ),
            };
      this.context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return failed ? 1 : 0;
    }

    for (const { account, report } of reports) {
      if (account !== null) this.context.stdout.write(`account: ${account}\n`);
      this.context.stdout.write(`ok: ${connector} credential for ${report.principal}\n`);
      this.context.stdout.write(`scopes: ${report.scopes ?? "(none reported)"}\n`);
      if (report.features.length > 0) {
        this.context.stdout.write("features:\n");
        for (const f of report.features) {
          this.context.stdout.write(`  ${f.label}: ${f.status}\n`);
        }
      }
      // Kept as its own block, never merged into `features:` — a scope row is a
      // self-report about what was granted, a reachability row is what the API
      // answered, and folding two confidence levels into one line lets the weaker
      // one masquerade as the stronger (ADR-0049).
      if (report.resources && report.resources.length > 0) {
        this.context.stdout.write("resources (live probe):\n");
        for (const r of report.resources) {
          this.context.stdout.write(`  ${r.resource}: ${RESOURCE_LABEL[r.state]} — ${r.detail}\n`);
        }
      }
    }
    return failed ? 1 : 0;
  }
}

/** Display label per reachability verdict (uppercase, matching `features:`). */
const RESOURCE_LABEL: Record<ResourceReachabilityState, string> = {
  reachable: "REACHABLE",
  unreachable: "UNREACHABLE",
  unknown: "UNKNOWN",
};

/** Build the `<name> auth set` command for one connector. */
function makeAuthSetCommand(name: string): CommandClass {
  const Sub = class extends ConnectorAuthSetCommand {
    static override paths = [[name, "auth", "set"]];
    static override connectorName = name;
    static override usage = Command.Usage({
      category: "Connector auth",
      description: `Store the ${name} credential in the OS keychain (service 'suasor').`,
      details: `
        Persists the credential so '${name} auth test' and '${name} sync' resolve
        it without it ever touching config.toml (NFR-PRV-4). Pass --token, or omit
        it to read the value from stdin (e.g. a pipe).
      `,
      examples: [
        [`Store from stdin`, `echo <secret> | suasor ${name} auth set`],
        [`Store inline`, `suasor ${name} auth set --token <secret>`],
      ],
    });
  };
  Object.defineProperty(Sub, "name", { value: `${name}AuthSetCommand` });
  return Sub;
}

/** Build the `<name> auth test` command for one connector. */
function makeAuthTestCommand(name: string): CommandClass {
  const Sub = class extends ConnectorAuthTestCommand {
    static override paths = [[name, "auth", "test"]];
    static override connectorName = name;
    static override usage = Command.Usage({
      category: "Connector auth",
      description: `Verify the stored ${name} credential and report identity + scopes.`,
      details: `
        Runs a read-only round-trip to confirm the stored credential is live,
        then prints the resolved identity, granted scopes (when the API reports
        them), and a 'features:' readiness block (READY / MISSING / N/A).

        For the resource-gated connectors (google / ms-graph) it additionally
        probes each configured 'resources' entry with one read-only GET and
        prints a separate 'resources (live probe):' block
        (REACHABLE / UNREACHABLE / UNKNOWN, ADR-0049). This is what catches a
        mistyped calendarIds entry or user, and an app permission that was never granted
        — neither of which a scope check can see. Pass --no-probe to skip it.
        A probe that cannot establish the fact reports UNKNOWN; it is never
        reported as reachable.

        The credential never touches stderr; only the API's error code is shown.
      `,
      examples: [
        [`Test the stored credential`, `suasor ${name} auth test`],
        [`Scopes only, no live resource probe`, `suasor ${name} auth test --no-probe`],
        [`As JSON`, `suasor ${name} auth test --json`],
      ],
    });
  };
  Object.defineProperty(Sub, "name", { value: `${name}AuthTestCommand` });
  return Sub;
}

/** Every connector's `auth set` + `auth test` commands (cheap: loads no SDK). */
export function connectorAuthCommands(): CommandClass[] {
  const commands: CommandClass[] = [];
  for (const name of authConnectorNames()) {
    commands.push(makeAuthSetCommand(name), makeAuthTestCommand(name));
  }
  return commands;
}
