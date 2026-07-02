/**
 * `suasor init` — first-run setup: config + DB initialization (+ skills).
 *
 * Idempotently prepares a local install:
 * 1. Ensures the config directory exists and seeds a minimal `config.toml`
 *    when absent (existing config is never overwritten).
 * 2. Opens the configured database, which creates the event store, projection
 *    tables, and FTS5 index (ADR-0002 / ADR-0005).
 *
 * On success it prints a multi-step next-steps guide (doctor -> guided
 * `onboard` -> first `sync` -> optional skills) so users can follow the primary
 * journey without reading the docs first. `onboard` (ADR-0029) is the first-class
 * setup path — the manual per-connector route is kept as a fallback pointer.
 *
 * Doc pointers are emitted as resolvable GitHub URLs ({@link docsUrl}) because
 * `docs/guide` is not shipped with the npm / binary / Docker channels.
 *
 * Assistant-skill installation is a separate, explicit step
 * (`suasor skills install`, ADR-0008); `init` points at it rather than running
 * it implicitly.
 *
 * Heavy dependencies (config loader, DB layer, fs) are lazy-imported inside
 * `execute` to keep cold start light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command, Option } from "clipanion";
import { docsUrl } from "../doc-ref.ts";

const DEFAULT_CONFIG_TOML = `# Suasor configuration (docs/design/config.md).
# Precedence: init args > env (SUASOR_*) > this file > defaults.

[storage]
# dbPath = "/absolute/path/to/suasor.db"   # default: <configDir>/suasor.db

[embedding]
backend = "disabled"   # disabled | ollama | openai | voyage
# baseUrl = "http://localhost:11434"   # ollama sidecar (/api/embed is appended)
# model = "bge-m3"                      # embedding model; identical for ingest & query
# dim = 1024                            # embedding dim; MUST match the model AND the existing
#                                       #   DB's vec0 width (sized at DB creation). Per backend:
#                                       #   ollama bge-m3=1024, openai text-embedding-3-small=1536,
#                                       #   voyage voyage-3=1024. A mismatch silently breaks recall;
#                                       #   changing it needs a fresh DB / re-sync (run \`suasor
#                                       #   validate-config\` / \`suasor doctor\` to detect drift).
# maxBatch = 64                         # max texts per request; larger inputs split in order
# requestTimeoutMs = 60000              # per-request timeout (ms); 0 disables
# maxRetries = 3                        # 429/5xx retry attempts incl. first; 1 disables

[llm]
# NOTE: [llm].backend is accepted by the schema but NOT read by the runtime today
#   — inference is delegated to the host LLM (ADR-0006). Setting it has no effect
#   beyond a startup warning; it is reserved for a future on-box inference path.
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

      On success it prints a multi-step next-steps guide (doctor -> guided
      onboard -> first sync -> optional skills).

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

    // Point users at the real first-run journey. `onboard` (ADR-0029) is the
    // first-class setup path — it drives connector choice, token storage, the
    // [connectors.X] config slice, and the first sync — so the manual per-connector
    // route is kept only as a fallback pointer. Doc pointers are resolvable URLs
    // (docs/guide is not shipped with the npm / binary / Docker channels).
    this.context.stdout.write(
      [
        "",
        "Next steps:",
        "  1. suasor doctor           # verify config / DB / connector readiness",
        "  2. suasor onboard          # guided setup: connector, token, config, first sync",
        `     …or configure by hand:  ${docsUrl("guide/connectors.md")}`,
        `  3. suasor sync             # re-ingest any time; schedule it: ${docsUrl("guide/scheduling.md")}`,
        "  4. suasor skills install   # optional: assistant skills + MCP host registration",
        "",
      ].join("\n"),
    );
    return 0;
  }
}
