/**
 * Slack operational verbs (ADR-0011): `slack auth set` · `slack auth test` ·
 * `slack conversations`. These are operational commands, not ingest — they are
 * Slack-specific (the generic connector contract stays `sync`-only, ADR-0007)
 * and exist to close the onboarding gap: store a token, verify its scopes, and
 * discover conversation ids without hand-hunting them.
 *
 * Lazy-import discipline (NFR-PRF-1): top-level imports are clipanion + the
 * import-clean secret-entry helper (`../read-secret.ts`, no SDK) only. The
 * keychain (`../../connectors/secrets.ts`, which lazy-loads the native keyring)
 * and the Slack leaf modules (which use the global `fetch`, no SDK) are imported
 * inside `execute`. No Slack SDK is pulled by any of these verbs.
 */
import { Command, Option } from "clipanion";
// Type-only imports are erased at compile time, so they add no runtime require
// and keep the lazy-import discipline (NFR-PRF-1) intact.
import type { KeychainBackend } from "../../connectors/secrets.ts";
import type {
  ConversationsResult,
  ConversationType,
  SlackConversation,
} from "../../connectors/slack/conversations.ts";
import { isInteractiveStdin, readSecretLine } from "../read-secret.ts";

const SLACK = "slack";

/** Shared `--workspace <alias>` description (ADR-0014). */
const WORKSPACE_DESC =
  "Workspace alias for a multi-workspace setup (omit to auto-select when unambiguous).";

/**
 * Alias of the flat / single-workspace (`[connectors.slack]`) config shape. Local
 * mirror of `DEFAULT_WORKSPACE_ALIAS` in `../../connectors/slack.ts` so the pure
 * {@link chooseWorkspaceAlias} helper stays import-clean (NFR-PRF-1, no runtime
 * require of the connector module just to read a constant).
 */
const DEFAULT_WORKSPACE_ALIAS = "default";

/**
 * Decide which workspace alias an operational verb should act on, from the
 * `--workspace` flag and the configured alias set (Issue #371 theme 1, ADR-0014).
 * Pure so the resolution is unit-testable without config / keychain:
 *
 * - an explicit `--workspace` always wins (`ok`, that alias);
 * - a flat / single-workspace config (0 or 1 configured alias) auto-selects the
 *   sole alias — `undefined` for the flat shape (the `token` secret) or the one
 *   named alias (so a named-only setup is no longer a silent no-op / wrong-secret
 *   lookup);
 * - a multi-workspace config that declares a `default` alias falls back to it;
 * - a multi-workspace config with 2+ aliases and no `default` is ambiguous
 *   (`!ok`) — the caller lists the available aliases and asks for `--workspace`
 *   instead of silently touching the wrong (or a non-existent) workspace.
 */
export function chooseWorkspaceAlias(
  explicit: string | undefined,
  configuredAliases: readonly string[],
):
  | { readonly ok: true; readonly alias: string | undefined }
  | { readonly ok: false; readonly aliases: readonly string[] } {
  if (explicit !== undefined) return { ok: true, alias: explicit };
  if (configuredAliases.length <= 1) return { ok: true, alias: configuredAliases[0] };
  if (configuredAliases.includes(DEFAULT_WORKSPACE_ALIAS)) {
    return { ok: true, alias: DEFAULT_WORKSPACE_ALIAS };
  }
  return { ok: false, aliases: configuredAliases };
}

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
      // On a TTY prompt to stderr (stdout stays machine-readable over a pipe).
      // The read is line-based and echo-suppressed (Issue #383).
      if (isInteractiveStdin(this.context.stdin)) {
        this.context.stderr.write("Paste the Slack token and press Enter (input is not echoed):\n");
      }
      token = (
        await readSecretLine(this.context.stdin, this.context.stderr, { mask: true })
      ).trim();
    }
    if (!token) {
      this.context.stderr.write("error: no token provided (pass --token or pipe it on stdin)\n");
      return 1;
    }

    // Resolve which workspace to store under (Issue #371 theme 1): an explicit
    // --workspace wins; otherwise a single-workspace config auto-selects, and a
    // multi-workspace config with no `default` errors rather than silently
    // storing under the wrong (flat `token`) secret.
    const resolved = await resolveWorkspaceAlias(this.workspace);
    if (!resolved.ok) {
      this.context.stderr.write(workspaceAmbiguityError(resolved.aliases));
      return 1;
    }
    const alias = resolved.alias;

    const keychain = (this.context as { keychain?: KeychainBackend }).keychain;
    const [{ storeSecret }, { workspaceSecretName }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    await storeSecret(SLACK, workspaceSecretName(alias), token, keychain ? { keychain } : {});
    const where = alias ? ` for workspace '${alias}'` : "";
    this.context.stdout.write(
      `Stored Slack token${where} in the OS keychain (service 'suasor').\n`,
    );
    const verify = alias ? ` --workspace ${alias}` : "";
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
    const resolved = await resolveWorkspaceAlias(this.workspace);
    if (!resolved.ok) {
      this.context.stderr.write(workspaceAmbiguityError(resolved.aliases));
      return 1;
    }
    const alias = resolved.alias;

    const [{ resolveSecret }, { workspaceSecretName }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    const token = await resolveSecret(SLACK, workspaceSecretName(alias));
    if (!token) {
      this.context.stderr.write(await noTokenError(alias));
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
    // Surface the resolved user id (Issue #371 theme 2): it is the value the
    // operator copies into `self_user_id` so `slack.demand.list` can detect their
    // own @mentions. Without it, demand silently degrades to DM-only (ADR-0012).
    const section = alias ? `[connectors.slack.workspaces.${alias}]` : "[connectors.slack]";
    this.context.stdout.write(`user_id: ${result.userId}\n`);
    this.context.stdout.write(
      `note: add \`self_user_id = "${result.userId}"\` under ${section} so slack.demand.list ` +
        "detects your @mentions — without it, demand degrades to DM-only (ADR-0012).\n",
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

      Pass --new to show only the config *drift* (ADR-0039): the conversations you
      are a member of but have not listed in config (paste-ready), plus a warning
      for configured channels the token can no longer reach (left/archived/
      renamed). This avoids hunting a long full listing for what changed. --new
      defaults its sweep to public+private (DMs/group-DMs are noise); pass --types
      to widen it. --new --json emits { new: [...], removed: [...] } — the plain
      (full-listing) --json shape is unchanged. --new resolves a single workspace
      (--workspace); Enterprise Grid auto-enumeration is skipped.
    `,
    examples: [
      ["List everything visible", "suasor slack conversations"],
      ["Public channels only, as JSON", "suasor slack conversations --types public --json"],
      ["Scope to one Grid workspace", "suasor slack conversations --team-id T0123ABC"],
      ["Show only newly-joined conversations", "suasor slack conversations --new"],
    ],
  });

  new = Option.Boolean("--new", false, {
    description:
      "Show only config drift: member conversations not yet in config (paste-ready) + unreachable configured channels (ADR-0039).",
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

    const resolved = await resolveWorkspaceAlias(this.workspace);
    if (!resolved.ok) {
      this.context.stderr.write(workspaceAmbiguityError(resolved.aliases));
      return 1;
    }
    const alias = resolved.alias;

    const [{ resolveSecret }, { workspaceSecretName }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    const token = await resolveSecret(SLACK, workspaceSecretName(alias));
    if (!token) {
      this.context.stderr.write(await noTokenError(alias));
      return 1;
    }

    // --new shows only the config drift (ADR-0039) and is scoped to a single
    // workspace, so it takes a dedicated, simpler path (no Grid auto-enumeration,
    // no engagement sort). Everything above (arg validation, workspace + token
    // resolution) is shared.
    if (this.new) return this.executeNew(alias, token, types, limit);

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
      // A multi-workspace sweep pastes a `[connectors.slack.workspaces.<alias>]`
      // block, and each workspace needs its own token — flag the format + the
      // per-workspace token导线 so the operator does not paste a multi block and
      // then hit `workspace 'X' skipped: no token` at sync time (Issue #371).
      if (multi) {
        this.context.stderr.write(
          "note: this is a multi-workspace ([connectors.slack.workspaces.<alias>]) block — " +
            "each workspace needs its own token: `suasor slack auth set --workspace <alias>` " +
            "(or the SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN env override).\n",
        );
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

  /**
   * `slack conversations --new` — surface only the config drift (ADR-0039 Layer
   * 1). Sweeps the token's visible conversations (default public+private), diffs
   * against the workspace's configured `channels`, and prints the member
   * conversations not yet configured (paste-ready: a flat `[connectors.slack]`
   * block, or a `[connectors.slack.workspaces.<alias>]` sub-section when config is
   * multi-workspace, so the fragment matches the section sync actually ingests)
   * plus a warn for configured channels the token can no longer reach. `--new
   * --json` emits `{ new, removed }`; the full-listing `--json` shape is untouched.
   * Single-workspace scoped: no Enterprise Grid auto-enumeration / engagement sort.
   */
  private async executeNew(
    alias: string | undefined,
    token: string,
    requestedTypes: ConversationType[] | undefined,
    limit: number | undefined,
  ): Promise<number> {
    const [
      { testToken },
      { listConversations, renderConfigBlock, renderWorkspacesConfigBlock, diffConversations },
      config,
    ] = await Promise.all([
      import("../../connectors/slack/auth.ts"),
      import("../../connectors/slack/conversations.ts"),
      loadResolvedSlackConfig(),
    ]);

    if (config.error) {
      this.context.stderr.write(`error: ${config.error}\n`);
      return 1;
    }
    const configured = configuredChannelsForAlias(config.workspaces, alias);

    // Diff defaults to public + private: DMs / group-DMs are noisy and rarely
    // configured, so include them only when explicitly requested (ADR-0039 §3).
    const types: ConversationType[] = requestedTypes ?? ["public", "private"];

    const { createProgress } = await import("../progress.ts");
    const progress = createProgress(
      this.context.stderr,
      "slack conversations --new",
      this.noProgress ? false : undefined,
    );
    try {
      const { teamId } = await testToken(token);
      const result = await listConversations(token, {
        types,
        includeArchived: this.includeArchived,
        ...(limit !== undefined ? { limit } : {}),
        onProgress: () => progress.tick(),
      });
      progress.finish();

      const diff = diffConversations({
        visible: result.conversations,
        configured,
        sweptTypes: types,
      });

      if (this.json) {
        // New (additive) flag → new shape, so the existing full-listing --json is
        // byte-for-byte unchanged (Issue #370 / ADR-0039): { new, removed }.
        this.context.stdout.write(
          `${JSON.stringify({ new: diff.added, removed: diff.removed }, null, 2)}\n`,
        );
        return 0;
      }

      if (diff.added.length === 0) {
        this.context.stdout.write("no new conversations — config is up to date.\n");
      } else {
        this.context.stdout.write(
          `${diff.added.length} new conversation(s) you are a member of but have not configured:\n`,
        );
        this.context.stdout.write("  Joined  ID / Name\n");
        for (const c of diff.added) {
          this.context.stdout.write(`${formatConversationRow(c)}\n`);
        }
        this.context.stdout.write("\n");
        // Paste-ready fragment for the *new* channels only (ADR-0039 §2). The
        // TOML section must match the config shape sync ingests: a named
        // `[connectors.slack.workspaces.<alias>]` config discards the flat
        // `channels` (resolveWorkspaces), so a flat block pasted there is silently
        // ignored — render the workspace sub-section for the resolved alias
        // instead. --new is single-workspace scoped, so there is no cross-workspace
        // shared-channel de-dup to apply.
        const configLines =
          config.multi && alias !== undefined
            ? renderWorkspacesConfigBlock([{ teamId, alias, conversations: diff.added }])
            : renderConfigBlock(teamId, {
                conversations: diff.added,
                missingScopes: result.missingScopes,
              });
        for (const line of configLines) {
          this.context.stdout.write(`${line}\n`);
        }
        this.context.stderr.write(
          "next: add the new channel ids above to config.toml, then run `suasor slack sync`.\n",
        );
      }

      // Configured-but-unreachable channels: surface (left/archived/renamed) but
      // never auto-remove — the ingest decision stays with the operator (ADR-0039).
      if (diff.removed.length > 0) {
        this.context.stderr.write(
          `warning: ${diff.removed.length} configured channel(s) no longer reachable ` +
            `(left/archived/renamed): ${diff.removed.join(", ")}\n`,
        );
      }
      for (const [type, scope] of Object.entries(result.missingScopes)) {
        this.context.stderr.write(`warning: ${type} not listed — missing scope ${scope}\n`);
      }
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
    // Join each alias to its team id / resolved workspace name so a multi-
    // workspace operator can tell which Grid workspace a cursor block belongs to
    // (Issue #371 theme 3). Local projection join — no live fetch; unknown → alias
    // only.
    const identities = await readSlackWorkspaceIdentities();
    this.context.stdout.write("slack cursors:\n");
    for (const alias of aliases) {
      this.context.stdout.write(`  [${alias}]${workspaceIdentityLabel(identities.get(alias))}\n`);
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

    const next: Record<string, Record<string, string>> = structuredClone(current);
    const targets: string[] = [];
    if (this.all && !this.workspace) {
      // --all with no --workspace clears every workspace's cursors — unambiguous,
      // so it skips alias resolution (does not error on a multi-workspace config).
      for (const a of Object.keys(next)) targets.push(`[${a}] (all)`);
      for (const a of Object.keys(next)) delete next[a];
    } else {
      // Resolve the target workspace (Issue #371 theme 1): a single-workspace
      // config auto-selects its sole alias instead of resetting a `default` that
      // may not exist (the old `this.workspace ?? "default"` silent no-op); a
      // multi-workspace config with no `default` errors with the alias list.
      const resolved = await resolveWorkspaceAlias(this.workspace);
      if (!resolved.ok) {
        this.context.stderr.write(workspaceAmbiguityError(resolved.aliases));
        return 1;
      }
      const alias = resolved.alias ?? DEFAULT_WORKSPACE_ALIAS;
      // Name the team the reset targets (Issue #371 theme 3), on stderr so the
      // stdout preview / summary stays a clean machine-readable target list.
      const idLabel = workspaceIdentityLabel((await readSlackWorkspaceIdentities()).get(alias));
      if (idLabel) this.context.stderr.write(`workspace: [${alias}]${idLabel}\n`);
      if (this.all) {
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

    // Resolve the target workspace (Issue #371 theme 1): single-workspace configs
    // auto-select; a multi-workspace config with no `default` errors with the
    // alias list rather than backfilling a `default` that may not exist.
    const resolved = await resolveWorkspaceAlias(this.workspace);
    if (!resolved.ok) {
      this.context.stderr.write(workspaceAmbiguityError(resolved.aliases));
      return 1;
    }
    const alias = resolved.alias ?? DEFAULT_WORKSPACE_ALIAS;
    // Name the team the backfill targets (Issue #371 theme 3), on stderr.
    const idLabel = workspaceIdentityLabel((await readSlackWorkspaceIdentities()).get(alias));
    if (idLabel) this.context.stderr.write(`workspace: [${alias}]${idLabel}\n`);
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

/**
 * Resolve which workspace alias to act on from the `--workspace` flag and the
 * configured workspaces (Issue #371 theme 1). Loads the config to read the
 * `[connectors.slack.workspaces.*]` alias set, then delegates the decision to the
 * pure {@link chooseWorkspaceAlias}. Reads the raw `workspaces` keys (not a Zod
 * parse) so a validation error elsewhere in the slice never turns a plain alias
 * lookup into a hard failure. Shared by `slack auth set/test`, `conversations`,
 * and `cursor reset/backfill` so all resolve the same workspace.
 */
async function resolveWorkspaceAlias(
  explicit: string | undefined,
): Promise<
  | { readonly ok: true; readonly alias: string | undefined }
  | { readonly ok: false; readonly aliases: readonly string[] }
> {
  if (explicit !== undefined) return { ok: true, alias: explicit };
  const { loadConfig } = await import("../../config/index.ts");
  const config = await loadConfig();
  const slack = config.connectors[SLACK] as { workspaces?: Record<string, unknown> } | undefined;
  return chooseWorkspaceAlias(undefined, Object.keys(slack?.workspaces ?? {}));
}

/** A workspace's configured channel ids for the `--new` drift diff (ADR-0039). */
interface SlackWorkspaceChannels {
  readonly alias: string;
  readonly channels: readonly string[];
}

/**
 * Load + resolve the Slack connector config into per-workspace channel lists for
 * the `slack conversations --new` drift diff (ADR-0039). Reuses `resolveWorkspaces`
 * so `--new` sees the exact same channel set sync would ingest, for either config
 * shape (flat `[connectors.slack]` or `[connectors.slack.workspaces.<alias>]`). A
 * parse error is returned (not thrown) so the caller reports it as a clean error.
 */
async function loadResolvedSlackConfig(): Promise<{
  workspaces: SlackWorkspaceChannels[];
  /**
   * `true` when config uses the named `[connectors.slack.workspaces.<alias>]`
   * shape. `resolveWorkspaces` then ingests **only** those sub-sections and
   * discards the flat `channels`, so `--new` must render a
   * `[connectors.slack.workspaces.<alias>]` fragment (not a flat block sync would
   * silently ignore).
   */
  multi: boolean;
  error?: string;
}> {
  const [{ loadConfig }, { SlackConnectorConfig, resolveWorkspaces }] = await Promise.all([
    import("../../config/index.ts"),
    import("../../connectors/slack.ts"),
  ]);
  const config = await loadConfig();
  try {
    const parsed = SlackConnectorConfig.parse(config.connectors[SLACK] ?? {});
    const resolved = resolveWorkspaces(parsed);
    const multi = parsed.workspaces !== undefined && Object.keys(parsed.workspaces).length > 0;
    return { workspaces: resolved.map((w) => ({ alias: w.alias, channels: w.channels })), multi };
  } catch (cause) {
    return {
      workspaces: [],
      multi: false,
      error: `invalid Slack connector config: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

/**
 * Pick the configured channel ids for the resolved workspace alias (ADR-0039).
 * `resolveWorkspaceAlias` yields `undefined` for a flat config, which
 * `resolveWorkspaces` models as the `default` alias; an explicit alias matches by
 * name. An unknown alias falls back to no configured channels (so every member
 * conversation reads as new) — the safe drift signal, not a silent empty diff.
 */
function configuredChannelsForAlias(
  workspaces: readonly SlackWorkspaceChannels[],
  alias: string | undefined,
): string[] {
  const target = alias ?? DEFAULT_WORKSPACE_ALIAS;
  const ws =
    workspaces.find((w) => w.alias === target) ?? (alias === undefined ? workspaces[0] : undefined);
  return [...(ws?.channels ?? [])];
}

/**
 * The stderr message for an ambiguous `--workspace` omission (Issue #371 theme
 * 1): a multi-workspace config with no `default` alias. Lists the configured
 * aliases so the operator can pick one instead of silently touching the wrong
 * workspace.
 */
function workspaceAmbiguityError(aliases: readonly string[]): string {
  return (
    `error: multiple Slack workspaces configured (${aliases.join(", ")}); ` +
    "pass --workspace <alias> to choose one.\n"
  );
}

/**
 * The per-connector env override name for a workspace's token (Issue #371 theme
 * 4): `SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN` for a named alias (non-alphanumeric
 * chars, e.g. `-`, normalised to `_`), or `SUASOR_CONNECTOR_SLACK_TOKEN` for the
 * flat/default workspace. Surfaced in token-missing errors so the headless / WSL
 * override is discoverable from the CLI.
 */
async function slackTokenEnvName(alias: string | undefined): Promise<string> {
  const [{ secretEnvName }, { workspaceSecretName }] = await Promise.all([
    import("../../connectors/secrets.ts"),
    import("../../connectors/slack.ts"),
  ]);
  return secretEnvName(SLACK, workspaceSecretName(alias));
}

/**
 * The stderr message for a missing Slack token (Issue #371 theme 1/4): names the
 * workspace it looked under, the `slack auth set` recovery command, and the env
 * override that would satisfy it headless.
 */
async function noTokenError(alias: string | undefined): Promise<string> {
  const env = await slackTokenEnvName(alias);
  const where = alias ? ` for workspace '${alias}'` : "";
  const wsHint = alias ? ` --workspace ${alias}` : "";
  return (
    `error: no Slack token configured${where} ` +
    `(run \`suasor slack auth set${wsHint}\` or set env $${env})\n`
  );
}

/** A workspace's team identity for output enrichment (Issue #371 theme 3). */
interface SlackWorkspaceIdentity {
  readonly teamId: string;
  readonly teamName?: string;
}

/**
 * Build an alias → team identity map for enriching operational output (Issue
 * #371 theme 3): each configured workspace's `team` id joined to its resolved
 * name from the local `slack_teams` projection (ADR-0037 §10, Issue #361). Pure
 * local join — no live fetch. Returns an empty map on a config / parse error
 * (output falls back to alias-only). Shared by `slack status` and `slack cursor`.
 */
async function readSlackWorkspaceIdentities(): Promise<Map<string, SlackWorkspaceIdentity>> {
  const [{ loadConfig }, { Store }, { SlackConnectorConfig, resolveWorkspaces }] =
    await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../connectors/slack.ts"),
    ]);
  const config = await loadConfig();
  let workspaces: ReturnType<typeof resolveWorkspaces>;
  try {
    workspaces = resolveWorkspaces(SlackConnectorConfig.parse(config.connectors[SLACK] ?? {}));
  } catch {
    return new Map();
  }
  const names = new Map<string, string>();
  const dbPath = config.storage.dbPath;
  if (dbPath !== null) {
    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const rows = store.connection.sqlite
        .query("SELECT team_id AS id, name FROM slack_teams WHERE name <> ''")
        .all() as { id: string; name: string }[];
      for (const r of rows) names.set(r.id, r.name);
    } finally {
      store.close();
    }
  }
  const out = new Map<string, SlackWorkspaceIdentity>();
  for (const ws of workspaces) {
    const teamName = names.get(ws.team);
    out.set(ws.alias, { teamId: ws.team, ...(teamName ? { teamName } : {}) });
  }
  return out;
}

/**
 * Format a workspace's team identity for an output label (Issue #371 theme 3):
 * `  team T0123 (Acme)` when the name is resolved, `  team T0123` when only the
 * id is known, or `""` for the unconfigured flat placeholder (`team = "default"`)
 * so a plain single-workspace `[default]` header stays unchanged (no regression).
 */
function workspaceIdentityLabel(id: SlackWorkspaceIdentity | undefined): string {
  if (!id) return "";
  if (id.teamName) return `  team ${id.teamId} (${id.teamName})`;
  if (id.teamId && id.teamId !== DEFAULT_WORKSPACE_ALIAS) return `  team ${id.teamId}`;
  return "";
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
