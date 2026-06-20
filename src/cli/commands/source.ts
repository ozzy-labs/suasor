/**
 * `suasor source list` / `suasor source forget` — local data audit + manual
 * purge from the CLI (Issue #200, Epic #185 / Phase 5).
 *
 * These surface two existing capabilities that were previously MCP-only:
 *   - `source list`   — the read query `listSources` (src/mcp/queries.ts), so an
 *     operator can audit what has been ingested without an MCP client.
 *   - `source forget` — the "right to be forgotten" purge `sourceForget`
 *     (src/forget/source-forget.ts, ADR-0026): redact the body from the event
 *     log + delete the projection / FTS / vectors, keeping a body-less audit
 *     event.
 *
 * `list` is read-only (autonomous OK). `forget` is destructive, so it follows
 * the established HITL preview pattern (cf. `slack cursor reset`): without
 * `--yes` it previews the target and does nothing; `--yes` applies (ADR-0004).
 *
 * Privacy (NFR-PRV-4 / Issue #200): neither verb prints source bodies or
 * secrets — `list` shows id / type / observed-at / a short meta hint only.
 *
 * Lazy-import discipline (NFR-PRF-1, docs/design/cli.md): top-level imports stay
 * clipanion-only; the config loader, DB layer, and query/forget services are
 * imported inside `execute`.
 */
import { Command, Option } from "clipanion";

export class SourceListCommand extends Command {
  static override paths = [["source", "list"]];

  static override usage = Command.Usage({
    category: "Sources",
    description: "List ingested sources (local data audit), newest first.",
    details: `
      Lists ingested sources (the projection rows) newest-first by observed_at,
      surfacing the same read query the MCP read tools use (ADR-0026) so an
      operator can audit local data without an MCP client.

      Bodies and secrets are never printed (NFR-PRV-4): each row shows the
      external id, source_type, and observed_at only. Use --json for a
      machine-readable list ({externalId, sourceType, observedAt}[]).

      Filters narrow the set:

      - --type <type>             restrict to one source_type (e.g. github_issue)
      - --since <iso>             inclusive lower bound on observed_at (>=)
      - --until <iso>             exclusive upper bound on observed_at (<)
      - --limit N                 max rows (default 50)
    `,
    examples: [
      ["List recent sources", "suasor source list"],
      ["Restrict to one type", "suasor source list --type github_issue"],
      ["Emit JSON", "suasor source list --json --limit 100"],
      [
        "Audit an observed window",
        "suasor source list --since 2026-06-01T00:00:00Z --until 2026-07-01T00:00:00Z",
      ],
    ],
  });

  type = Option.String("--type", {
    description: "Restrict to a single source_type (e.g. github_issue).",
  });

  since = Option.String("--since", {
    description: "Inclusive lower bound on observed_at (ISO 8601, >=).",
  });

  until = Option.String("--until", {
    description: "Exclusive upper bound on observed_at (ISO 8601, <).",
  });

  limit = Option.String("--limit", { description: "Maximum number of rows (default 50)." });

  json = Option.Boolean("--json", false, {
    description: "Emit results as JSON instead of a human-readable list.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }, { listSources, DEFAULT_LIST_LIMIT }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
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

    const observed =
      this.since !== undefined || this.until !== undefined
        ? {
            ...(this.since !== undefined ? { after: this.since } : {}),
            ...(this.until !== undefined ? { before: this.until } : {}),
          }
        : undefined;

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const sources = listSources(store.connection.sqlite, {
        limit,
        ...(this.type !== undefined ? { sourceType: this.type } : {}),
        ...(observed !== undefined ? { observed } : {}),
      });

      if (this.json) {
        // Body is intentionally omitted (NFR-PRV-4): the audit list never emits
        // source content. Callers needing the body use the MCP source.get tool.
        const rows = sources.map((s) => ({
          externalId: s.externalId,
          sourceType: s.sourceType,
          observedAt: s.observedAt,
        }));
        this.context.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }

      if (sources.length === 0) {
        this.context.stdout.write("No sources.\n");
        return 0;
      }

      this.context.stdout.write(`${sources.length} source(s):\n`);
      for (const s of sources) {
        this.context.stdout.write(`  ${s.externalId} (${s.sourceType}) — ${s.observedAt}\n`);
      }
      return 0;
    } finally {
      store.close();
    }
  }
}

export class SourceForgetCommand extends Command {
  static override paths = [["source", "forget"]];

  static override usage = Command.Usage({
    category: "Sources",
    description: "Forget (purge) an ingested source locally (destructive; requires --yes).",
    details: `
      Suasor's local "right to be forgotten" (ADR-0026): redacts the source body
      from the event log AND deletes it from the projection / FTS / vectors,
      keeping a body-less audit event. Use it for manual data minimisation /
      privacy purges without an MCP client.

      Destructive, so it follows the HITL preview pattern: without --yes it
      previews the target and applies nothing; re-run with --yes to apply
      (ADR-0004 — no auto-apply). The source body is never printed.

      Idempotent: re-forgetting a purged id reports 'already forgotten'; an id
      that was never ingested reports 'missing' and exits non-zero so a typo is
      not silently treated as success.
    `,
    examples: [
      ["Preview the purge", "suasor source forget gh:owner/repo#1"],
      ["Apply the purge", "suasor source forget gh:owner/repo#1 --yes"],
      [
        "Apply with an audit reason",
        'suasor source forget gh:owner/repo#1 --reason "GDPR request" --yes',
      ],
    ],
  });

  externalId = Option.String();

  reason = Option.String("--reason", {
    description: "Optional human reason recorded on the audit event.",
  });

  yes = Option.Boolean("--yes", false, {
    description: "Apply the purge (without it the target is previewed only).",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }, { getSource, listSourceHistory }, { sourceForget }] =
      await Promise.all([
        import("../../config/index.ts"),
        import("../../db/index.ts"),
        import("../../mcp/queries.ts"),
        import("../../forget/source-forget.ts"),
      ]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      // Preview: confirm the id exists (a present row, or — when already purged —
      // a body version in the log) before either previewing or applying, so an
      // unknown id fails fast either way. Bodies are not printed (NFR-PRV-4).
      const present = getSource(store.connection.sqlite, this.externalId);
      const known =
        present !== null || listSourceHistory(store.connection.sqlite, this.externalId).length > 0;

      if (!this.yes) {
        if (!known) {
          this.context.stderr.write(`error: no source with external id '${this.externalId}'\n`);
          return 1;
        }
        const typeHint = present !== null ? ` (${present.sourceType})` : "";
        this.context.stdout.write(`would forget: ${this.externalId}${typeHint}\n`);
        this.context.stdout.write("(preview — re-run with --yes to apply)\n");
        return 0;
      }

      const result = sourceForget(store, {
        externalId: this.externalId,
        ...(this.reason !== undefined ? { reason: this.reason } : {}),
      });

      switch (result.status) {
        case "forgotten":
          this.context.stdout.write(`forgotten: ${this.externalId}\n`);
          return 0;
        case "already_forgotten":
          this.context.stdout.write(`already forgotten: ${this.externalId}\n`);
          return 0;
        case "missing":
          this.context.stderr.write(`error: no source with external id '${this.externalId}'\n`);
          return 1;
      }
    } finally {
      store.close();
    }
  }
}
