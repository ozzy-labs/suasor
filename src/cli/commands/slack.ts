/**
 * Slack operational verbs (ADR-0011 / ADR-0042): `slack auth set` · `slack auth
 * test` · `slack conversations` · `slack status` · `slack cursor …` ·
 * `slack resolve-names`. These are operational commands, not ingest — they are
 * Slack-specific (the generic connector contract stays `sync`-only, ADR-0007)
 * and exist to close the onboarding gap: store the token pool, verify each
 * token's scopes, and discover conversation ids without hand-hunting them.
 *
 * Workspace-less (ADR-0042): there is no `--workspace` anywhere. Tokens live in
 * one unnamed pool (`connector:slack:tokens`, env
 * `SUASOR_CONNECTOR_SLACK_TOKENS`, newline/comma separated, replace-all) and
 * every verb spans the whole pool.
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
import type { ConversationType, SlackConversation } from "../../connectors/slack/conversations.ts";
import { isInteractiveStdin, readSecretLine } from "../read-secret.ts";

const SLACK = "slack";

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

/** `slack auth set` — replace the Slack token pool in the OS keychain. */
export class SlackAuthSetCommand extends Command {
  static override paths = [[SLACK, "auth", "set"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Store the Slack token pool in the OS keychain (service 'suasor').",
    details: `
      Persists the unnamed token pool (ADR-0042) so 'slack auth test',
      'slack conversations', and 'slack sync' resolve it without it ever touching
      config.toml (NFR-PRV-4). Pass --token (comma-separated for multiple), or
      omit it to read from stdin. The pool is **replaced as a whole** on every
      set, so a dead token never lingers by accident. One org-level (org-wide
      app) token can cover a whole Enterprise Grid; otherwise add one workspace
      token per workspace you need.
    `,
    examples: [
      ["Store one token from stdin", "echo xoxb-… | suasor slack auth set"],
      ["Store a pool of two", "suasor slack auth set --token xoxb-aaa…,xoxp-bbb…"],
    ],
  });

  token = Option.String("--token", {
    description: "Token value(s), comma-separated (omit to read from stdin).",
  });

  override async execute(): Promise<number> {
    let raw = this.token?.trim();
    if (!raw) {
      // On a TTY prompt to stderr (stdout stays machine-readable over a pipe).
      // The read is line-based and echo-suppressed (Issue #383).
      if (isInteractiveStdin(this.context.stdin)) {
        this.context.stderr.write(
          "Paste the Slack token(s) — comma-separated for multiple — and press Enter " +
            "(input is not echoed):\n",
        );
      }
      raw = (await readSecretLine(this.context.stdin, this.context.stderr, { mask: true })).trim();
    }

    const [{ storeSecret }, { parseTokenPool, SLACK_TOKENS_SECRET }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    const pool = parseTokenPool(raw);
    if (pool.length === 0) {
      this.context.stderr.write("error: no token provided (pass --token or pipe it on stdin)\n");
      return 1;
    }

    const keychain = (this.context as { keychain?: KeychainBackend }).keychain;
    // Canonical storage form: newline-separated (replace-all, ADR-0042 決定 2).
    await storeSecret(SLACK, SLACK_TOKENS_SECRET, pool.join("\n"), keychain ? { keychain } : {});
    this.context.stdout.write(
      `Stored ${pool.length} Slack token(s) in the OS keychain (service 'suasor'); ` +
        "the pool was replaced as a whole.\n",
    );
    this.context.stdout.write("next: verify it with `suasor slack auth test`.\n");
    return 0;
  }
}

/** `slack auth test` — verify every pool token and report scopes + readiness. */
export class SlackAuthTestCommand extends Command {
  static override paths = [[SLACK, "auth", "test"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Verify every pool token and report granted scopes + per-feature readiness.",
    details: `
      Calls auth.test once per pool token: prints each token's resolved
      principal/team/user, the granted OAuth scopes, and a 'features:' block
      assessing each ingestion feature as READY / READY (degraded) / MISSING
      <scope> / N/A (ADR-0011). Readiness is a scope verdict only — it does not
      guarantee channel membership. A failing token is reported as dead (replace
      the pool with 'slack auth set') and the command exits 1.
    `,
    examples: [["Test the stored pool", "suasor slack auth test"]],
  });

  json = Option.Boolean("--json", false, { description: "Emit the results as JSON." });

  override async execute(): Promise<number> {
    const [{ resolveSecret }, { parseTokenPool, SLACK_TOKENS_SECRET }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    const pool = parseTokenPool(await resolveSecret(SLACK, SLACK_TOKENS_SECRET));
    if (pool.length === 0) {
      this.context.stderr.write(await noTokenError());
      return 1;
    }

    const [{ testToken }, { assessReadiness, renderFeaturesBlock }] = await Promise.all([
      import("../../connectors/slack/auth.ts"),
      import("../../connectors/slack/scopes.ts"),
    ]);

    type TokenReport =
      | ({ index: number; ok: true } & Awaited<ReturnType<typeof testToken>> & {
            features: ReturnType<typeof assessReadiness>;
          })
      | { index: number; ok: false; error: string };
    const reports: TokenReport[] = [];
    for (const [i, token] of pool.entries()) {
      try {
        const result = await testToken(token);
        reports.push({
          index: i + 1,
          ok: true,
          ...result,
          features: assessReadiness(result.scopes, result.principal),
        });
      } catch (cause) {
        reports.push({
          index: i + 1,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    const anyDead = reports.some((r) => !r.ok);

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify({ tokens: reports }, null, 2)}\n`);
      return anyDead ? 1 : 0;
    }

    const label = (i: number): string => (pool.length > 1 ? `token #${i}: ` : "");
    const userIds: string[] = [];
    for (const r of reports) {
      if (!r.ok) {
        this.context.stderr.write(
          `${label(r.index)}dead — ${r.error} (replace the pool with \`suasor slack auth set\`)\n`,
        );
        continue;
      }
      this.context.stdout.write(
        `${label(r.index)}ok: ${r.principal} token for ${r.user} @ ${r.team} (${r.teamId})\n`,
      );
      this.context.stdout.write(`user_id: ${r.userId}\n`);
      if (r.principal === "user") userIds.push(r.userId);
      this.context.stdout.write(`scopes: ${r.scopes || "(none reported)"}\n`);
      this.context.stdout.write("features:\n");
      for (const line of renderFeaturesBlock(r.scopes, r.principal)) {
        this.context.stdout.write(`${line}\n`);
      }
    }
    // Surface the self-id guidance once (ADR-0012 / ADR-0042 決定 2): the ids
    // the operator copies into `self_user_ids` so `demand.list` detects their
    // own @mentions. Without them, demand silently degrades to DM-only.
    const idHint =
      userIds.length > 0 ? `, e.g. \`self_user_ids = ${JSON.stringify(userIds)}\`` : "";
    this.context.stdout.write(
      "note: add your own user id(s) to `self_user_ids` under [connectors.slack] so " +
        `demand.list detects your @mentions${idHint} — without it, demand degrades ` +
        "to DM-only (ADR-0012).\n",
    );
    return anyDead ? 1 : 0;
  }
}

/** One Grid workspace surfaced by the pool sweep (grouping / labels only). */
interface SweepTeam {
  readonly id: string;
  /** Workspace name, or the id when unknown (matches `SlackTeam`). */
  readonly name: string;
}

/** `slack conversations` — list conversations the pool can see + a config block. */
export class SlackConversationsCommand extends Command {
  static override paths = [[SLACK, "conversations"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "List conversations the token pool can see and print a paste-ready config block.",
    details: `
      Enumerates public/private channels + DMs + group-DMs (users.conversations)
      across **every pool token** (ADR-0042), type by type, so a missing listing
      scope self-reports per type rather than failing the sweep (ADR-0011).
      Prints a flat [connectors.slack] block you can paste into config.toml, then
      run 'suasor slack sync'.

      An org-level (org-wide app) token additionally auto-enumerates every Grid
      workspace it is approved for (auth.teams.list). Rows from multiple
      workspaces are grouped with a workspace label; pass --team-id <T…> to scope
      an org-level token to a single workspace.

      A channel visible via several workspaces (one global channel id) is listed
      once and marked "shared across [<workspaces>]"; --json adds a per-row
      sharedAcross array. In the config block it appears once (a comment
      elsewhere) — pure paste hygiene: with the canonical externalId (ADR-0042)
      a duplicated entry would only cost a redundant fetch.

      Pass --new to show only the config *drift* (ADR-0039): the conversations
      you are a member of (via any pool token) but have not listed in config
      (paste-ready), plus a warning for configured channels no token can reach.
      --new --json emits { new: [...], removed: [...] }.
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
      "Enterprise Grid workspace (team) id to scope an org-level token's sweep to (#350).",
  });
  json = Option.Boolean("--json", false, { description: "Emit the result as JSON." });
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

    const [{ resolveSecret }, { parseTokenPool, SLACK_TOKENS_SECRET }] = await Promise.all([
      import("../../connectors/secrets.ts"),
      import("../../connectors/slack.ts"),
    ]);
    const pool = parseTokenPool(await resolveSecret(SLACK, SLACK_TOKENS_SECRET));
    if (pool.length === 0) {
      this.context.stderr.write(await noTokenError());
      return 1;
    }

    // --new shows only the config drift (ADR-0039) and needs no Grid
    // auto-enumeration / engagement sort. Everything above (arg validation,
    // pool resolution) is shared.
    if (this.new) return this.executeNew(pool, types, limit);

    const [
      { testToken },
      { listConversations, renderConfigBlock, renderWorkspacesConfigBlock, collapseByChannelId },
      { listTeams, workspaceAliases },
      { createProgress },
    ] = await Promise.all([
      import("../../connectors/slack/auth.ts"),
      import("../../connectors/slack/conversations.ts"),
      import("../../connectors/slack/teams.ts"),
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
      // Sweep every pool token (ADR-0042): each token contributes the
      // conversations it can see, tagged with its workspace (team) so rows can
      // be grouped. An org-level token additionally auto-enumerates its Grid
      // workspaces (#350); a workspace token contributes its own workspace.
      const merged: SlackConversation[] = [];
      const missingScopes: Record<string, string> = {};
      const teamsById = new Map<string, SweepTeam>();
      let firstTeamId: string | undefined;
      let anyEnterprise = false;
      let engagementToken: string | undefined;
      let liveTokens = 0;

      for (const [i, token] of pool.entries()) {
        let identity: Awaited<ReturnType<typeof testToken>>;
        try {
          identity = await testToken(token);
        } catch (cause) {
          this.context.stderr.write(
            `warning: token #${i + 1} is dead (${
              cause instanceof Error ? cause.message : String(cause)
            }) — replace the pool with \`suasor slack auth set\`\n`,
          );
          continue;
        }
        liveTokens += 1;
        firstTeamId = firstTeamId ?? identity.teamId;
        if (identity.principal === "user" && engagementToken === undefined) {
          engagementToken = token;
        }
        if (identity.isEnterpriseInstall) anyEnterprise = true;
        // --team-id only scopes the sweep on an org-level (org-wide app) token;
        // Slack silently ignores it for a workspace-level token (Issue #350).
        const scopeTeamId = this.teamId && identity.isEnterpriseInstall ? this.teamId : undefined;

        // Enterprise Grid auto-enumeration (#350): an org-level token with no
        // explicit --team-id sweeps every workspace the org-wide app is
        // approved for. Best-effort — non-Grid / missing scope / single
        // workspace falls back to the token's own workspace.
        const gridTeams =
          identity.isEnterpriseInstall && !this.teamId
            ? await listTeams(token, { onProgress: () => progress.tick() })
            : [];
        // Enumeration is best-effort and never throws, so "org token, but only
        // one workspace came back" is indistinguishable from a real single-
        // workspace org unless we say so. Staying quiet here reinstates the
        // pre-#350 bug — channels from every other workspace simply missing —
        // with nothing on screen to suggest the list is partial (ADR-0007).
        if (identity.isEnterpriseInstall && !this.teamId && gridTeams.length <= 1) {
          this.context.stderr.write(
            "warning: Enterprise Grid workspace enumeration returned " +
              `${gridTeams.length === 0 ? "nothing" : "one workspace"}; sweeping only ` +
              `'${identity.team ?? identity.teamId}'. Other workspaces' channels are NOT listed. ` +
              "Usually a non-org-level token or a missing scope — or genuinely a single-workspace " +
              "org. Pass --team-id <T…> to target one explicitly.\n",
          );
        }
        const sweepTeams: SweepTeam[] =
          gridTeams.length > 1
            ? gridTeams
            : [
                {
                  id: scopeTeamId ?? identity.teamId,
                  name: scopeTeamId ?? identity.team ?? identity.teamId,
                },
              ];
        for (const team of sweepTeams) {
          if (!teamsById.has(team.id)) teamsById.set(team.id, team);
          const r = await listConversations(token, {
            ...(types ? { types } : {}),
            teamId: team.id,
            includeArchived: this.includeArchived,
            onProgress: () => progress.tick(),
          });
          merged.push(...r.conversations);
          for (const [type, scope] of Object.entries(r.missingScopes)) {
            missingScopes[type] = scope;
          }
        }
      }
      if (liveTokens === 0) {
        progress.finish();
        this.context.stderr.write(
          "error: every pool token failed auth.test — replace the pool " +
            "(`suasor slack auth set` / SUASOR_CONNECTOR_SLACK_TOKENS)\n",
        );
        return 1;
      }
      if (this.teamId && !anyEnterprise) {
        this.context.stderr.write(
          `warning: --team-id is ignored for workspace-level tokens (Slack honours it only ` +
            `for org-level/org-wide-app tokens); listed each token's own workspace instead.\n`,
        );
      }

      // Exact duplicates (two tokens of the same workspace listing the same
      // channel) collapse first; the cross-workspace collapse happens below.
      const seenRows = new Set<string>();
      let conversations = merged.filter((c) => {
        const key = `${c.teamId ?? ""}:${c.id}`;
        if (seenRows.has(key)) return false;
        seenRows.add(key);
        return true;
      });
      // --limit caps the merged total across the pool (parity with the old
      // single-sweep limit, which caps the output not the fetch).
      if (limit !== undefined) conversations = conversations.slice(0, limit);

      const teams = [...teamsById.values()];
      const multi = teams.length > 1;
      const aliasByTeam = workspaceAliases(teams);

      // Engagement axis (--sort=last_self_post): resolve each conversation's
      // last self-post ts via search.messages and sort by it. Requires a User
      // Token; a pool with none degrades to N/A and the default order (ADR-0013).
      let lastSelfPost: Map<string, string> | null = null;
      if (this.sort === "last_self_post") {
        if (engagementToken === undefined) {
          progress.finish();
          this.context.stderr.write(
            "warning: --sort=last_self_post is N/A (User Token only) — listing in default order\n",
          );
        } else {
          const { searchLastSelfPost, sortByLastSelfPost } = await import(
            "../../connectors/slack/search.ts"
          );
          lastSelfPost = await searchLastSelfPost(engagementToken, {
            onProgress: () => progress.tick(),
          });
          conversations = sortByLastSelfPost(conversations, lastSelfPost);
          progress.finish();
          this.context.stderr.write(
            "note: last_self_post reflects Slack's search index, which lags real time (approximate)\n",
          );
        }
      }
      progress.finish();

      // Collapse the sweep by global channel id (display hygiene). With the
      // canonical externalId (ADR-0042) a shared channel ingests identically
      // wherever it is configured — the listing just shows it once (placed
      // under the smallest workspace label, purely for stable display) and
      // marks which workspaces it spans.
      const aliasOfRow = (c: SlackConversation): string =>
        (c.teamId && aliasByTeam.get(c.teamId)) || c.teamId || "";
      const collapsed = multi
        ? collapseByChannelId(
            teams.map((t) => ({
              alias: aliasByTeam.get(t.id) ?? t.id,
              channels: conversations.filter((c) => c.teamId === t.id).map((c) => c.id),
            })),
          )
        : null;
      // channel id → the workspaces it is shared across (ascending), only for
      // the ≥2-workspace channels; drives the `sharedAcross` field + text note.
      const sharedAliases = collapsed?.shared ?? new Map<string, string[]>();
      const displayed = collapsed
        ? conversations.filter((c) => collapsed.placement.get(c.id) === aliasOfRow(c))
        : conversations;

      if (this.json) {
        // Additive, back-compatible per-row fields: `lastSelfPost` (engagement
        // sort) and `sharedAcross` (the workspaces a shared channel spans,
        // ADR-0042 display collapse). Both are omitted when absent so the
        // single-workspace, non-shared shape is byte-for-byte unchanged.
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
              teamId: firstTeamId,
              conversations: withEngagement,
              missingScopes,
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
          : `${displayed.length} conversation(s) visible to the pool:\n`,
      );
      // Label the columns Joined / ID / Name so it is unambiguous that the second
      // column is the value to copy into `channels` (config wants ids, not names —
      // Issue #158) and that the leading mark is reachability. The header is
      // omitted when there is nothing to label.
      if (displayed.length > 0) {
        this.context.stdout.write("  Joined  ID / Name\n");
      }
      // `✓` = a token's principal is a member (reachable by sync); a blank cell
      // means not joined → that channel returns `not_in_channel` and ingests
      // nothing until the bot joins / is /invite'd (ADR-0011). See
      // formatConversationRow for the row layout.
      for (const c of displayed) {
        let engagement = "";
        if (lastSelfPost) {
          const ts = lastSelfPost.get(c.id);
          engagement = `  last_self_post=${ts ? formatSlackTs(ts, this.now) : "-"}`;
        }
        // In a multi-workspace sweep, label each row with its workspace so it is
        // clear which Grid workspace a channel belongs to (Issue #350).
        const wsLabel = multi && c.teamId ? `  [${aliasByTeam.get(c.teamId) ?? c.teamId}]` : "";
        // A shared channel is listed once; mark the workspaces it spans so the
        // operator sees it is Grid-shared, not duplicated (ADR-0042).
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
      for (const [type, scope] of Object.entries(missingScopes)) {
        this.context.stderr.write(`warning: ${type} not listed — missing scope ${scope}\n`);
      }
      this.context.stdout.write("\n");
      // The config block is a single flat [connectors.slack] either way
      // (ADR-0042): a multi-workspace sweep groups the ids with workspace
      // comment headers for orientation only.
      const configLines = multi
        ? renderWorkspacesConfigBlock(
            teams.map((t) => ({
              teamId: t.id,
              alias: aliasByTeam.get(t.id) ?? t.id,
              conversations: conversations.filter((c) => c.teamId === t.id),
            })),
          )
        : renderConfigBlock(firstTeamId ?? "", { conversations, missingScopes });
      for (const line of configLines) {
        this.context.stdout.write(`${line}\n`);
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

  /**
   * `slack conversations --new` — surface only the config drift (ADR-0039).
   * Sweeps every pool token's visible conversations (default public+private),
   * unions them, diffs against the flat configured `channels`, and prints the
   * member conversations not yet configured (paste-ready flat block) plus a
   * warn for configured channels no token can reach. `--new --json` emits
   * `{ new, removed }`; the full-listing `--json` shape is untouched.
   */
  private async executeNew(
    pool: readonly string[],
    requestedTypes: ConversationType[] | undefined,
    limit: number | undefined,
  ): Promise<number> {
    const [
      { listConversations, renderConfigBlock, diffConversations },
      { SlackConnectorConfig, rejectLegacySlackConfig },
      { loadConfig },
    ] = await Promise.all([
      import("../../connectors/slack/conversations.ts"),
      import("../../connectors/slack.ts"),
      import("../../config/index.ts"),
    ]);

    let configured: string[];
    try {
      const config = await loadConfig();
      rejectLegacySlackConfig(config.connectors[SLACK] ?? {});
      configured = SlackConnectorConfig.parse(config.connectors[SLACK] ?? {}).channels;
    } catch (cause) {
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }

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
      // Union of every pool token's visible conversations: a channel reachable
      // via any token is visible, and a configured channel is only "removed"
      // when no token at all can reach it (ADR-0042).
      const byId = new Map<string, SlackConversation>();
      const missingScopes: Record<string, string> = {};
      for (const token of pool) {
        const result = await listConversations(token, {
          types,
          includeArchived: this.includeArchived,
          ...(limit !== undefined ? { limit } : {}),
          onProgress: () => progress.tick(),
        });
        for (const c of result.conversations) {
          const prev = byId.get(c.id);
          // A member row wins over a non-member row for the same channel.
          if (!prev || (!prev.isMember && c.isMember)) byId.set(c.id, c);
        }
        for (const [type, scope] of Object.entries(result.missingScopes)) {
          missingScopes[type] = scope;
        }
      }
      progress.finish();

      const visible = [...byId.values()];
      const diff = diffConversations({ visible, configured, sweptTypes: types });

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
        // Paste-ready fragment for the *new* channels only (ADR-0039 §2), always
        // the flat [connectors.slack] shape (ADR-0042).
        const configLines = renderConfigBlock("", {
          conversations: diff.added,
          missingScopes,
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
      for (const [type, scope] of Object.entries(missingScopes)) {
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

/** `slack status` — show the saved resume cursor (per channel). */
export class SlackStatusCommand extends Command {
  static override paths = [[SLACK, "status"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Show the saved Slack resume cursor (per channel).",
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
      // The top-level object is the flat channel → ts cursor map (ADR-0042).
      // Resolved names are surfaced under a sibling `names` map (channel id →
      // resolved name), only when at least one resolved.
      const names = Object.fromEntries([...channelNames].map(([id, { name }]) => [id, name]));
      const payload = Object.keys(names).length > 0 ? { ...map, names } : map;
      this.context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return 0;
    }
    const keys = Object.keys(map);
    if (keys.length === 0) {
      this.context.stdout.write("slack cursors: (none — never synced, or reset)\n");
      return 0;
    }
    // Humanize the resume ts so an operator can read "what was synced until
    // when" at a glance; the --json path above keeps the raw ts (#84). `now` is
    // injectable so the relative phrasing is deterministic under test.
    const { formatSlackTs } = await import("../slack-time.ts");
    const { parseThreadCursorKey } = await import("../../connectors/slack.ts");
    this.context.stdout.write("slack cursors:\n");
    // Per-thread cursors (`<channel>#<thread_ts>`, ADR-0015 R1) are a
    // steady-state-capture detail. Fold them into a per-channel active count
    // rather than printing one noisy row each; `--json` keeps the raw keys.
    const threadCounts = new Map<string, number>();
    for (const key of keys) {
      const parsed = parseThreadCursorKey(key);
      if (parsed) threadCounts.set(parsed.channel, (threadCounts.get(parsed.channel) ?? 0) + 1);
    }
    for (const [channel, ts] of Object.entries(map)) {
      if (parseThreadCursorKey(channel)) continue; // thread cursor — summarised
      const rec = channelNames.get(channel);
      const label = rec ? `  ${slackChannelLabel(rec.name, rec.kind)}` : "";
      const threads = threadCounts.get(channel) ?? 0;
      const threadNote =
        threads > 0 ? `  (+${threads} active thread${threads === 1 ? "" : "s"})` : "";
      this.context.stdout.write(
        `  ${channel}${label}  ${formatSlackTs(ts, this.now)}${threadNote}\n`,
      );
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
      C1,C2 or --all. Requires --yes to apply; without it the targets are
      previewed only.
    `,
    examples: [
      ["Preview a reset", "suasor slack cursor reset --channel C0123"],
      ["Reset two channels", "suasor slack cursor reset --channel C0123,C0456 --yes"],
      ["Reset everything", "suasor slack cursor reset --all --yes"],
    ],
  });

  channel = Option.String("--channel", { description: "Channel id(s) to reset, comma-separated." });
  all = Option.Boolean("--all", false, { description: "Reset every channel." });
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
    // (`C0123 #general`) beside the id (ADR-0037 §1). No live fetch.
    const channelNames = await readSlackChannelNames();

    const [{ serializeCursor, parseThreadCursorKey }, { loadConfig }, { Store }] =
      await Promise.all([
        import("../../connectors/slack.ts"),
        import("../../config/index.ts"),
        import("../../db/index.ts"),
      ]);

    const next: Record<string, string> = structuredClone(current);
    const targets: string[] = [];
    if (this.all) {
      if (Object.keys(next).length > 0) targets.push("(all)");
      for (const key of Object.keys(next)) delete next[key];
    } else {
      for (const ch of channels) {
        let matched = next[ch] !== undefined;
        delete next[ch];
        // Resetting a channel also clears its per-thread high-water marks
        // (`<channel>#<thread_ts>`, ADR-0015 R1) so its threads re-discover
        // from the floor rather than resuming from a stale mark.
        let threadN = 0;
        for (const key of Object.keys(next)) {
          const parsed = parseThreadCursorKey(key);
          if (parsed && parsed.channel === ch) {
            delete next[key];
            threadN += 1;
            matched = true;
          }
        }
        if (matched) {
          const rec = channelNames.get(ch);
          const label = rec ? ` ${slackChannelLabel(rec.name, rec.kind)}` : "";
          const threadNote = threadN > 0 ? ` (+${threadN} thread)` : "";
          targets.push(`${ch}${label}${threadNote}`);
        }
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
  yes = Option.Boolean("--yes", false, {
    description: "Apply the backfill (without it, preview only).",
  });

  override async execute(): Promise<number> {
    if (!this.channel || !this.since) {
      this.context.stderr.write("error: --channel <id> and --since <floor> are both required\n");
      return 1;
    }

    const { parseSinceToTs, serializeCursor, parseThreadCursorKey } = await import(
      "../../connectors/slack.ts"
    );
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
    // (`C0123 #general: … → …`) beside the id (ADR-0037 §1). No live fetch.
    const channelNames = await readSlackChannelNames();

    const next: Record<string, string> = structuredClone(current);
    const before = next[this.channel];
    // Backfill goes OLDER. If the floor is not older than the current cursor it
    // would *advance* it and skip unfetched messages — warn (footgun guard).
    if (before !== undefined && Number.parseFloat(floorTs) >= Number.parseFloat(before)) {
      this.context.stderr.write(
        `warning: --since (${floorTs}) is not older than the current cursor (${before}); ` +
          "this advances the cursor and would skip unfetched messages\n",
      );
    }
    next[this.channel] = floorTs;
    // Lowering the channel cursor re-fetches its older history; also drop the
    // channel's per-thread high-water marks (`<channel>#<thread_ts>`, ADR-0015
    // R1) so threads in the re-fetched window are rediscovered rather than
    // resuming from a mark ahead of the new floor.
    let threadCleared = 0;
    for (const key of Object.keys(next)) {
      const parsed = parseThreadCursorKey(key);
      if (parsed && parsed.channel === this.channel) {
        delete next[key];
        threadCleared += 1;
      }
    }

    const rec = channelNames.get(this.channel);
    const label = rec ? ` ${slackChannelLabel(rec.name, rec.kind)}` : "";
    const threadNote = threadCleared > 0 ? ` (+${threadCleared} thread cursor(s) cleared)` : "";
    const summary = `${this.channel}${label}: ${before ?? "(none)"} → ${floorTs}${threadNote}`;
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
      local slack_message sources, collects the distinct channel + user ids, and
      re-resolves the ones whose name is still missing via users.info /
      conversations.info — the same path sync uses — enriching the
      slack_channels + person projections (ADR-0037 §11). Ids resolve via the
      pool token whose workspace matches, with one failover (ADR-0042).
      Idempotent: already-named ids are skipped (pass --force to re-resolve). A
      scope-less / erroring id is degraded (counted, id fallback kept) so it
      never aborts the pass (§6).
    `,
    examples: [
      ["Backfill missing names", "suasor slack resolve-names"],
      ["Re-resolve even named ids", "suasor slack resolve-names --force"],
    ],
  });

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
      { SlackConnectorConfig, defaultSlackClientFactory, rejectLegacySlackConfig },
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
      rejectLegacySlackConfig(config.connectors[SLACK] ?? {});
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
    return 0;
  }
}

/**
 * Load the saved Slack cursor as a flat channel → ts map, or `null` on a config
 * error (after writing the error to stderr). Shared by `slack status`,
 * `slack cursor reset`, and `slack cursor backfill`.
 */
async function readSlackCursor(cmd: Command): Promise<Record<string, string> | null> {
  const [{ loadConfig }, { Store }, { lastCursor }, { cursorToChannelMap }] = await Promise.all([
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
    return cursorToChannelMap(lastCursor(store.connection.sqlite, SLACK));
  } finally {
    store.close();
  }
}

/**
 * The stderr message for a missing Slack token pool: names the `slack auth set`
 * recovery command and the env override that would satisfy it headless.
 */
async function noTokenError(): Promise<string> {
  const { secretEnvName } = await import("../../connectors/secrets.ts");
  const env = secretEnvName(SLACK, "tokens");
  return (
    "error: no Slack token pool configured " +
    `(run \`suasor slack auth set\` or set env $${env} — newline/comma separated)\n`
  );
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
