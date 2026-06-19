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
  sort = Option.String("--sort", {
    description: "Sort order: last_self_post (engagement; User Token only, ADR-0013).",
  });

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

    if (this.sort !== undefined && this.sort !== "last_self_post") {
      this.context.stderr.write(`error: invalid --sort: ${this.sort} (valid: last_self_post)\n`);
      return 1;
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
      // One auth.test resolves the team id for the config block + the principal
      // (engagement sort is User Token only — ADR-0013).
      const { teamId, principal } = await testToken(token);
      const result = await listConversations(token, {
        ...(types ? { types } : {}),
        ...(limit !== undefined ? { limit } : {}),
        includeArchived: this.includeArchived,
      });

      // Engagement axis (--sort=last_self_post): resolve each conversation's
      // last self-post ts via search.messages and sort by it. Requires a User
      // Token; a Bot Token degrades to N/A and the default order (ADR-0013).
      let lastSelfPost: Map<string, string> | null = null;
      let conversations = result.conversations;
      if (this.sort === "last_self_post") {
        if (principal !== "user") {
          this.context.stderr.write(
            "warning: --sort=last_self_post is N/A (User Token only) — listing in default order\n",
          );
        } else {
          const { searchLastSelfPost, sortByLastSelfPost } = await import(
            "../../connectors/slack/search.ts"
          );
          lastSelfPost = await searchLastSelfPost(token);
          conversations = sortByLastSelfPost(conversations, lastSelfPost);
          this.context.stderr.write(
            "note: last_self_post reflects Slack's search index, which lags real time (approximate)\n",
          );
        }
      }

      if (this.json) {
        const withEngagement = lastSelfPost
          ? conversations.map((c) => ({ ...c, lastSelfPost: lastSelfPost?.get(c.id) ?? null }))
          : conversations;
        this.context.stdout.write(
          `${JSON.stringify({ teamId, conversations: withEngagement, missingScopes: result.missingScopes }, null, 2)}\n`,
        );
        return 0;
      }

      this.context.stdout.write(`${conversations.length} conversation(s) visible to this token:\n`);
      for (const c of conversations) {
        const archived = c.isArchived ? " (archived)" : "";
        const engagement = lastSelfPost ? `  last_self_post=${lastSelfPost.get(c.id) ?? "-"}` : "";
        this.context.stdout.write(`  ${c.id}  ${c.displayName}${archived}${engagement}\n`);
      }
      for (const [type, scope] of Object.entries(result.missingScopes)) {
        this.context.stderr.write(`warning: ${type} not listed — missing scope ${scope}\n`);
      }
      this.context.stdout.write("\n");
      for (const line of renderConfigBlock(teamId, {
        conversations,
        missingScopes: result.missingScopes,
      })) {
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

/** `slack status` — show the saved resume cursor (per workspace / channel). */
export class SlackStatusCommand extends Command {
  static override paths = [[SLACK, "status"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Show the saved Slack resume cursor (per workspace / channel).",
    details: `
      Prints the high-water-mark ts each channel resumes from (ADR-0016). Useful
      to confirm a 'since' floor took effect or to see what 'slack cursor reset'
      would clear. Read-only.
    `,
    examples: [["Show cursors", "suasor slack status"]],
  });

  json = Option.Boolean("--json", false, { description: "Emit the cursor map as JSON." });

  override async execute(): Promise<number> {
    const map = await readSlackCursor(this);
    if (map === null) return 1;

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(map, null, 2)}\n`);
      return 0;
    }
    const aliases = Object.keys(map);
    if (aliases.length === 0) {
      this.context.stdout.write("slack cursors: (none — never synced, or reset)\n");
      return 0;
    }
    this.context.stdout.write("slack cursors:\n");
    for (const alias of aliases) {
      this.context.stdout.write(`  [${alias}]\n`);
      for (const [channel, ts] of Object.entries(map[alias] ?? {})) {
        this.context.stdout.write(`    ${channel}  ${ts}\n`);
      }
    }
    return 0;
  }
}

/** `slack cursor reset` — clear saved cursors so channels re-fetch from the floor. */
export class SlackCursorResetCommand extends Command {
  static override paths = [[SLACK, "cursor", "reset"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Clear saved cursors so the next sync re-fetches from the 'since' floor.",
    details: `
      Recovery verb (ADR-0016): appends a new cursor with the targeted channels
      removed, so the next 'slack sync' re-fetches them from the configured
      'since' floor (or from the start when no floor is set). Pass --channel
      C1,C2 (optionally --workspace) or --all. Requires --yes to apply; without
      it the targets are previewed only.
    `,
    examples: [
      ["Preview a reset", "suasor slack cursor reset --channel C0123"],
      ["Reset two channels", "suasor slack cursor reset --channel C0123,C0456 --yes"],
      ["Reset a whole workspace", "suasor slack cursor reset --workspace acme --all --yes"],
      ["Reset everything", "suasor slack cursor reset --all --yes"],
    ],
  });

  channel = Option.String("--channel", { description: "Channel id(s) to reset, comma-separated." });
  all = Option.Boolean("--all", false, {
    description: "Reset every channel (of the workspace, or all).",
  });
  workspace = Option.String("--workspace", { description: WORKSPACE_DESC });
  yes = Option.Boolean("--yes", false, {
    description: "Apply the reset (without it, preview only).",
  });

  override async execute(): Promise<number> {
    const channels = this.channel
      ? this.channel
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      : [];
    if (!this.all && channels.length === 0) {
      this.context.stderr.write("error: pass --channel <ids> or --all\n");
      return 1;
    }

    const current = await readSlackCursor(this);
    if (current === null) return 1;

    const [{ serializeCursor }, { loadConfig }, { Store }] = await Promise.all([
      import("../../connectors/slack.ts"),
      import("../../config/index.ts"),
      import("../../db/index.ts"),
    ]);

    const alias = this.workspace ?? "default";
    const next: Record<string, Record<string, string>> = structuredClone(current);
    const targets: string[] = [];
    if (this.all && !this.workspace) {
      for (const a of Object.keys(next)) targets.push(`[${a}] (all)`);
      for (const a of Object.keys(next)) delete next[a];
    } else if (this.all) {
      if (next[alias]) targets.push(`[${alias}] (all)`);
      delete next[alias];
    } else {
      const aliasMap = next[alias] ?? {};
      for (const ch of channels) {
        if (aliasMap[ch] !== undefined) {
          targets.push(`[${alias}] ${ch}`);
          delete aliasMap[ch];
        }
      }
      next[alias] = aliasMap;
    }

    if (targets.length === 0) {
      this.context.stdout.write("nothing to reset (no matching saved cursor).\n");
      return 0;
    }

    if (!this.yes) {
      this.context.stdout.write(`would reset: ${targets.join(", ")}\n`);
      this.context.stdout.write("(preview — re-run with --yes to apply)\n");
      return 0;
    }

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }
    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      store.record({
        type: "ConnectorSyncCompleted",
        connector: SLACK,
        cursor: serializeCursor(next),
        count: 0,
      });
    } finally {
      store.close();
    }
    this.context.stdout.write(`reset: ${targets.join(", ")}\n`);
    this.context.stdout.write("next: run `suasor slack sync` to re-fetch from the floor.\n");
    return 0;
  }
}

/** `slack cursor backfill` — lower a channel's cursor to re-fetch older history. */
export class SlackCursorBackfillCommand extends Command {
  static override paths = [[SLACK, "cursor", "backfill"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Lower a channel's cursor to a past floor so the next sync re-fetches it.",
    details: `
      Recovery verb (ADR-0016 / #57): sets the channel's saved cursor to the
      '--since' floor (older than its current position), so the next 'slack
      sync' re-fetches the gap. Unlike 'cursor reset' (which clears to the
      configured floor), this targets an explicit, possibly older floor.
      Requires --yes to apply; without it the change is previewed only.
    `,
    examples: [
      ["Preview a 180-day backfill", "suasor slack cursor backfill --channel C0123 --since 180d"],
      ["Apply it", "suasor slack cursor backfill --channel C0123 --since 2026-01-01 --yes"],
    ],
  });

  channel = Option.String("--channel", { description: "Channel id to backfill." });
  since = Option.String("--since", { description: "Floor to lower to (30d / 4w / 2026-01-01)." });
  workspace = Option.String("--workspace", { description: WORKSPACE_DESC });
  yes = Option.Boolean("--yes", false, {
    description: "Apply the backfill (without it, preview only).",
  });

  override async execute(): Promise<number> {
    if (!this.channel || !this.since) {
      this.context.stderr.write("error: --channel <id> and --since <floor> are both required\n");
      return 1;
    }

    const { parseSinceToTs, serializeCursor } = await import("../../connectors/slack.ts");
    const floorTs = parseSinceToTs(this.since, Date.now());
    if (floorTs === null) {
      this.context.stderr.write(
        `error: invalid --since: ${this.since} (use 30d / 4w / 2026-01-01)\n`,
      );
      return 1;
    }

    const current = await readSlackCursor(this);
    if (current === null) return 1;

    const alias = this.workspace ?? "default";
    const next: Record<string, Record<string, string>> = structuredClone(current);
    const aliasMap = next[alias] ?? {};
    const before = aliasMap[this.channel];
    aliasMap[this.channel] = floorTs;
    next[alias] = aliasMap;

    const summary = `[${alias}] ${this.channel}: ${before ?? "(none)"} → ${floorTs}`;
    if (!this.yes) {
      this.context.stdout.write(`would backfill: ${summary}\n`);
      this.context.stdout.write("(preview — re-run with --yes to apply)\n");
      return 0;
    }

    const [{ loadConfig }, { Store }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
    ]);
    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }
    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      store.record({
        type: "ConnectorSyncCompleted",
        connector: SLACK,
        cursor: serializeCursor(next),
        count: 0,
      });
    } finally {
      store.close();
    }
    this.context.stdout.write(`backfilled: ${summary}\n`);
    this.context.stdout.write("next: run `suasor slack sync` to re-fetch the older window.\n");
    return 0;
  }
}

/**
 * Load the saved Slack cursor as an alias → channel → ts map, or `null` on a
 * config error (after writing the error to stderr). Shared by `slack status`,
 * `slack cursor reset`, and `slack cursor backfill`.
 */
async function readSlackCursor(
  cmd: Command,
): Promise<Record<string, Record<string, string>> | null> {
  const [{ loadConfig }, { Store }, { lastCursor }, { cursorToAliasMap }] = await Promise.all([
    import("../../config/index.ts"),
    import("../../db/index.ts"),
    import("../../connectors/sync.ts"),
    import("../../connectors/slack.ts"),
  ]);
  const config = await loadConfig();
  const dbPath = config.storage.dbPath;
  if (dbPath === null) {
    cmd.context.stderr.write("error: storage.dbPath is not configured\n");
    return null;
  }
  const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
  try {
    return cursorToAliasMap(lastCursor(store.connection.sqlite, SLACK));
  } finally {
    store.close();
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
