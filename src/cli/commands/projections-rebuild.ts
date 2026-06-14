/**
 * `suasor projections rebuild` — replay events to reconstruct projections.
 *
 * Heavy dependencies (DB layer, config loader) are imported lazily inside
 * `execute` so the CLI cold start stays light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command } from "clipanion";

export class ProjectionsRebuildCommand extends Command {
  static override paths = [["projections", "rebuild"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Rebuild read-model projections by replaying the event store.",
    details: `
      Truncates all projection tables and replays the append-only event log to
      reconstruct them (ADR-0002 / FR-MNT-1). The event store is never modified.
    `,
    examples: [["Rebuild projections", "suasor projections rebuild"]],
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

    const store = Store.open({ path: dbPath });
    try {
      const result = store.rebuild();
      this.context.stdout.write(`Rebuilt projections from ${result.events} event(s).\n`);
      return 0;
    } finally {
      store.close();
    }
  }
}
