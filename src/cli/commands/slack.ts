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
// Type-only imports are erased at compile time, so they add no runtime require
// and keep the lazy-import discipline (NFR-PRF-1) intact.
import type {
  ConversationsResult,
  SlackConversation,
} from "../../connectors/slack/conversations.ts";

const SLACK = "slack";

/** Shared `--workspace <alias>` description (ADR-0014). */
const WORKSPACE_DESC =
  "Workspace alias for a multi-workspace setup (omit for the default workspace).";

/**
 * Render one `slack conversations` table row (pure, so it is unit-testable
 * without the network seam). `isMember` drives the leading join mark: `✓` for a
 * reachable (joined) conversation, a blank cell otherwise — an unjoined channel
 * returns `not_in_channel` and ingests nothing until the bot joins (ADR-0011,
 * #165). `engagement` is the already-formatted `last_self_post=…` suffix (or "").
 */
export function formatConversationRow(
  conv: { id: string; displayName: string; isArchived: boolean; isMember: boolean },
  engagement = "",
): string {
  const joined = conv.isMember ? "✓" : " ";
  const archived = conv.isArchived ? " (archived)" : "";
  return `  ${joined}       ${conv.id}  ${conv.displayName}${archived}${engagement}`;
}

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

      On Enterprise Grid, an org-level (org-wide app) token auto-enumerates every
      workspace it is approved for (auth.teams.list) and lists channels across all
      of them, grouped per workspace with a paste-ready multi-workspace block
      (Issue #350). Pass --team-id <T…> to scope to a single workspace. A
      workspace-level token cannot span the grid: it lists its own workspace and,
      if --team-id is given, warns (Slack ignores it) — use a per-workspace token
      each via --workspace <alias> instead (ADR-0014).

      A channel shared across several Grid workspaces (one global channel id) is
      listed once — under its owner (the lexicographically smallest alias) — and
      marked "shared across [<aliases>]"; --json adds a per-row sharedAcross array.
      In the config block it is a real channels entry only under its owner and a
      "# <id> shared, owned by <alias>" comment elsewhere, so pasting the whole
      block ingests it exactly once (ADR-0038).
    `,
    examples: [
      ["List everything visible", "suasor slack conversations"],
      ["Public channels only, as JSON", "suasor slack conversations --types public --json"],
      ["Scope to one Grid workspace", "suasor slack conversations --team-id T0123ABC"],
    ],
  });

  types = Option.String("--types", {
    description: "Comma-separated types: public,private,im,mpim (default: all four).",
  });
  includeArchived = Option.Boolean("--include-archived", false, {
    description: "Include archived channels (default: excluded).",
  });
  limit = Option.String("--limit", { description: "Maximum number of conversations to list." });
  teamId = Option.String("--team-id", {
    description:
      "Enterprise Grid workspace (team) id to scope the listing to (org-level token only, #350).",
  });
  json = Option.Boolean("--json", false, { description: "Emit the result as JSON." });
  workspace = Option.String("--workspace", { description: WORKSPACE_DESC });
  sort = Option.String("--sort", {
    description: "Sort order: last_self_post (engagement; User Token only, ADR-0013).",
  });
  noProgress = Option.Boolean("--no-progress", false, {
    description: "Disable the progress indicator (auto-off when stderr is not a TTY).",
  });

  /** Clock for the relative-time column; overridden in tests for determinism. */
  protected now: () => number = () => Date.now();

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

    const [
      { testToken },
      { listConversations, renderConfigBlock, renderWorkspacesConfigBlock },
      { listTeams, workspaceAliases },
      { channelOwnership },
      { createProgress },
    ] = await Promise.all([
      import("../../connectors/slack/auth.ts"),
      import("../../connectors/slack/conversations.ts"),
      import("../../connectors/slack/teams.ts"),
      import("../../connectors/slack/dedup.ts"),
      import("../progress.ts"),
    ]);

    // Indeterminate progress on stderr while DM name resolution + search paging
    // run, so a multi-second sweep is not silent (#84; same pattern as
    // connector-sync, ADR-0026). TTY-gated and suppressed by --no-progress, so
    // --json / piped output stays clean and CLI tests assert on stdout unchanged.
    const progress = createProgress(
      this.context.stderr,
      "slack conversations",
      this.noProgress ? false : undefined,
    );

    try {
      // One auth.test resolves the team id for the config block + the principal
      // (engagement sort is User Token only — ADR-0013).
      const { teamId, principal, isEnterpriseInstall } = await testToken(token);
      // --team-id only scopes the sweep on an org-level (org-wide app) token;
      // Slack silently ignores it for a workspace-level token, so passing it
      // there would tag rows with a workspace Slack never honoured (Issue #350).
      // Only scope when the token can honour it; warn (below) otherwise.
      const scopeTeamId = this.teamId && isEnterpriseInstall ? this.teamId : undefined;

      // Enterprise Grid auto-enumeration (#350): an org-level token with no
      // explicit --team-id sweeps every workspace the org-wide app is approved
      // for (auth.teams.list), not just its default one. Enumeration is
      // best-effort — a non-Grid token, a missing scope, or a single workspace
      // falls back to the current single sweep (teams.length <= 1).
      const teams =
        isEnterpriseInstall && !this.teamId
          ? await listTeams(token, { onProgress: () => progress.tick() })
          : [];
      const multi = teams.length > 1;
      const aliasByTeam = multi ? workspaceAliases(teams) : new Map<string, string>();

      let result: ConversationsResult;
      if (multi) {
        // Sweep each workspace and merge; every row is tagged with its team so
        // the listing + config block can group by workspace. Missing listing
        // scopes are unioned across workspaces (one warning per type).
        const merged: SlackConversation[] = [];
        const missingScopes: Record<string, string> = {};
        for (const team of teams) {
          const r = await listConversations(token, {
            ...(types ? { types } : {}),
            teamId: team.id,
            includeArchived: this.includeArchived,
            onProgress: () => progress.tick(),
          });
          merged.push(...r.conversations);
          for (const [type, scope] of Object.entries(r.missingScopes)) missingScopes[type] = scope;
        }
        // --limit caps the merged total across workspaces (parity with the
        // single-sweep limit, which caps the output not the fetch).
        const capped = limit !== undefined ? merged.slice(0, limit) : merged;
        result = { conversations: capped, missingScopes };
      } else {
        result = await listConversations(token, {
          ...(types ? { types } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(scopeTeamId ? { teamId: scopeTeamId } : {}),
          includeArchived: this.includeArchived,
          onProgress: () => progress.tick(),
        });
      }

      // Engagement axis (--sort=last_self_post): resolve each conversation's
      // last self-post ts via search.messages and sort by it. Requires a User
      // Token; a Bot Token degrades to N/A and the default order (ADR-0013).
      let lastSelfPost: Map<string, string> | null = null;
      let conversations = result.conversations;
      if (this.sort === "last_self_post") {
        if (principal !== "user") {
          progress.finish();
          this.context.stderr.write(
            "warning: --sort=last_self_post is N/A (User Token only) — listing in default order\n",
          );
        } else {
          const { searchLastSelfPost, sortByLastSelfPost } = await import(
            "../../connectors/slack/search.ts"
          );
          lastSelfPost = await searchLastSelfPost(token, { onProgress: () => progress.tick() });
          conversations = sortByLastSelfPost(conversations, lastSelfPost);
          progress.finish();
          this.context.stderr.write(
            "note: last_self_post reflects Slack's search index, which lags real time (approximate)\n",
          );
        }
      }
      progress.finish();

      // Shared-channel de-dup / marking for the discovery listing (ADR-0038
      // Layer 2). On a multi-workspace sweep the same global channel id can be
      // listed under several workspaces; compute the deterministic owner (the
      // lexicographically smallest alias, the same rule sync uses) so the listing
      // shows each shared channel once (under its owner) and marks which aliases
      // it spans. Single-workspace / --team-id sweeps have no cross-workspace
      // duplication, so `displayed` stays the raw `conversations` there.
      const aliasOfRow = (c: SlackConversation): string =>
        (c.teamId && aliasByTeam.get(c.teamId)) || c.teamId || "";
      const ownership = multi
        ? channelOwnership(
            teams.map((t) => ({
              alias: aliasByTeam.get(t.id) ?? t.id,
              channels: conversations.filter((c) => c.teamId === t.id).map((c) => c.id),
            })),
          )
        : null;
      // channel id → the aliases it is shared across (ascending), only for the
      // ≥2-alias channels; drives the `sharedAcross` JSON field + text note.
      const sharedAliases = new Map<string, string[]>(
        ownership?.shared.map((s) => [s.channel, s.aliases]) ?? [],
      );
      // The de-duplicated listing: keep one row per channel id — the owner's.
      // A non-shared channel's owner is its sole alias, so its row is always
      // kept; a shared channel keeps only the owner alias's row (the others are
      // dropped from the listing but still surface as owner-comments in the
      // per-workspace config block below).
      const displayed = ownership
        ? conversations.filter((c) => ownership.owner.get(c.id) === aliasOfRow(c))
        : conversations;

      // --team-id is honoured by Slack only for org-level (org-wide app) tokens;
      // a workspace-level token silently ignores it and lists its own workspace
      // instead. Warn before the --json branch so both output modes surface the
      // mismatch (Issue #350): to reach other Enterprise Grid workspaces, add a
      // per-workspace token via `slack auth set --workspace <alias>` (ADR-0014).
      if (this.teamId && !isEnterpriseInstall) {
        this.context.stderr.write(
          `warning: --team-id is ignored for a workspace-level token (Slack honours it only for ` +
            `org-level/org-wide-app tokens); listed this token's own workspace instead. To reach ` +
            `other Enterprise Grid workspaces, add a per-workspace token with ` +
            "`suasor slack auth set --workspace <alias>` (ADR-0014).\n",
        );
      }

      if (this.json) {
        // Additive, back-compatible per-row fields: `lastSelfPost` (engagement
        // sort) and `sharedAcross` (the aliases a shared channel spans, ADR-0038
        // Layer 2). Both are omitted when absent so the single-workspace,
        // non-shared shape is byte-for-byte unchanged for existing consumers.
        const withEngagement = displayed.map((c) => {
          const sharedAcross = sharedAliases.get(c.id);
          if (!lastSelfPost && !sharedAcross) return c;
          return {
            ...c,
            ...(lastSelfPost ? { lastSelfPost: lastSelfPost.get(c.id) ?? null } : {}),
            ...(sharedAcross ? { sharedAcross } : {}),
          };
        });
        // Multi-workspace sweeps add a `workspaces` grouping (each conversation
        // already carries its `teamId`); the single-workspace shape is unchanged
        // for back-compat (Issue #350).
        const workspaces = multi
          ? teams.map((t) => ({ id: t.id, name: t.name, alias: aliasByTeam.get(t.id) }))
          : undefined;
        this.context.stdout.write(
          `${JSON.stringify(
            {
              teamId,
              conversations: withEngagement,
              missingScopes: result.missingScopes,
              ...(workspaces ? { workspaces } : {}),
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }

      // Humanize the engagement ts for the table (the --json path above keeps
      // the raw ts); "-" stays when there is no recorded self-post (#84).
      const { formatSlackTs } = await import("../slack-time.ts");
      this.context.stdout.write(
        multi
          ? `${displayed.length} conversation(s) across ${teams.length} workspace(s):\n`
          : `${displayed.length} conversation(s) visible to this token:\n`,
      );
      // Label the columns Joined / ID / Name so it is unambiguous that the second
      // column is the value to copy into `channels` (config wants ids, not names —
      // Issue #158) and that the leading mark is reachability. The header is
      // omitted when there is nothing to label.
      if (displayed.length > 0) {
        this.context.stdout.write("  Joined  ID / Name\n");
      }
      // `✓` = the token's principal is a member (reachable by sync); a blank cell
      // means not joined → that channel returns `not_in_channel` and ingests
      // nothing until the bot joins / is /invite'd (ADR-0011). See
      // formatConversationRow for the row layout.
      for (const c of displayed) {
        let engagement = "";
        if (lastSelfPost) {
          const ts = lastSelfPost.get(c.id);
          engagement = `  last_self_post=${ts ? formatSlackTs(ts, this.now) : "-"}`;
        }
        // In a multi-workspace sweep, label each row with its workspace alias so
        // it is clear which Grid workspace a channel belongs to (Issue #350).
        const wsLabel = multi && c.teamId ? `  [${aliasByTeam.get(c.teamId) ?? c.teamId}]` : "";
        // A shared channel is listed once (under its owner); mark the aliases it
        // spans so the operator sees it is Grid-shared, not duplicated (ADR-0038).
        const sharedAcross = sharedAliases.get(c.id);
        const sharedNote = sharedAcross ? `  (shared across [${sharedAcross.join(", ")}])` : "";
        this.context.stdout.write(
          `${formatConversationRow(c, `${wsLabel}${engagement}${sharedNote}`)}\n`,
        );
      }
      // Explain the mark only when at least one channel is unjoined, so the common
      // all-joined case stays terse.
      if (displayed.some((c) => !c.isMember)) {
        this.context.stderr.write(
          "note: channels without a ✓ are not joined — they return `not_in_channel` and ingest nothing until the bot joins / is /invite'd (ADR-0011)\n",
        );
      }
      for (const [type, scope] of Object.entries(result.missingScopes)) {
        this.context.stderr.write(`warning: ${type} not listed — missing scope ${scope}\n`);
      }
      this.context.stdout.write("\n");
      // A multi-workspace sweep renders per-workspace sub-sections so each id
      // keeps its own `team` prefix at sync time; a single sweep keeps the flat
      // block (Issue #350 / ADR-0014).
      const configLines = multi
        ? renderWorkspacesConfigBlock(
            teams.map((t) => ({
              teamId: t.id,
              alias: aliasByTeam.get(t.id) ?? t.id,
              conversations: conversations.filter((c) => c.teamId === t.id),
            })),
          )
        : renderConfigBlock(teamId, { conversations, missingScopes: result.missingScopes });
      for (const line of configLines) {
        this.context.stdout.write(`${line}\n`);
      }
      this.context.stderr.write(
        "next: paste the block above into config.toml, then run `suasor slack sync`.\n",
      );
      return 0;
    } catch (cause) {
      progress.finish();
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

  /** Clock for the relative-time column; overridden in tests for determinism. */
  protected now: () => number = () => Date.now();

  override async execute(): Promise<number> {
    const map = await readSlackCursor(this);
    if (map === null) return 1;

    // Join the local `slack_channels` projection so id-only cursors carry a
    // human name (ADR-0037 §1). Local lookup only — no live fetch. Empty until a
    // sync has resolved names, in which case every channel stays id-only (§6).
    const channelNames = await readSlackChannelNames();

    if (this.json) {
      // Additive back-compat: the top-level object stays the alias → channel →
      // ts cursor map (existing consumers read `parsed[alias][channel]`
      // unchanged). Resolved names are surfaced under a sibling `names` map
      // (channel id → resolved name), only when at least one resolved — so the
      // no-projection case emits the exact prior shape (ADR-0037 §1/§6).
      const names = Object.fromEntries([...channelNames].map(([id, { name }]) => [id, name]));
      const payload = Object.keys(names).length > 0 ? { ...map, names } : map;
      this.context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    const aliases = Object.keys(map);
    if (aliases.length === 0) {
      this.context.stdout.write("slack cursors: (none — never synced, or reset)\n");
      return 0;
    }
    // Humanize the resume ts so an operator can read "what was synced until
    // when" at a glance; the --json path above keeps the raw ts (#84). `now` is
    // injectable so the relative phrasing is deterministic under test.
    const { formatSlackTs } = await import("../slack-time.ts");
    this.context.stdout.write("slack cursors:\n");
    for (const alias of aliases) {
      this.context.stdout.write(`  [${alias}]\n`);
      for (const [channel, ts] of Object.entries(map[alias] ?? {})) {
        const rec = channelNames.get(channel);
        const label = rec ? `  ${slackChannelLabel(rec.name, rec.kind)}` : "";
        this.context.stdout.write(`    ${channel}${label}  ${formatSlackTs(ts, this.now)}\n`);
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

    // Local channel-name join so a previewed / reset channel shows its name
    // (`[alias] C0123 #general`) beside the id (ADR-0037 §1). No live fetch.
    const channelNames = await readSlackChannelNames();

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
          const rec = channelNames.get(ch);
          const label = rec ? ` ${slackChannelLabel(rec.name, rec.kind)}` : "";
          targets.push(`[${alias}] ${ch}${label}`);
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

    // Local channel-name join so the backfill summary names the target channel
    // (`[alias] C0123 #general: … → …`) beside the id (ADR-0037 §1). No live fetch.
    const channelNames = await readSlackChannelNames();

    const alias = this.workspace ?? "default";
    const next: Record<string, Record<string, string>> = structuredClone(current);
    const aliasMap = next[alias] ?? {};
    const before = aliasMap[this.channel];
    // Backfill goes OLDER. If the floor is not older than the current cursor it
    // would *advance* it and skip unfetched messages — warn (footgun guard).
    if (before !== undefined && Number.parseFloat(floorTs) >= Number.parseFloat(before)) {
      this.context.stderr.write(
        `warning: --since (${floorTs}) is not older than the current cursor (${before}); ` +
          "this advances the cursor and would skip unfetched messages\n",
      );
    }
    aliasMap[this.channel] = floorTs;
    next[alias] = aliasMap;

    const rec = channelNames.get(this.channel);
    const label = rec ? ` ${slackChannelLabel(rec.name, rec.kind)}` : "";
    const summary = `[${alias}] ${this.channel}${label}: ${before ?? "(none)"} → ${floorTs}`;
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
 * `slack resolve-names` — backfill human names for already-ingested Slack
 * sources (ADR-0037 §11/§12). Forward sync only enriches messages it newly
 * ingests, so ids ingested before name resolution existed stay `C…`/`U…`-only.
 * This verb walks the local `slack_message` sources, and re-resolves the channel
 * / user ids whose name is still missing via the same resolvers the sync path
 * uses — appending `SlackChannelObserved` / `PersonIdentityObserved` so the
 * projections enrich last-write-wins. Read-of-Slack only (ADR-0003); no egress.
 */
export class SlackResolveNamesCommand extends Command {
  static override paths = [[SLACK, "resolve-names"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Backfill human names for already-ingested Slack channels / users (ADR-0037).",
    details: `
      Forward 'slack sync' only names messages it newly ingests; sources ingested
      before name resolution existed stay id-only (C…/U…). This verb scans the
      local slack_message sources, collects the distinct channel + user ids per
      workspace, and re-resolves the ones whose name is still missing via
      users.info / conversations.info — the same path sync uses — enriching the
      slack_channels + person projections (ADR-0037 §11). Idempotent: already-named
      ids are skipped (pass --force to re-resolve). A scope-less / erroring id is
      degraded (counted, id fallback kept) so it never aborts the pass (§6).
    `,
    examples: [
      ["Backfill every workspace", "suasor slack resolve-names"],
      ["Backfill one workspace", "suasor slack resolve-names --workspace acme"],
      ["Re-resolve even named ids", "suasor slack resolve-names --force"],
    ],
  });

  workspace = Option.String("--workspace", { description: WORKSPACE_DESC });
  force = Option.Boolean("--force", false, {
    description: "Re-resolve ids that already carry a resolved name (default: skip them).",
  });
  json = Option.Boolean("--json", false, { description: "Emit the summary as JSON." });
  noProgress = Option.Boolean("--no-progress", false, {
    description: "Disable the progress indicator (auto-off when stderr is not a TTY).",
  });

  override async execute(): Promise<number> {
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

    const [
      { backfillSlackNames },
      { SlackConnectorConfig, defaultSlackClientFactory },
      { defaultUsersTransport },
      { makeSecretResolver },
      { createProgress },
    ] = await Promise.all([
      import("../../connectors/slack/backfill.ts"),
      import("../../connectors/slack.ts"),
      import("../../connectors/slack/resolve.ts"),
      import("../../connectors/secrets.ts"),
      import("../progress.ts"),
    ]);

    let slackConfig: ReturnType<typeof SlackConnectorConfig.parse>;
    try {
      slackConfig = SlackConnectorConfig.parse(config.connectors[SLACK] ?? {});
    } catch (cause) {
      this.context.stderr.write(
        `error: invalid Slack connector config: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }

    // TTY-gated progress on stderr while resolution round-trips run, so a
    // multi-second sweep is not silent; suppressed by --no-progress / --json.
    const progress = createProgress(
      this.context.stderr,
      "slack resolve-names",
      this.noProgress ? false : undefined,
    );

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    let summary: Awaited<ReturnType<typeof backfillSlackNames>>;
    try {
      summary = await backfillSlackNames(
        store,
        slackConfig,
        {
          clientFactory: defaultSlackClientFactory,
          usersTransport: defaultUsersTransport,
          secret: makeSecretResolver(SLACK),
        },
        {
          ...(this.workspace ? { workspace: this.workspace } : {}),
          force: this.force,
          onProgress: () => progress.tick(),
        },
      );
    } catch (cause) {
      progress.finish();
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    } finally {
      store.close();
    }
    progress.finish();

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }

    const { channels, users, teams } = summary;
    this.context.stdout.write(
      `channels: ${channels.resolved} resolved, ${channels.skipped} already named, ` +
        `${channels.degraded} unresolved (scope/API)\n`,
    );
    this.context.stdout.write(
      `users:    ${users.resolved} resolved, ${users.skipped} already named, ` +
        `${users.degraded} unresolved (scope/API)\n`,
    );
    this.context.stdout.write(
      `teams:    ${teams.resolved} resolved, ${teams.skipped} already named, ` +
        `${teams.degraded} unresolved (scope/API)\n`,
    );
    if (summary.tokenlessWorkspaces.length > 0) {
      this.context.stderr.write(
        `warning: skipped workspace(s) with no token: ${summary.tokenlessWorkspaces.join(", ")} ` +
          "(run `suasor slack auth set [--workspace <alias>]`)\n",
      );
    }
    if (summary.orphanTeamIds > 0) {
      this.context.stderr.write(
        `note: ${summary.orphanTeamIds} id(s) belong to a team no configured workspace claims — ` +
          "left id-only (add the workspace to config to resolve them)\n",
      );
    }
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

/** A resolved Slack channel name + kind, as stored in the `slack_channels` projection. */
interface SlackChannelName {
  name: string;
  kind: string;
}

/**
 * Format a resolved channel name into a display label by its kind (ADR-0037):
 * `#name` for a public/private channel, `@name` for a single DM (the
 * counterpart), and the name as-is for a group DM (already a participant-name
 * join, §4). Exported so the row layout is unit-testable without a store.
 */
export function slackChannelLabel(name: string, kind: string): string {
  if (kind === "dm") return `@${name}`;
  if (kind === "group") return name;
  return `#${name}`;
}

/**
 * Load the Slack channel-name projection (ADR-0037 §3) as a channel-id → name
 * map, for enriching id-only operational output (`slack status` / `cursor`).
 * This is a pure local join over `slack_channels` — no live fetch
 * (no-fetch-at-query, ADR-0012/§1). Only rows with a resolved (non-empty) name
 * are included; an unresolved / absent channel is simply missing from the map,
 * so callers fall back to the raw id (§6). Returns an empty map on a config
 * error (display still renders ids). Shared by `slack status`, `slack cursor
 * reset`, and `slack cursor backfill`.
 */
async function readSlackChannelNames(): Promise<Map<string, SlackChannelName>> {
  const [{ loadConfig }, { Store }] = await Promise.all([
    import("../../config/index.ts"),
    import("../../db/index.ts"),
  ]);
  const config = await loadConfig();
  const dbPath = config.storage.dbPath;
  if (dbPath === null) return new Map();
  const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
  try {
    const rows = store.connection.sqlite
      .query("SELECT channel_id AS id, name, kind FROM slack_channels WHERE name <> ''")
      .all() as { id: string; name: string; kind: string }[];
    return new Map(rows.map((r) => [r.id, { name: r.name, kind: r.kind }]));
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
