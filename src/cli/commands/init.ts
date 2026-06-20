/**
 * `suasor init` — first-run setup: config + DB initialization (+ skills).
 *
 * Idempotently prepares a local install:
 * 1. Ensures the config directory exists and seeds a minimal `config.toml`
 *    when absent (existing config is never overwritten).
 * 2. Opens the configured database, which creates the event store, projection
 *    tables, and FTS5 index (ADR-0002 / ADR-0005).
 *
 * On success it prints a multi-step next-steps guide (doctor -> connector
 * setup -> first `sync` -> periodic scheduling -> optional skills) so users can
 * follow the primary journey without reading the docs first.
 *
 * Assistant-skill installation is a separate, explicit step
 * (`suasor skills install`, ADR-0008); `init` points at it rather than running
 * it implicitly.
 *
 * Heavy dependencies (config loader, DB layer, fs) are lazy-imported inside
 * `execute` to keep cold start light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command, Option } from "clipanion";

const DEFAULT_CONFIG_TOML = `# Suasor configuration (docs/design/config.md).
# Precedence: init args > env (SUASOR_*) > this file > defaults.

[storage]
# dbPath = "/absolute/path/to/suasor.db"   # default: <configDir>/suasor.db

[embedding]
backend = "disabled"   # disabled | ollama | openai | voyage
# baseUrl = "http://localhost:11434"   # ollama sidecar (/api/embed is appended)
# model = "bge-m3"                      # embedding model; identical for ingest & query
# dim = 1024                            # embedding dim; must match the model (bge-m3=1024)

[llm]
backend = "disabled"   # disabled | anthropic | openai | ollama

[extraction]
backend = "disabled"   # disabled | markitdown — Office/PDF body extraction sidecar (ADR-0024)
# baseUrl = "http://localhost:8929"   # markitdown sidecar (/extract is appended)
# maxBytes = 5000000                  # cap on extracted text; larger inputs stay name-only
# version = "1"                       # extractor version; bump to re-extract on next sync

[export]
# dir = "/absolute/path/to/exports"  # draft.export sandbox (default: <configDir>/exports);
                                      # must NOT be under a [connectors.local] root (ADR-0025)

[export.composition]
backend = "disabled"   # disabled | pandoc — md->Office (docx/pptx/xlsx) sidecar (#138)
# baseUrl = "http://localhost:8930"   # pandoc sidecar (/compose is appended)
`;

export class InitCommand extends Command {
  static override paths = [["init"]];

  static override usage = Command.Usage({
    category: "Setup",
    description: "Initialize config and the local database (first-run setup).",
    details: `
      Creates the config directory and a default config.toml (if missing), then
      initializes the local SQLite store (event log + projections + FTS index).
      Safe to re-run: existing config is preserved and schema DDL is idempotent.

      On success it prints a multi-step next-steps guide (doctor -> connector
      setup -> first sync -> periodic scheduling -> optional skills).

      Assistant skills are installed separately with \`suasor skills install\`
      (ADR-0008); this command points at that step rather than running it.
    `,
    examples: [["Initialize a fresh install", "suasor init"]],
  });

  force = Option.Boolean("--force", false, {
    description: "Overwrite an existing config.toml with the default template.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig, resolveConfigDir }, { openDatabase }, { mkdir }, { join }] =
      await Promise.all([
        import("../../config/index.ts"),
        import("../../db/index.ts"),
        import("node:fs/promises"),
        import("node:path"),
      ]);

    const configDir = resolveConfigDir(process.env);
    await mkdir(configDir, { recursive: true });

    const configPath = join(configDir, "config.toml");
    const configFile = Bun.file(configPath);
    const configExists = await configFile.exists();
    if (!configExists || this.force) {
      await Bun.write(configPath, DEFAULT_CONFIG_TOML);
      this.context.stdout.write(
        `${configExists ? "Overwrote" : "Wrote"} default config: ${configPath}\n`,
      );
    } else {
      this.context.stdout.write(`Config already exists: ${configPath}\n`);
    }

    // Validate the resolved config and initialize the database.
    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }
    const db = openDatabase({ path: dbPath, embeddingDim: config.embedding.dim });
    db.close();
    this.context.stdout.write(`Initialized database: ${dbPath}\n`);

    // Point users at the real first-run journey rather than a single skills hint:
    // verify -> configure a connector -> first ingest -> schedule -> optional skills.
    this.context.stdout.write(
      [
        "",
        "Next steps:",
        "  1. suasor doctor                  # verify config / DB / connector readiness",
        "  2. configure a connector          # docs/guide/connectors.md (github / slack / google / …)",
        "  3. suasor sync                    # first read-only ingest from enabled connectors",
        "  4. schedule periodic sync         # cron / launchd / systemd — docs/guide/scheduling.md",
        "  5. suasor skills install          # optional: assistant skills + MCP host registration",
        "",
      ].join("\n"),
    );
    return 0;
  }
}
