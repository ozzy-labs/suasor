/**
 * `suasor embeddings status|rebuild|drain|find-duplicates` — operator-facing
 * maintenance for the optional embedding layer (ADR-0006, Issue #87).
 *
 * The `[embedding].backend` sidecar populates vec0 during sync, but that layer is
 * otherwise invisible: there is no way to see coverage, force a re-embed after a
 * model swap, retry sources the best-effort ingest path skipped, or find near
 * duplicates. These verbs surface and repair it without leaving the local store.
 *
 * Every verb is a no-op with an explicit message when the backend is disabled —
 * there is nothing to inspect or rebuild until a sidecar is configured. Heavy
 * dependencies (DB layer, config loader, embedding service) are lazy-imported
 * inside `execute` so the command registry stays cheap (NFR-PRF-1).
 */
import { Command, Option } from "clipanion";

/** Message printed by every verb when no embedding backend is configured. */
const DISABLED_MESSAGE =
  "embedding backend is disabled — nothing to do " +
  "(set [embedding].backend to enable; see docs/guide/embedding.md).";

/**
 * Open the store + build the embedder from `[embedding]` config. Returns `null`
 * for a fatal config error (already reported to stderr) so the caller can exit 1,
 * or `{ store, embedder, backend }` where `embedder` is `null` when disabled.
 */
async function openEmbeddingContext(context: { stderr: { write: (s: string) => void } }): Promise<{
  store: import("../../db/index.ts").Store;
  embedder: import("../../retrieval/embedding/index.ts").Embedder | null;
  backend: string;
} | null> {
  const [{ loadConfig }, { Store }, { createEmbedderResolved }] = await Promise.all([
    import("../../config/index.ts"),
    import("../../db/index.ts"),
    import("../../retrieval/embedding/index.ts"),
  ]);
  const config = await loadConfig();
  const dbPath = config.storage.dbPath;
  if (dbPath === null) {
    context.stderr.write("error: storage.dbPath is not configured\n");
    return null;
  }
  const embedder = await createEmbedderResolved(config.embedding);
  const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
  return { store, embedder, backend: config.embedding.backend };
}

export class EmbeddingsStatusCommand extends Command {
  static override paths = [["embeddings", "status"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Show embedding coverage per entity kind (status / drift).",
    details: `
      Reports the active backend / model and, per source kind, how many sources
      are embedded, pending (no vector yet), or stale (embedded under a different
      model). A no-op message is printed when the backend is disabled (ADR-0006).
    `,
    examples: [
      ["Human-readable coverage", "suasor embeddings status"],
      ["Machine-readable", "suasor embeddings status --json"],
    ],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the status snapshot as JSON instead of a table.",
  });

  override async execute(): Promise<number> {
    const ctx = await openEmbeddingContext(this.context);
    if (ctx === null) return 1;
    const { embeddingStatus } = await import("../../retrieval/embedding/index.ts");
    try {
      const status = embeddingStatus(ctx.store.connection.sqlite, ctx.embedder, ctx.backend);
      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return 0;
      }
      const model = status.modelId === null ? "(none)" : status.modelId;
      this.context.stdout.write(
        `backend: ${status.backend}  model: ${model}` +
          `${status.modelVersion ? `@${status.modelVersion}` : ""}  auto: ${status.auto}\n`,
      );
      if (status.kinds.length === 0) {
        this.context.stdout.write("No sources ingested yet.\n");
        return 0;
      }
      for (const k of status.kinds) {
        this.context.stdout.write(
          `  ${k.sourceType}: ${k.embedded}/${k.total} embedded` +
            `, ${k.pending} pending, ${k.stale} stale\n`,
        );
      }
      const t = status.totals;
      this.context.stdout.write(
        `  total: ${t.embedded}/${t.total} embedded, ${t.pending} pending, ${t.stale} stale\n`,
      );
      if (!status.auto) {
        this.context.stdout.write(`${DISABLED_MESSAGE}\n`);
      }
      return 0;
    } finally {
      ctx.store.close();
    }
  }
}

export class EmbeddingsRebuildCommand extends Command {
  static override paths = [["embeddings", "rebuild"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Re-embed sources whose model differs from the active one.",
    details: `
      Re-embeds sources whose stored model differs from (or is missing for) the
      active [embedding] model so a model swap takes hold. With --full every
      source is re-embedded. Best-effort: a sidecar failure is reported as a
      warning and lowers the embedded count (ADR-0006). No-op when disabled.
    `,
    examples: [
      ["Re-embed drifted/missing sources", "suasor embeddings rebuild"],
      ["Re-embed everything", "suasor embeddings rebuild --full"],
    ],
  });

  full = Option.Boolean("--full", false, {
    description: "Re-embed every source regardless of recorded model.",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the rebuild result as JSON.",
  });

  override async execute(): Promise<number> {
    const ctx = await openEmbeddingContext(this.context);
    if (ctx === null) return 1;
    try {
      if (ctx.embedder === null) {
        this.context.stdout.write(`${DISABLED_MESSAGE}\n`);
        return 0;
      }
      const { embeddingRebuild } = await import("../../retrieval/embedding/index.ts");
      const result = await embeddingRebuild(ctx.store.connection.sqlite, ctx.embedder, {
        full: this.full,
      });
      if (this.json) {
        this.context.stdout.write(
          `${JSON.stringify({ candidates: result.candidates, embedded: result.embedded }, null, 2)}\n`,
        );
      } else {
        this.context.stdout.write(
          `Rebuilt ${result.embedded}/${result.candidates} source embedding(s).\n`,
        );
      }
      if (result.error) {
        this.context.stderr.write(`warning: embedding sidecar: ${result.error.message}\n`);
      }
      return 0;
    } finally {
      ctx.store.close();
    }
  }
}

export class EmbeddingsDrainCommand extends Command {
  static override paths = [["embeddings", "drain"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Catch-up embed sources that have no vector yet (pending).",
    details: `
      Embeds sources the best-effort ingest path skipped (sidecar was down) and
      that still have no vector — leaving stale-but-present vectors for rebuild.
      Best-effort: a sidecar failure is reported. No-op when disabled (ADR-0006).
    `,
    examples: [["Drain pending embeddings", "suasor embeddings drain"]],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the drain result as JSON.",
  });

  override async execute(): Promise<number> {
    const ctx = await openEmbeddingContext(this.context);
    if (ctx === null) return 1;
    try {
      if (ctx.embedder === null) {
        this.context.stdout.write(`${DISABLED_MESSAGE}\n`);
        return 0;
      }
      const { embeddingDrain } = await import("../../retrieval/embedding/index.ts");
      const result = await embeddingDrain(ctx.store.connection.sqlite, ctx.embedder);
      if (this.json) {
        this.context.stdout.write(
          `${JSON.stringify({ candidates: result.candidates, embedded: result.embedded }, null, 2)}\n`,
        );
      } else {
        this.context.stdout.write(
          `Drained ${result.embedded}/${result.candidates} pending embedding(s).\n`,
        );
      }
      if (result.error) {
        this.context.stderr.write(`warning: embedding sidecar: ${result.error.message}\n`);
      }
      return 0;
    } finally {
      ctx.store.close();
    }
  }
}

export class EmbeddingsFindDuplicatesCommand extends Command {
  static override paths = [["embeddings", "find-duplicates"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "List near-duplicate source pairs by vector similarity.",
    details: `
      Lists source pairs whose cosine similarity over stored vectors exceeds
      --threshold (default 0.95). Useful for spotting duplicate ingests. No-op
      when the backend is disabled (no vectors to compare) (ADR-0006).
    `,
    examples: [
      ["Default threshold (0.95)", "suasor embeddings find-duplicates"],
      ["Looser threshold", "suasor embeddings find-duplicates --threshold 0.9"],
    ],
  });

  threshold = Option.String("--threshold", {
    description: "Cosine-similarity threshold in (0, 1] (default 0.95).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit duplicate pairs as JSON.",
  });

  override async execute(): Promise<number> {
    const ctx = await openEmbeddingContext(this.context);
    if (ctx === null) return 1;
    try {
      if (ctx.embedder === null) {
        this.context.stdout.write(`${DISABLED_MESSAGE}\n`);
        return 0;
      }
      const { findDuplicates, DEFAULT_DUPLICATE_THRESHOLD } = await import(
        "../../retrieval/embedding/index.ts"
      );
      let threshold = DEFAULT_DUPLICATE_THRESHOLD;
      if (this.threshold !== undefined) {
        const parsed = Number(this.threshold);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
          this.context.stderr.write("error: --threshold must be a number in (0, 1]\n");
          return 1;
        }
        threshold = parsed;
      }
      const pairs = findDuplicates(ctx.store.connection.sqlite, threshold);
      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(pairs, null, 2)}\n`);
        return 0;
      }
      if (pairs.length === 0) {
        this.context.stdout.write(`No near-duplicate pairs above ${threshold}.\n`);
        return 0;
      }
      this.context.stdout.write(`${pairs.length} near-duplicate pair(s) (>= ${threshold}):\n`);
      for (const p of pairs) {
        this.context.stdout.write(`  ${p.a} ~ ${p.b}  (${p.similarity.toFixed(4)})\n`);
      }
      return 0;
    } finally {
      ctx.store.close();
    }
  }
}

export class EmbeddingsListFailedCommand extends Command {
  static override paths = [["embeddings", "list-failed"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "List sources missing a current-model vector (pending / stale).",
    details: `
      Drilldown behind the pending / stale roll-ups of \`embeddings status\`
      (Issue #202): lists the actual sources with no current-model vector so you
      know *which* ones to fix. \`pending\` rows have no vector at all (run
      \`embeddings drain\`); \`stale\` rows were embedded under a different model
      (run \`embeddings rebuild\`). When the backend is disabled every source is
      pending. Use --limit to cap the listing (default 50).
    `,
    examples: [
      ["List failed embeddings", "suasor embeddings list-failed"],
      ["Cap the listing", "suasor embeddings list-failed --limit 10"],
      ["Machine-readable", "suasor embeddings list-failed --json"],
    ],
  });

  limit = Option.String("--limit", {
    description: "Maximum sources to list (positive integer; default 50).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the failed-source list as JSON.",
  });

  override async execute(): Promise<number> {
    let limit = 50;
    if (this.limit !== undefined) {
      const parsed = Number(this.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        this.context.stderr.write("error: --limit must be a positive integer\n");
        return 1;
      }
      limit = parsed;
    }
    const ctx = await openEmbeddingContext(this.context);
    if (ctx === null) return 1;
    try {
      const { listFailedEmbeddings } = await import("../../retrieval/embedding/index.ts");
      const rows = listFailedEmbeddings(
        ctx.store.connection.sqlite,
        ctx.embedder?.model ?? null,
        ctx.embedder?.modelVersion ?? "",
        limit,
      );
      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        this.context.stdout.write("No sources missing a current-model vector.\n");
        return 0;
      }
      this.context.stdout.write(`${rows.length} source(s) missing a current-model vector:\n`);
      for (const r of rows) {
        this.context.stdout.write(`  [${r.reason}] ${r.sourceType}  ${r.externalId}\n`);
      }
      if (!ctx.embedder) {
        this.context.stdout.write(`${DISABLED_MESSAGE}\n`);
      }
      return 0;
    } finally {
      ctx.store.close();
    }
  }
}

/** All embeddings maintenance subcommands, for registration in the CLI. */
export const embeddingsCommands = [
  EmbeddingsStatusCommand,
  EmbeddingsRebuildCommand,
  EmbeddingsDrainCommand,
  EmbeddingsFindDuplicatesCommand,
  EmbeddingsListFailedCommand,
];
