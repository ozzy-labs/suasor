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
import { connectorBundledInBinary } from "../../connectors/registry.ts";
import type { KeychainBackend } from "../../connectors/secrets.ts";
import { secretEnvName } from "../../connectors/secrets.ts";
import { standaloneGate } from "../build-target.ts";
import { isInteractiveStdin, readSecretLine } from "../read-secret.ts";

/** Base class for `<connector> auth set` — stores the connector secret in the keychain. */
class ConnectorAuthSetCommand extends Command {
  static connectorName = "";

  token = Option.String("--token", { description: "Secret value (omit to read from stdin)." });

  override async execute(): Promise<number> {
    const connector = (this.constructor as typeof ConnectorAuthSetCommand).connectorName;
    const { AUTH_SPECS } = await import("../../connectors/auth-specs.ts");
    const spec = AUTH_SPECS[connector];
    if (!spec) {
      this.context.stderr.write(`error: no auth spec for connector '${connector}'\n`);
      return 1;
    }

    // `auth set` writes to the OS keychain (@napi-rs/keyring), which is external
    // to the standalone binary (ADR-0010). In the binary, secrets must come from
    // the env override instead — so gate keychain writes and point there.
    const setGate = standaloneGate(
      `'${connector} auth set' (the OS keychain is not available in the binary)`,
      {
        hint:
          `set the secret via the env override instead: ` +
          `${secretEnvName(connector, spec.secretName)}=<value>`,
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
    const { storeSecret } = await import("../../connectors/secrets.ts");
    await storeSecret(connector, spec.secretName, value, keychain ? { keychain } : {});
    this.context.stdout.write(
      `Stored ${connector} ${spec.secretLabel} in the OS keychain ` +
        `(service 'suasor', account 'connector:${connector}:${spec.secretName}').\n`,
    );
    this.context.stdout.write(`next: verify it with \`suasor ${connector} auth test\`.\n`);
    return 0;
  }
}

/** Base class for `<connector> auth test` — verifies the stored credential. */
class ConnectorAuthTestCommand extends Command {
  static connectorName = "";

  json = Option.Boolean("--json", false, { description: "Emit the result as JSON." });

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

    const [{ loadConfig }, { makeSecretResolver }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../connectors/secrets.ts"),
    ]);
    const config = await loadConfig();
    const slice = (config.connectors[connector] ?? {}) as Record<string, unknown>;
    const secret = makeSecretResolver(connector);

    let report: Awaited<ReturnType<typeof spec.test>>;
    try {
      report = await spec.test({ secret, config: slice });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const hint = message.startsWith(`no ${connector} `)
        ? ` (run \`suasor ${connector} auth set\` or set the env override)`
        : "";
      this.context.stderr.write(`error: ${message}${hint}\n`);
      return 1;
    }

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }

    this.context.stdout.write(`ok: ${connector} credential for ${report.principal}\n`);
    this.context.stdout.write(`scopes: ${report.scopes ?? "(none reported)"}\n`);
    if (report.features.length > 0) {
      this.context.stdout.write("features:\n");
      for (const f of report.features) {
        this.context.stdout.write(`  ${f.label}: ${f.status}\n`);
      }
    }
    return 0;
  }
}

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
        Runs a single read-only round-trip to confirm the stored credential is
        live, then prints the resolved identity, granted scopes (when the API
        reports them), and a 'features:' readiness block (READY / MISSING / N/A).
        The credential never touches stderr; only the API's error code is shown.
      `,
      examples: [
        [`Test the stored credential`, `suasor ${name} auth test`],
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
