# Suasor

**Gathers, remembers, advises - you decide.**

Suasor is a local-first AI secretary. It gathers your scattered work context - chat, email, calendar, documents, code, the web - into private memory on your own machine, so you and your AI agents can search and summarize it over MCP. It advises you, and proposes replies, tasks, and decisions. Nothing is sent or saved without your approval.

[日本語 / Japanese →](README.ja.md)

## What it does

- **Gathers** — pulls your scattered work context from across your tools into one local, private store. Read-only: it never writes back to your sources.
- **Remembers** — keeps it as searchable, queryable memory on your own machine.
- **Advises** — surfaces, summarizes, and proposes replies, tasks, and decisions over MCP. You and your AI agents query it; you approve everything. Nothing is sent or saved without your say.

## Status

Early development. Suasor is being built spec-first. It will be distributed via npm (`@ozzylabs/suasor`), a standalone single binary, and a batteries-included Docker image.

## Quickstart (provisional)

> Early development — the command surface is wired but several commands are stubs (see notes). Requires [Bun](https://bun.sh) 1.1+.

```bash
bun install            # install dependencies
bun run src/index.ts --version

# First-run setup: writes ~/.config/suasor/config.toml and the local SQLite store.
bun run src/index.ts init

# Full-text search over ingested sources (FTS5; --json / --limit available).
bun run src/index.ts search "<query>"

# Maintenance.
bun run src/index.ts db migrate            # apply the projection schema (idempotent)
bun run src/index.ts projections rebuild   # replay the event log into projections
```

Config lives in `~/.config/suasor/` (override with `SUASOR_CONFIG_DIR`). `<connector> sync`, `mcp serve`, and `skills install` / `skills list` are wired into the CLI but implemented by later releases. See [docs/design/cli.md](docs/design/cli.md) for the full command/flag reference.

## License

MIT
