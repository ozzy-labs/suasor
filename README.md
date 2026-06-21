# Suasor

**Gathers, remembers, advises - you decide.**

Suasor is a local-first AI secretary. It gathers your scattered work context - chat, email, calendar, documents, code, the web - into private memory on your own machine, so you and your AI agents can search and summarize it over MCP. It advises you, and proposes replies, tasks, and decisions. Nothing is sent or saved without your approval.

[日本語 / Japanese →](README.ja.md)

## What it does

- **Gathers** — pulls your scattered work context from across your tools into one local, private store. Read-only: it never writes back to your sources.
- **Remembers** — keeps it as searchable, queryable memory on your own machine.
- **Advises** — surfaces, summarizes, and proposes replies, tasks, and decisions over MCP. You and your AI agents query it; you approve everything. Nothing is sent or saved without your say.

## Status

Early development — **published** on npm / standalone binaries / Docker. Built spec-first.

## Install

Suasor is an MCP server — an *application*, not a library — so it runs on its own runtime, **Bun**. Pick a channel by whether you already use Bun; the binary and Docker image need **no runtime at all** (Bun is bundled). Details: [docs/guide/install.md](docs/guide/install.md).

- **Standalone binary** *(no runtime needed)* — download per OS/arch from [Releases](https://github.com/ozzy-labs/suasor/releases). Bun is compiled in. Core + a few native bits; the heavier connector SDKs are external (use npm/Docker for the full connector set).
- **Docker (batteries-included + Ollama)** *(no runtime needed)* — `docker run ghcr.io/ozzy-labs/suasor`. Local embedding with no external egress.
- **npm — for Bun users** — `bunx @ozzylabs/suasor mcp serve` (or `bun add -g @ozzylabs/suasor`). Requires **Bun ≥ 1.1** ([install Bun](https://bun.sh)) — uses `bun:sqlite`, so `npx`/Node won't run it; pnpm/npm can fetch it but Bun runs it. OIDC-published with provenance.
- **MCP registry** — discoverable via [`server.json`](server.json).

> Published on npm / binaries / Docker. Contributors can also run [from source](#from-source).

## Quickstart (provisional)

> Early development, but every CLI command below is implemented (ingest, retrieval, MCP server, and skills all work), and the MCP surface — including `brief` and `graph.related` / `graph.expand` — is shipped. See [docs/design/mcp-surface.md](docs/design/mcp-surface.md).

These commands assume Suasor is **installed** via one of the channels above, so `suasor` is on your `PATH`. Pick the form that matches your install:

| Install channel | Run the CLI as |
| --- | --- |
| Standalone binary | `suasor <cmd>` |
| npm (Bun users) | `suasor <cmd>` (global install) or `bunx @ozzylabs/suasor <cmd>` |
| Docker | `docker run --rm -v suasor-data:/data ghcr.io/ozzy-labs/suasor:latest <cmd>` |

The examples below use the `suasor <cmd>` form. Working from a clone instead? See [From source](#from-source).

```bash
suasor --version

# First-run setup: writes ~/.config/suasor/config.toml and the local SQLite store.
# Prints a multi-step next-steps guide (doctor -> connector -> sync -> schedule -> skills).
suasor init

# Guided setup: pick connector(s), store tokens, wire the [connectors.X] config
# slice (enabled = true), run the first sync, and print the scheduler + MCP
# snippets — all in the correct order (ADR-0029).
suasor onboard --connector github   # interactive on a TTY; --json for a summary

# Verify config / DB / connector readiness (diagnostic only; creates nothing).
suasor doctor

# Ingest read-only from a connector (github / slack / ms-graph / google / box / web / local).
suasor github sync

# Or ingest from every enabled connector in one read-only pass (one-shot).
suasor sync                   # --connector a,b / --json available

# Full-text search over ingested sources (FTS5; --json / --limit available).
suasor search "<query>"

# Install the bundled assistant skills into your agent host(s).
suasor skills install        # .claude/skills/ + .agents/skills/
suasor skills list           # installed / missing / modified

# Maintenance.
suasor db migrate            # apply the projection schema (idempotent)
suasor projections rebuild   # replay the event log into projections
suasor export backup         # consistent store backup (--format sqlite|tgz)
suasor config edit           # edit config.toml in $EDITOR, validate on save
suasor validate-config       # check config.toml (--fix applies safe repairs)
```

Config lives in `~/.config/suasor/` (override with `SUASOR_CONFIG_DIR`). Edit it with `suasor config edit` (validates on save, rolls back a bad edit) and check it with `suasor validate-config [--fix]`. `<connector> sync` ingests read-only from github / slack / ms-graph / google / box / web / local — see [docs/guide/connectors.md](docs/guide/connectors.md) for per-connector setup. Back up your local store with `suasor export backup` and audit / purge ingested data with `suasor source list` / `suasor source forget` — see [docs/guide/data-audit.md](docs/guide/data-audit.md). Diagnose common failure modes (empty sync, recall returning nothing, dimension mismatch, rate limits) with [docs/guide/troubleshooting.md](docs/guide/troubleshooting.md). See [docs/design/cli.md](docs/design/cli.md) for the full command/flag reference and [docs/skills/README.md](docs/skills/README.md) for the assistant skills.

### From source

Contributors and anyone running from a clone use Bun directly — `bun run src/index.ts` replaces `suasor` in every command above. Requires [Bun](https://bun.sh) 1.1+.

```bash
git clone https://github.com/ozzy-labs/suasor.git
cd suasor
bun install                          # install dependencies
bun run src/index.ts --version

bun run src/index.ts init            # same first-run setup as `suasor init`
bun run src/index.ts doctor          # same diagnostics as `suasor doctor`
bun run src/index.ts sync            # same bulk ingest as `suasor sync`
```

`bun run dev` is a shorthand for `bun run src/index.ts`. See [AGENTS.md](AGENTS.md) for the development and verification workflow (`bun test` / `bun run typecheck` / lint). CI (`.github/workflows/ci.yaml`) is the source of truth for quality gates: typecheck + test (with coverage) + build, Biome + markdownlint, and security scans (gitleaks / Trivy / actionlint) — so PRs that bypass local hooks are still guarded.

### Periodic sync

`suasor sync` ingests from every enabled connector in one short-lived, idempotent pass (read-only, continue-on-error, exit 1 if any connector failed). Suasor runs no daemon — schedule it with your OS scheduler (cron / launchd / systemd timer):

```cron
# Hourly bulk sync via cron; gate on the exit code, log the JSON output.
15 * * * * suasor sync --json >> "$HOME/.local/state/suasor/sync.log" 2>&1
```

See [docs/guide/scheduling.md](docs/guide/scheduling.md) for launchd / systemd timer examples and failure monitoring ([ADR-0027](docs/adr/0027-bulk-sync-orchestration.md)).

## Connect an agent host (MCP)

Suasor exposes its memory to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io) (stdio transport). The server is the agent boundary. **Read** tools — `search`, `recall.search`, `source.list` / `source.get`, and `task.list` / `decision.list` / `inbox.list` — are side-effect-free and annotated read-only so hosts may auto-approve them. **Write** tools — `connector.sync`, `propose.generate`, `propose.apply`, `task.create` — ship today but stay behind human-in-the-loop approval (ADR-0004); nothing is applied or sent without your say.

```bash
suasor mcp serve                 # start the MCP server over stdio
# from source: bun run src/index.ts mcp serve
```

Register it with an MCP host (Claude Code, Claude Desktop, Codex CLI, …). For Claude Desktop, add to `claude_desktop_config.json`. With a global install (`bun add -g @ozzylabs/suasor`, so `suasor` is on `PATH` and resolves to Bun):

```jsonc
{
  "mcpServers": {
    "suasor": {
      "command": "suasor",
      "args": ["mcp", "serve"]
    }
  }
}
```

No Bun on the host? Point it at the Docker image instead (no runtime needed):

```jsonc
{
  "mcpServers": {
    "suasor": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-v", "suasor-data:/data", "ghcr.io/ozzy-labs/suasor:latest"]
    }
  }
}
```

Semantic search (`recall.search`) returns an `embedding_disabled` signal until you enable an embedding backend, so hosts gracefully fall back to FTS `search` (ADR-0005). See [docs/design/mcp-surface.md](docs/design/mcp-surface.md) for the tool schemas.

## License

MIT
