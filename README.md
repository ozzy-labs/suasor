# Suasor

**Gathers, remembers, advises - you decide.**

Suasor is a local-first AI secretary. It gathers your scattered work context - chat, email, calendar, documents, code, the web - into private memory on your own machine, so you and your AI agents can search and summarize it over MCP. It advises you, and proposes replies, tasks, and decisions. Nothing is sent or saved without your approval.

[日本語 / Japanese →](README.ja.md)

## What it does

- **Gathers** — pulls your scattered work context from across your tools into one local, private store. Read-only: it never writes back to your sources.
- **Remembers** — keeps it as searchable, queryable memory on your own machine.
- **Advises** — surfaces, summarizes, and proposes replies, tasks, and decisions over MCP. You and your AI agents query it; you approve everything. Nothing is sent or saved without your say.

## Status

Early development. Suasor is being built spec-first.

## Install

Distributed via four channels (released manually — see [docs/guide/install.md](docs/guide/install.md)):

- **npm** — `bunx @ozzylabs/suasor mcp serve` (or `bun add -g @ozzylabs/suasor`). Canonical; OIDC-published with provenance.
- **Standalone binary** — download per OS/arch from [Releases](https://github.com/ozzy-labs/suasor/releases). Core + a few native bits; the heavier connector SDKs are external (use npm/Docker for the full connector set).
- **Docker (batteries-included + Ollama)** — `docker run ghcr.io/ozzy-labs/suasor`. Local embedding with no external egress.
- **MCP registry** — discoverable via [`server.json`](server.json).

> Until the first release is published, run from source with the Quickstart below.

## Quickstart (provisional)

> Early development, but every CLI command below is implemented (ingest, retrieval, MCP server, and skills all work). The only not-yet-shipped pieces are the `brief` / `graph.related` MCP tools — see [docs/design/mcp-surface.md](docs/design/mcp-surface.md). Requires [Bun](https://bun.sh) 1.1+.

```bash
bun install            # install dependencies
bun run src/index.ts --version

# First-run setup: writes ~/.config/suasor/config.toml and the local SQLite store.
bun run src/index.ts init

# Ingest read-only from a connector (github / slack / ms-graph / google / box / web).
bun run src/index.ts github sync

# Full-text search over ingested sources (FTS5; --json / --limit available).
bun run src/index.ts search "<query>"

# Install the bundled assistant skills into your agent host(s).
bun run src/index.ts skills install        # .claude/skills/ + .agents/skills/
bun run src/index.ts skills list           # installed / missing / modified

# Maintenance.
bun run src/index.ts db migrate            # apply the projection schema (idempotent)
bun run src/index.ts projections rebuild   # replay the event log into projections
```

Config lives in `~/.config/suasor/` (override with `SUASOR_CONFIG_DIR`). `<connector> sync` ingests read-only from github / slack / ms-graph / google / box / web — see [docs/guide/connectors.md](docs/guide/connectors.md) for per-connector setup. See [docs/design/cli.md](docs/design/cli.md) for the full command/flag reference and [docs/skills/README.md](docs/skills/README.md) for the assistant skills.

## Connect an agent host (MCP)

Suasor exposes its memory to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io) (stdio transport). The server is the agent boundary. **Read** tools — `search`, `recall.search`, `source.list` / `source.get`, and `task.list` / `decision.list` / `inbox.list` — are side-effect-free and annotated read-only so hosts may auto-approve them. **Write** tools — `connector.sync`, `propose.generate`, `propose.apply`, `task.create` — ship today but stay behind human-in-the-loop approval (ADR-0004); nothing is applied or sent without your say.

```bash
bun run src/index.ts mcp serve   # start the MCP server over stdio
```

Register it with an MCP host (Claude Code, Claude Desktop, Codex CLI, …). For Claude Desktop, add to `claude_desktop_config.json`:

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

Semantic search (`recall.search`) returns an `embedding_disabled` signal until you enable an embedding backend, so hosts gracefully fall back to FTS `search` (ADR-0005). See [docs/design/mcp-surface.md](docs/design/mcp-surface.md) for the tool schemas.

## License

MIT
