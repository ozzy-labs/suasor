/**
 * `suasor extraction status [--json]` / `extraction list-pending [--limit N]` /
 * `extraction serve` — document-extraction coverage + drilldown + the reference
 * sidecar (ADR-0024, Issue #202 / #439).
 *
 * `status` reports the configured backend / version and, from the
 * `extraction_meta` sidecar, how many sources are extracted / unsupported /
 * too-large / stale (version drift → re-extract next sync) / pending
 * (extractable, never attempted). `list-pending` is the drilldown: the actual
 * sources awaiting (re)extraction. `serve` runs the shipped extraction sidecar
 * (a markitdown-CLI shim) so an install no longer has to author its own HTTP
 * wrapper (retrieval-4). Read-only apart from `serve`'s subprocess spawns. Heavy
 * deps (config loader, DB layer, maintenance, server) are lazy-imported inside
 * `execute` (NFR-PRF-1).
 */
import { Command, Option } from "clipanion";
import { docsUrl } from "../doc-ref.ts";

export class ExtractionStatusCommand extends Command {
  static override paths = [["extraction", "status"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Show document-extraction coverage (extracted / stale / pending).",
    details: `
      Reports the active [extraction] backend / version and per-state counts from
      the extraction_meta sidecar (ADR-0024): extracted, truncated (text cut at
      [extraction].maxTextChars), unsupported, too-large,
      stale (recorded version differs → re-extracted on the next sync), and
      pending (extractable sources never attempted, e.g. extraction newly
      enabled — run the owning connector's sync, e.g. \`suasor local sync\` /
      \`suasor box sync\`, to backfill). Use --json for machine output.
    `,
    examples: [
      ["Human-readable coverage", "suasor extraction status"],
      ["Machine-readable", "suasor extraction status --json"],
    ],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the status snapshot as JSON instead of a table.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }, { extractionStatus }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../extraction/index.ts"),
    ]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const status = extractionStatus(store.connection.sqlite, {
        backend: config.extraction.backend,
        version: config.extraction.version,
      });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return 0;
      }

      const t = status.totals;
      this.context.stdout.write(
        `extraction: backend=${status.backend} version=${status.version}\n`,
      );
      this.context.stdout.write(
        `  extracted: ${t.extracted}  truncated: ${t.truncated}  stale: ${t.stale}  ` +
          `pending: ${t.pending}  unsupported: ${t.unsupported}  too-large: ${t.tooLarge}\n`,
      );
      if (status.backend === "disabled") {
        this.context.stdout.write(
          "  backend disabled — Office/PDF stay name-only. Start the bundled sidecar with " +
            '`suasor extraction serve` and set [extraction].backend = "markitdown" ' +
            `(see ${docsUrl("guide/extraction.md")})\n`,
        );
      } else if (t.pending > 0 || t.stale > 0) {
        this.context.stdout.write(
          "  run the owning connector's sync (e.g. `suasor local sync` / `suasor box sync` / `suasor google sync`) " +
            "to (re)extract pending / stale sources\n",
        );
      }
      return 0;
    } finally {
      store.close();
    }
  }
}

export class ExtractionListPendingCommand extends Command {
  static override paths = [["extraction", "list-pending"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "List sources awaiting (re)extraction (pending / stale).",
    details: `
      Drilldown behind the pending / stale roll-ups of \`extraction status\`
      (Issue #202): lists the actual sources awaiting (re)extraction (local_file /
      box_file / google_drive). \`pending\` rows are extractable but never attempted; \`stale\`
      rows were extracted under a different version (drift). Run the owning
      connector's sync (e.g. \`suasor local sync\` / \`suasor box sync\` / \`suasor google sync\`) to
      backfill them. Use --limit to cap the listing (default 50).
    `,
    examples: [
      ["List pending extractions", "suasor extraction list-pending"],
      ["Cap the listing", "suasor extraction list-pending --limit 10"],
      ["Machine-readable", "suasor extraction list-pending --json"],
    ],
  });

  limit = Option.String("--limit", {
    description: "Maximum sources to list (positive integer; default 50).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the pending-source list as JSON.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }, { listPendingExtractions }, { DEFAULT_LIST_LIMIT }] =
      await Promise.all([
        import("../../config/index.ts"),
        import("../../db/index.ts"),
        import("../../extraction/index.ts"),
        import("../../mcp/queries.ts"),
      ]);

    let limit = DEFAULT_LIST_LIMIT;
    if (this.limit !== undefined) {
      const parsed = Number(this.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        this.context.stderr.write("error: --limit must be a positive integer\n");
        return 1;
      }
      limit = parsed;
    }

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const rows = listPendingExtractions(
        store.connection.sqlite,
        { version: config.extraction.version },
        limit,
      );
      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        this.context.stdout.write("No sources awaiting (re)extraction.\n");
        return 0;
      }
      this.context.stdout.write(`${rows.length} source(s) awaiting (re)extraction:\n`);
      for (const r of rows) {
        this.context.stdout.write(`  [${r.reason}] ${r.name}  ${r.externalId}\n`);
      }
      if (config.extraction.backend === "disabled") {
        this.context.stdout.write(
          "  backend disabled — start the bundled sidecar with `suasor extraction serve` and set " +
            `[extraction].backend = "markitdown" to extract (see ${docsUrl("guide/extraction.md")})\n`,
        );
      } else {
        this.context.stdout.write(
          "  run the owning connector's sync (e.g. `suasor local sync` / `suasor box sync` / `suasor google sync`) " +
            "to (re)extract these sources\n",
        );
      }
      return 0;
    } finally {
      store.close();
    }
  }
}

export class ExtractionServeCommand extends Command {
  static override paths = [["extraction", "serve"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Run the bundled document-extraction sidecar (markitdown shim).",
    details: `
      Starts the reference extraction sidecar that implements the extraction
      contract (POST /extract, ADR-0024): a thin HTTP shim that spawns the
      markitdown CLI once per request to convert Office/PDF bytes to Markdown. All
      ML runs in the markitdown subprocess — Suasor holds no in-process parser
      (ADR-0006). Point [extraction].backend = "markitdown" at this sidecar and it
      powers search / semantic recall / find over document bodies (Issue #439).

      Binds to the host/port from [extraction].baseUrl by default
      (http://localhost:8929); override with --host / --port. Requires the
      markitdown CLI on PATH (\`uv tool install 'markitdown[all]'\`) — it exits with
      install guidance when absent. The process blocks until interrupted (Ctrl-C).
    `,
    examples: [
      ["Start the sidecar (default localhost:8929)", "suasor extraction serve"],
      ["Bind a custom port", "suasor extraction serve --port 9000"],
      ["Use a specific markitdown binary", "suasor extraction serve --command /opt/bin/markitdown"],
    ],
  });

  host = Option.String("--host", {
    description: "Bind host (default: the host from [extraction].baseUrl).",
  });

  port = Option.String("--port", {
    description: "Bind port 1-65535 (default: the port from [extraction].baseUrl).",
  });

  command = Option.String("--command", {
    description: "markitdown executable to spawn (default: markitdown).",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, serve] = await Promise.all([
      import("../../config/index.ts"),
      import("../../extraction/serve.ts"),
    ]);

    const config = await loadConfig();
    const address = serve.resolveServeAddress(config.extraction.baseUrl, this.host, this.port);
    if ("error" in address) {
      this.context.stderr.write(`error: ${address.error}\n`);
      return 1;
    }

    const command = this.command ?? serve.DEFAULT_MARKITDOWN_COMMAND;

    // Preflight: fail fast with structured install guidance rather than serving a
    // sidecar that 503s on every request (Issue #439).
    if (!(await serve.probeMarkitdown({ command }))) {
      const hint = serve.MARKITDOWN_INSTALL_HINT;
      this.context.stderr.write(`error: ${hint.message} (command: ${command})\n`);
      this.context.stderr.write("install one of:\n");
      for (const step of hint.install) this.context.stderr.write(`  ${step}\n`);
      this.context.stderr.write(`docs: ${hint.docs}\n`);
      return 1;
    }

    const server = serve.startExtractionServer({
      host: address.host,
      port: address.port,
      deps: { command, log: (m) => this.context.stderr.write(`${m}\n`) },
    });
    this.context.stdout.write(
      `suasor extraction serve: listening on ${server.url} (POST /extract) — markitdown='${command}'\n`,
    );
    this.context.stdout.write("Press Ctrl-C to stop.\n");

    await new Promise<void>((resolvePromise) => {
      const shutdown = () => {
        server.stop();
        resolvePromise();
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
    return 0;
  }
}
