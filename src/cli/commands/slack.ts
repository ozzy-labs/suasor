/**
 * Slack operational verbs (ADR-0011): `slack auth set` · `slack auth test` ·
 * `slack conversations`. These are operational commands, not ingest — they are
 * Slack-specific (the generic connector contract stays `sync`-only, ADR-0007)
 * and exist to close the onboarding gap: store a token, verify its scopes, and
 * discover conversation ids without hand-hunting them.
 *
 * Lazy-import discipline (NFR-PRF-1): top-level imports are clipanion only. The
 * keychain (`../../connectors/secrets.ts`, which lazy-loads the native keyring)
 * and the Slack leaf modules (which use the global `fetch`, no SDK) are imported
 * inside `execute`. No Slack SDK is pulled by any of these verbs.
 */
import { Command, Option } from "clipanion";

const SLACK = "slack";

/** Shared `--workspace <alias>` description (ADR-0014). */
const WORKSPACE_DESC =
  "Workspace alias for a multi-workspace setup (omit for the default workspace).";

/** `slack auth set` — store the Slack token in the OS keychain. */
export class SlackAuthSetCommand extends Command {
  static override paths = [[SLACK, "auth", "set"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Store the Slack token in the OS keychain (service 'suasor').",
    details: `
      Persists the token so 'slack auth test', 'slack conversations', and
      'slack sync' resolve it without it ever touching config.toml (NFR-PRV-4).
      Pass --token, or omit it to read the token from stdin (e.g. a pipe). Use
      --workspace <alias> to store a per-workspace token (ADR-0014).
    `,
    examples: [
      ["Store a token from stdin", "echo xoxb-… | suasor slack auth set"],
      ["Store a token inline", "suasor slack auth set --token xoxb-…"],
      ["Store a workspace token", "suasor slack auth set --workspace acme --token xoxb-…"],
    ],
  });

  token = Option.String("--token", { description: "Token value (omit to read from stdin)." });
  workspace = Option.String("--workspace", { description: WORKSPACE_DESC });

  override async execute(): Promise<number> {
    let token = this.token?.trim();
    if (!token) {
      token = (await readStdin(this.context.stdin)).trim();
    }
    if (!token) {
      this.context.stderr.write("error: no token provided (pass --token or pipe it on stdin)\n");
      return 1;
    }

    const [{ storeSecret }, { workspaceSecretName }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    await storeSecret(SLACK, workspaceSecretName(this.workspace), token);
    const where = this.workspace ? ` for workspace '${this.workspace}'` : "";
    this.context.stdout.write(
      `Stored Slack token${where} in the OS keychain (service 'suasor').\n`,
    );
    const verify = this.workspace ? ` --workspace ${this.workspace}` : "";
    this.context.stdout.write(`next: verify it with \`suasor slack auth test${verify}\`.\n`);
    return 0;
  }
}

/** `slack auth test` — verify the token and report granted scopes + readiness. */
export class SlackAuthTestCommand extends Command {
  static override paths = [[SLACK, "auth", "test"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Verify the Slack token and report granted scopes + per-feature readiness.",
    details: `
      Calls auth.test once: prints the resolved principal/team/user, the granted
      OAuth scopes, and a 'features:' block assessing each ingestion feature as
      READY / READY (degraded) / MISSING <scope> / N/A (ADR-0011). Readiness is a
      scope verdict only — it does not guarantee channel membership.
    `,
    examples: [
      ["Test the stored token", "suasor slack auth test"],
      ["Test a workspace's token", "suasor slack auth test --workspace acme"],
    ],
  });

  json = Option.Boolean("--json", false, { description: "Emit the result as JSON." });
  workspace = Option.String("--workspace", { description: WORKSPACE_DESC });

  override async execute(): Promise<number> {
    const [{ resolveSecret }, { workspaceSecretName }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    const token = await resolveSecret(SLACK, workspaceSecretName(this.workspace));
    if (!token) {
      const hint = this.workspace ? ` --workspace ${this.workspace}` : "";
      this.context.stderr.write(
        `error: no Slack token configured (run \`suasor slack auth set${hint}\` or set the env override)\n`,
      );
      return 1;
    }

    const [{ testToken }, { assessReadiness, renderFeaturesBlock }] = await Promise.all([
      import("../../connectors/slack/auth.ts"),
      import("../../connectors/slack/scopes.ts"),
    ]);

    let result: Awaited<ReturnType<typeof testToken>>;
    try {
      result = await testToken(token);
    } catch (cause) {
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }

    if (this.json) {
      const features = assessReadiness(result.scopes, result.principal);
      this.context.stdout.write(`${JSON.stringify({ ...result, features }, null, 2)}\n`);
      return 0;
    }

    this.context.stdout.write(
      `ok: ${result.principal} token for ${result.user} @ ${result.team} (${result.teamId})\n`,
    );
    this.context.stdout.write(`scopes: ${result.scopes || "(none reported)"}\n`);
    this.context.stdout.write("features:\n");
    for (const line of renderFeaturesBlock(result.scopes, result.principal)) {
      this.context.stdout.write(`${line}\n`);
    }
    return 0;
  }
}

/** `slack conversations` — list conversations the token can see + a config block. */
export class SlackConversationsCommand extends Command {
  static override paths = [[SLACK, "conversations"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "List conversations the token can see and print a paste-ready config block.",
    details: `
      Enumerates public/private channels + DMs + group-DMs (users.conversations),
      type by type, so a missing listing scope self-reports per type rather than
      failing the sweep (ADR-0011). Prints a [connectors.slack] block you can
      paste into config.toml, then run 'suasor slack sync'.
    `,
    examples: [
      ["List everything visible", "suasor slack conversations"],
      ["Public channels only, as JSON", "suasor slack conversations --types public --json"],
    ],
  });

  types = Option.String("--types", {
    description: "Comma-separated types: public,private,im,mpim (default: all four).",
  });
  includeArchived = Option.Boolean("--include-archived", false, {
    description: "Include archived channels (default: excluded).",
  });
  limit = Option.String("--limit", { description: "Maximum number of conversations to list." });
  json = Option.Boolean("--json", false, { description: "Emit the result as JSON." });
  workspace = Option.String("--workspace", { description: WORKSPACE_DESC });

  override async execute(): Promise<number> {
    // Validate args before any keychain / network work so bad input fails fast.
    const VALID = ["public", "private", "im", "mpim"] as const;
    type ConvType = (typeof VALID)[number];
    let types: ConvType[] | undefined;
    if (this.types !== undefined) {
      const parsed = this.types
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const bad = parsed.filter((t) => !VALID.includes(t as ConvType));
      if (bad.length > 0) {
        this.context.stderr.write(
          `error: invalid --types: ${bad.join(", ")} (valid: ${VALID.join(", ")})\n`,
        );
        return 1;
      }
      types = parsed as ConvType[];
    }

    let limit: number | undefined;
    if (this.limit !== undefined) {
      const n = Number(this.limit);
      if (!Number.isInteger(n) || n <= 0) {
        this.context.stderr.write("error: --limit must be a positive integer\n");
        return 1;
      }
      limit = n;
    }

    const [{ resolveSecret }, { workspaceSecretName }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    const token = await resolveSecret(SLACK, workspaceSecretName(this.workspace));
    if (!token) {
      const hint = this.workspace ? ` --workspace ${this.workspace}` : "";
      this.context.stderr.write(
        `error: no Slack token configured (run \`suasor slack auth set${hint}\` or set the env override)\n`,
      );
      return 1;
    }

    const [{ testToken }, { listConversations, renderConfigBlock }] = await Promise.all([
      import("../../connectors/slack/auth.ts"),
      import("../../connectors/slack/conversations.ts"),
    ]);

    try {
      // One auth.test resolves the team id for the config block (and validates the token).
      const { teamId } = await testToken(token);
      const result = await listConversations(token, {
        ...(types ? { types } : {}),
        ...(limit !== undefined ? { limit } : {}),
        includeArchived: this.includeArchived,
      });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify({ teamId, ...result }, null, 2)}\n`);
        return 0;
      }

      this.context.stdout.write(
        `${result.conversations.length} conversation(s) visible to this token:\n`,
      );
      for (const c of result.conversations) {
        const archived = c.isArchived ? " (archived)" : "";
        this.context.stdout.write(`  ${c.id}  ${c.displayName}${archived}\n`);
      }
      for (const [type, scope] of Object.entries(result.missingScopes)) {
        this.context.stderr.write(`warning: ${type} not listed — missing scope ${scope}\n`);
      }
      this.context.stdout.write("\n");
      for (const line of renderConfigBlock(teamId, result)) {
        this.context.stdout.write(`${line}\n`);
      }
      this.context.stderr.write(
        "next: paste the block above into config.toml, then run `suasor slack sync`.\n",
      );
      return 0;
    } catch (cause) {
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }
  }
}

/** Read all of stdin to a string (used when `--token` is omitted). */
async function readStdin(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}
