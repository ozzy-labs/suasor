/**
 * `suasor projections rebuild` — replay events to reconstruct projections.
 *
 * Heavy dependencies (DB layer, config loader) are imported lazily inside
 * `execute` so the CLI cold start stays light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command, Option } from "clipanion";
import { SuasorCommand } from "../base-command.ts";
import { createProgress } from "../progress.ts";

export class ProjectionsRebuildCommand extends SuasorCommand {
  static override paths = [["projections", "rebuild"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Rebuild read-model projections by replaying the event store.",
    details: `
      Truncates all projection tables and replays the append-only event log to
      reconstruct them (ADR-0002 / FR-MNT-1). The event store is never modified.

      The embedding sidecar (vec0 vectors + their embeddings_meta provenance) is
      NOT replayable — it comes from the delegated embedder (ADR-0006) — so it is
      cleared and left in an honest "all pending" state (ADR-0005 §5). When
      vectors were present, semantic recall is empty until you run
      \`suasor embeddings drain\` to re-embed; the command prints a reminder.
    `,
    examples: [["Rebuild projections", "suasor projections rebuild"]],
  });

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

    // Indeterminate "N processed" on stderr while the replay runs (TTY-gated; a
    // no-op in CI / pipes so stdout stays clean). Replaying a large event log is
    // O(events) and otherwise silent until the final summary — opshub ADR-0026
    // parity, mirroring `<connector> sync`.
    const progress = createProgress(
      this.context.stderr,
      "projections rebuild",
      this.noProgress ? false : undefined,
    );

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const result = store.rebuild({ onProgress: () => progress.tick() });
      progress.finish();
      this.context.stdout.write(`Rebuilt projections from ${result.events} event(s).\n`);
      // The embedding sidecar is not replayable (ADR-0006), so rebuild left it
      // empty. When vectors were actually cleared, semantic recall is now empty
      // until they are re-embedded — point the operator at the one-shot recovery
      // (`embeddings drain`) instead of leaving it silently broken (ADR-0005 §5).
      if (result.clearedEmbeddings > 0) {
        this.context.stdout.write(
          `${result.clearedEmbeddings} embedding vector(s) cleared; semantic recall is empty until you run ` +
            "`suasor embeddings drain` to re-embed (ADR-0005 §5).\n",
        );
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
