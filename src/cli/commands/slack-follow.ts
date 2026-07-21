/**
 * `slack follow` / `slack unfollow` — name-based channel selection (ADR-0042
 * 決定 6). The operator adds / removes ingest targets by **human name** (or id);
 * the tool resolves names to ids across the token pool and edits the flat
 * `[connectors.slack].channels` list surgically (comments elsewhere survive).
 * The id is the truth; names are input/display only.
 *
 * `slack follow --suggest` is the suggest-and-confirm onboarding shape: it
 * proposes the member (joined) public/private channels not yet in config as a
 * pre-checked list and applies them after **one confirmation** (DMs / group-DMs
 * stay opt-in via explicit `slack follow`; auto-ingest without a confirmation is
 * deliberately not offered — ADR-0004 HITL).
 *
 * Lazy-import discipline (NFR-PRF-1): heavy modules load inside `execute`.
 */
import { Command, Option } from "clipanion";
import type { ConversationType, SlackConversation } from "../../connectors/slack/conversations.ts";
import { isInteractiveStdin } from "../read-secret.ts";

const SLACK = "slack";

/** One resolved follow target. */
export interface ResolvedRef {
  readonly ref: string;
  readonly id: string;
  /** Display label for the config comment (name; team-tagged when known). */
  readonly label?: string;
}

/** Outcome of resolving user-supplied refs against the pool's conversations. */
export interface RefResolution {
  readonly resolved: ResolvedRef[];
  /** ref → the candidate rows it ambiguously matched (2+ distinct ids). */
  readonly ambiguous: Map<string, SlackConversation[]>;
  /** refs that matched nothing. */
  readonly notFound: string[];
}

/** Whether a ref is already a conversation id (C/G/D prefix; ids are truth). */
function looksLikeId(ref: string): boolean {
  return /^[CDG][A-Z0-9]+$/i.test(ref.trim());
}

/**
 * Resolve name refs against the visible conversations (pure; the sweep is done
 * by the caller). A ref matches by exact `name` or `displayName`, with a
 * leading `#` stripped (`#general` == `general`). Matches are deduplicated by
 * channel id (the same channel seen via several teams / tokens is one target,
 * ADR-0042); 2+ **distinct** ids for one ref is ambiguous.
 */
export function resolveNameRefs(
  refs: readonly string[],
  visible: readonly SlackConversation[],
): RefResolution {
  const resolved: ResolvedRef[] = [];
  const ambiguous = new Map<string, SlackConversation[]>();
  const notFound: string[] = [];
  for (const ref of refs) {
    const bare = ref.trim().replace(/^#/, "");
    const matches = visible.filter(
      (c) => c.name === bare || c.displayName === ref.trim() || c.displayName === `#${bare}`,
    );
    const byId = new Map<string, SlackConversation>();
    for (const m of matches) if (!byId.has(m.id)) byId.set(m.id, m);
    if (byId.size === 0) {
      notFound.push(ref);
    } else if (byId.size > 1) {
      ambiguous.set(ref, [...byId.values()]);
    } else {
      const row = [...byId.values()][0] as SlackConversation;
      resolved.push({ ref, id: row.id, label: row.displayName });
    }
  }
  return { resolved, ambiguous, notFound };
}

/** Shared: resolve the pool or fail with the standard no-pool guidance. */
async function resolvePool(stderr: { write(s: string): unknown }): Promise<string[] | null> {
  const [{ resolveSecret, secretEnvName }, { parseTokenPool, SLACK_TOKENS_SECRET }] =
    await Promise.all([import("../../connectors/secrets.ts"), import("../../connectors/slack.ts")]);
  const pool = parseTokenPool(await resolveSecret(SLACK, SLACK_TOKENS_SECRET));
  if (pool.length === 0) {
    stderr.write(
      "error: no Slack token pool configured " +
        `(run \`suasor slack auth set\` or set env $${secretEnvName(SLACK, "tokens")})\n`,
    );
    return null;
  }
  return pool;
}

/** Sweep every pool token's visible conversations (union, deduped by id+team). */
async function sweepPool(
  pool: readonly string[],
  types?: readonly ConversationType[],
): Promise<SlackConversation[]> {
  const { listConversations } = await import("../../connectors/slack/conversations.ts");
  const seen = new Set<string>();
  const out: SlackConversation[] = [];
  for (const token of pool) {
    const { conversations } = await listConversations(token, {
      ...(types ? { types } : {}),
    });
    for (const c of conversations) {
      const key = `${c.teamId ?? ""}:${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/** Load the raw config.toml text + its path (empty string when absent). */
async function readConfigFile(): Promise<{ path: string; text: string }> {
  const [{ resolveConfigDir }, { join }] = await Promise.all([
    import("../../config/index.ts"),
    import("node:path"),
  ]);
  const path = join(resolveConfigDir(process.env), "config.toml");
  const file = Bun.file(path);
  return { path, text: (await file.exists()) ? await file.text() : "" };
}

/** The currently configured channel ids (flat shape; legacy configs throw). */
async function configuredChannels(stderr: { write(s: string): unknown }): Promise<string[] | null> {
  const [{ loadConfig }, { SlackConnectorConfig }] = await Promise.all([
    import("../../config/index.ts"),
    import("../../connectors/slack.ts"),
  ]);
  try {
    const config = await loadConfig();
    return SlackConnectorConfig.parse(config.connectors[SLACK] ?? {}).channels;
  } catch (cause) {
    stderr.write(`error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    return null;
  }
}

/** `slack follow` — add channels to the ingest list by name or id. */
export class SlackFollowCommand extends Command {
  static override paths = [[SLACK, "follow"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Add channels to [connectors.slack].channels by name or id.",
    details: `
      Resolves each name across the token pool (users.conversations), then
      surgically appends the resolved **ids** to the flat channels list in
      config.toml (comments elsewhere are preserved; the id is the truth and the
      name is a comment label — ADR-0042). Ids (C…/G…/D…) are accepted as-is.
      A name matching two different channels (e.g. #general in two workspaces)
      errors with the candidates — re-run with the id.

      --suggest proposes the joined public/private channels not yet in config
      (DMs / group-DMs stay opt-in via an explicit follow) and applies them
      after one confirmation — the suggest-and-confirm onboarding shape
      (ADR-0042 決定 6). Pass --yes to skip the prompt (headless).
    `,
    examples: [
      ["Follow one channel by name", "suasor slack follow '#eng-team'"],
      ["Follow by id", "suasor slack follow C0123ABCD"],
      ["Suggest-and-confirm the active channels", "suasor slack follow --suggest"],
      ["Headless suggest", "suasor slack follow --suggest --yes"],
    ],
  });

  suggest = Option.Boolean("--suggest", false, {
    description:
      "Propose the joined public/private channels not yet in config and apply after one confirmation.",
  });
  yes = Option.Boolean("--yes", false, {
    description: "Apply without the confirmation prompt (headless).",
  });
  refs = Option.Rest();

  override async execute(): Promise<number> {
    const stdout = this.context.stdout;
    const stderr = this.context.stderr;
    if (!this.suggest && this.refs.length === 0) {
      stderr.write("error: pass one or more channel names/ids, or --suggest\n");
      return 1;
    }

    const configured = await configuredChannels(stderr);
    if (configured === null) return 1;
    const configuredSet = new Set(configured);

    // Id-only refs need no network; anything else sweeps the pool once.
    const entries: { id: string; label?: string }[] = [];
    const nameRefs = this.refs.filter((r) => !looksLikeId(r));
    const idRefs = this.refs.filter((r) => looksLikeId(r));
    for (const id of idRefs) entries.push({ id: id.trim() });

    if (nameRefs.length > 0 || this.suggest) {
      const pool = await resolvePool(stderr);
      if (pool === null) return 1;
      let visible: SlackConversation[];
      try {
        // --suggest sweeps public+private only (DMs stay opt-in); name refs may
        // target DMs/group-DMs, so their sweep spans all four types.
        visible = await sweepPool(
          pool,
          this.suggest && nameRefs.length === 0 ? ["public", "private"] : undefined,
        );
      } catch (cause) {
        stderr.write(`error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        return 1;
      }

      if (nameRefs.length > 0) {
        const { resolved, ambiguous, notFound } = resolveNameRefs(nameRefs, visible);
        if (notFound.length > 0 || ambiguous.size > 0) {
          for (const ref of notFound) {
            stderr.write(`error: no conversation matches '${ref}' across the pool\n`);
          }
          for (const [ref, rows] of ambiguous) {
            const cands = rows.map((r) => `${r.id}${r.teamId ? ` (${r.teamId})` : ""}`).join(", ");
            stderr.write(
              `error: '${ref}' is ambiguous across workspaces — pass the id instead: ${cands}\n`,
            );
          }
          return 1;
        }
        for (const r of resolved)
          entries.push({ id: r.id, ...(r.label ? { label: r.label } : {}) });
      }

      if (this.suggest) {
        // Suggest = joined, not-yet-configured, non-DM conversations (the
        // pre-checked list; DMs are opt-in by explicit follow — ADR-0042 決定 6).
        const picked = new Set(entries.map((e) => e.id));
        const candidates = visible.filter(
          (c) =>
            c.isMember &&
            (c.type === "public" || c.type === "private") &&
            !configuredSet.has(c.id) &&
            !picked.has(c.id),
        );
        if (candidates.length === 0 && entries.length === 0) {
          stdout.write("nothing to suggest — every joined channel is already configured.\n");
          return 0;
        }
        if (candidates.length > 0) {
          stdout.write(`${candidates.length} joined channel(s) not yet in config:\n`);
          for (const c of candidates) {
            stdout.write(`  ${c.id}  ${c.displayName}\n`);
          }
          // One confirmation (suggest-and-confirm): Enter/Y applies. --yes and
          // a non-TTY pipe of "y" both work headless; anything else aborts.
          if (!this.yes) {
            stderr.write("Add these to [connectors.slack].channels? [Y/n] ");
            const { readSecretLine } = await import("../read-secret.ts");
            const answer = (await readSecretLine(this.context.stdin, stderr)).trim().toLowerCase();
            if (answer !== "" && answer !== "y" && answer !== "yes") {
              stdout.write("aborted — nothing changed.\n");
              return 0;
            }
            if (isInteractiveStdin(this.context.stdin)) stderr.write("\n");
          }
          for (const c of candidates) entries.push({ id: c.id, label: c.displayName });
        }
      }
    }

    if (entries.length === 0) {
      stdout.write("nothing to add.\n");
      return 0;
    }

    const { addSlackChannels } = await import("../slack-channels-edit.ts");
    const { path, text } = await readConfigFile();
    let result: ReturnType<typeof addSlackChannels>;
    try {
      result = addSlackChannels(text, entries);
    } catch (cause) {
      stderr.write(`error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 1;
    }
    if (result.added.length > 0) await Bun.write(path, result.toml);

    for (const id of result.already) {
      stdout.write(`already following: ${id}\n`);
    }
    if (result.added.length === 0) {
      stdout.write("nothing new to add.\n");
      return 0;
    }
    stdout.write(`now following ${result.added.length} channel(s): ${result.added.join(", ")}\n`);
    stdout.write("next: run `suasor slack sync` to ingest them.\n");
    return 0;
  }
}

/** `slack unfollow` — remove channels from the ingest list by name or id. */
export class SlackUnfollowCommand extends Command {
  static override paths = [[SLACK, "unfollow"]];

  static override usage = Command.Usage({
    category: "Slack",
    description: "Remove channels from [connectors.slack].channels by name or id.",
    details: `
      Names resolve **offline** against the local slack_channels projection
      (ADR-0037 — no live fetch; an unsynced name is unknown, pass the id).
      The matching ids are removed surgically from the flat channels list.
      Ingested history is untouched (drop it with 'suasor source forget').
    `,
    examples: [
      ["Unfollow by name", "suasor slack unfollow '#noise'"],
      ["Unfollow by id", "suasor slack unfollow C0123ABCD"],
    ],
  });

  refs = Option.Rest();

  override async execute(): Promise<number> {
    const stdout = this.context.stdout;
    const stderr = this.context.stderr;
    if (this.refs.length === 0) {
      stderr.write("error: pass one or more channel names/ids\n");
      return 1;
    }

    const configured = await configuredChannels(stderr);
    if (configured === null) return 1;

    // Offline name → id resolution via the slack_channels projection.
    const ids: string[] = [];
    const nameRefs = this.refs.filter((r) => !looksLikeId(r));
    for (const id of this.refs.filter((r) => looksLikeId(r))) ids.push(id.trim());
    if (nameRefs.length > 0) {
      const [{ loadConfig }, { Store }] = await Promise.all([
        import("../../config/index.ts"),
        import("../../db/index.ts"),
      ]);
      const config = await loadConfig();
      const dbPath = config.storage.dbPath;
      const rows: { id: string; name: string }[] = [];
      if (dbPath !== null) {
        const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
        try {
          rows.push(
            ...(store.connection.sqlite
              .query("SELECT channel_id AS id, name FROM slack_channels WHERE name <> ''")
              .all() as { id: string; name: string }[]),
          );
        } finally {
          store.close();
        }
      }
      const configuredSet = new Set(configured);
      for (const ref of nameRefs) {
        const bare = ref.trim().replace(/^#/, "");
        // Prefer a configured match so an ambiguous projection name still
        // resolves when only one candidate is actually followed.
        const matches = rows.filter((r) => r.name === bare);
        const inConfig = matches.filter((r) => configuredSet.has(r.id));
        const pick = inConfig.length > 0 ? inConfig : matches;
        if (pick.length === 0) {
          stderr.write(
            `error: no known channel named '${ref}' (names resolve from the local projection — pass the id)\n`,
          );
          return 1;
        }
        if (pick.length > 1) {
          stderr.write(
            `error: '${ref}' is ambiguous — pass the id instead: ${pick.map((r) => r.id).join(", ")}\n`,
          );
          return 1;
        }
        ids.push((pick[0] as { id: string }).id);
      }
    }

    const { removeSlackChannels } = await import("../slack-channels-edit.ts");
    const { path, text } = await readConfigFile();
    let result: ReturnType<typeof removeSlackChannels>;
    try {
      result = removeSlackChannels(text, ids);
    } catch (cause) {
      stderr.write(`error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      return 1;
    }
    if (result.removed.length > 0) await Bun.write(path, result.toml);

    for (const id of result.missing) {
      stdout.write(`not following: ${id}\n`);
    }
    if (result.removed.length === 0) {
      stdout.write("nothing removed.\n");
      return 0;
    }
    stdout.write(`unfollowed ${result.removed.length} channel(s): ${result.removed.join(", ")}\n`);
    stdout.write(
      "note: already-ingested history stays; purge it with `suasor source forget` if needed.\n",
    );
    return 0;
  }
}
