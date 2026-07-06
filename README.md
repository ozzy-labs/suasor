# Suasor

[![npm version](https://img.shields.io/npm/v/@ozzylabs/suasor)](https://www.npmjs.com/package/@ozzylabs/suasor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ozzy-labs/suasor/actions/workflows/ci.yaml/badge.svg)](https://github.com/ozzy-labs/suasor/actions/workflows/ci.yaml)
[![ghcr.io](https://img.shields.io/badge/ghcr.io-ozzy--labs%2Fsuasor-blue?logo=docker)](https://github.com/ozzy-labs/suasor/pkgs/container/suasor)

**Gathers, remembers, advises - you decide.**

Suasor is a local-first AI secretary. It gathers your scattered work context - chat, email, calendar, documents, code, the web - into private memory on your own machine, so you and your AI agents can search and summarize it over MCP. It advises you, and proposes replies, tasks, and decisions - and, once you approve, can act on your behalf (publish a task, transition an issue). Ingest is read-only, and nothing egresses without your approval.

[日本語 / Japanese →](README.ja.md)

## What it does

- **Gathers** — pulls your scattered work context from across your tools into one local, private store. **Ingest is read-only** — gathering never writes back to your sources.
- **Remembers** — keeps it as searchable, queryable memory on your own machine.
- **Advises** — surfaces, summarizes, and proposes replies, tasks, and decisions over MCP. You and your AI agents query it; you approve every action. Once approved, Suasor can also carry it out for you — publish a task to GitHub / Jira, transition an issue — but nothing egresses without your say ([ADR-0036](docs/adr/0036-task-external-home.md)).

## What it is not (Boundaries)

These boundaries keep Suasor a local-first, human-in-the-loop advisor (see [docs/requirements/scope.md](docs/requirements/scope.md)):

- **No unapproved egress, no auto-send** — ingest is read-only, and nothing leaves your machine without your explicit approval. Approved actions (e.g. publishing a task or transitioning an issue via `task.publish` / `task.act`) are then carried out by Suasor on your behalf — only after you approve them, never automatically ([ADR-0004](docs/adr/0004-mcp-agent-boundary-and-hitl.md) / [ADR-0036](docs/adr/0036-task-external-home.md)).
- **No daemon, no unsolicited notifications** — nothing runs always-on. Proactive digests exist (`suasor digest`), but only as an OS-scheduled cron one-shot that sends a preconfigured, named job (standing consent) — with no configured job it sends nothing, and per-event write approval is unchanged ([ADR-0040](docs/adr/0040-proactive-push-lane.md) / [ADR-0004](docs/adr/0004-mcp-agent-boundary-and-hitl.md)).
- **No heavy in-process ML** — model training/inference is delegated, not run in-process ([ADR-0006](docs/adr/0006-ml-delegation.md)).
- **Single-user, local-only** — no multi-user, team sharing, or server-side aggregation.
- **No web / mobile UI** — the boundary is the CLI and MCP.

## Status

Early development — **published** on npm / standalone binaries / Docker. Built spec-first.

## Install

Suasor is an MCP server — an *application*, not a library — so it runs on its own runtime, **Bun**. Pick a channel by whether you already use Bun; the binary and Docker image need **no runtime at all** (Bun is bundled). Details: [docs/guide/install.md](docs/guide/install.md).

- **Standalone binary** *(no runtime needed)* — download per OS/arch from [Releases](https://github.com/ozzy-labs/suasor/releases). Bun is compiled in. Core + a few native bits; the heavier connector SDKs are external (use npm/Docker for the full connector set).
- **Docker (batteries-included + Ollama)** *(no runtime needed)* — `docker run ghcr.io/ozzy-labs/suasor`. Local embedding with no external egress.
- **npm — for Bun users** — `bunx @ozzylabs/suasor mcp serve` (or `bun add -g @ozzylabs/suasor`). Requires **Bun ≥ 1.2** ([install Bun](https://bun.sh)) — uses `bun:sqlite`, so `npx`/Node won't run it; pnpm/npm can fetch it but Bun runs it. OIDC-published with provenance.
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
# Prints a multi-step next-steps guide (doctor -> onboard -> sync -> skills).
suasor init

# Guided setup: pick connector(s), store tokens, wire the [connectors.X] config
# slice (enabled = true), run the first sync, and print the scheduler + MCP
# snippets — all in the correct order (ADR-0029).
suasor onboard --connector github,slack   # interactive on a TTY; --json for a summary
# slack now completes here too: onboard bridges its flat/single-workspace setup
# (multi-workspace still uses `suasor slack auth set --workspace <alias>`).

# Verify config / DB / connector readiness (diagnostic only; creates nothing).
suasor doctor

# Ingest read-only from a connector (github / slack / ms-graph / google / box / web / local / notion / jira).
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

Config lives in `~/.config/suasor/` (override with `SUASOR_CONFIG_DIR`). Edit it with `suasor config edit` (validates on save, rolls back a bad edit) and check it with `suasor validate-config [--fix]`. `<connector> sync` ingests read-only from github / slack / ms-graph / google / box / web / local / notion / jira — see [docs/guide/connectors.md](docs/guide/connectors.md) for per-connector setup. Back up your local store with `suasor export backup` and audit / purge ingested data with `suasor source list` / `suasor source forget` — see [docs/guide/data-audit.md](docs/guide/data-audit.md). Diagnose common failure modes (empty sync, recall returning nothing, dimension mismatch, rate limits) with [docs/guide/troubleshooting.md](docs/guide/troubleshooting.md). See [docs/design/cli.md](docs/design/cli.md) for the full command/flag reference and [docs/skills/README.md](docs/skills/README.md) for the assistant skills.

### From source

Contributors and anyone running from a clone use Bun directly — `bun run src/index.ts` replaces `suasor` in every command above. Requires [Bun](https://bun.sh) 1.2+.

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

The same cron model drives the **proactive push lane** ([ADR-0040](docs/adr/0040-proactive-push-lane.md)): once you configure a named `[digest.jobs]` entry (standing consent), `suasor digest` bundles your top priorities (overdue / demand / due-soon, [ADR-0041](docs/adr/0041-neutral-demand-priority-substrate.md)) and pushes them to a channel — OS notification, a file in the export sandbox, or a Slack DM-to-self. No job configured means nothing is sent.

```cron
# Every morning, write a file digest; hourly on weekdays, DM the urgent items.
0 8 * * *  suasor digest --job morning >> "$HOME/.local/state/suasor/digest.log" 2>&1
```

## Connect an agent host (MCP)

Suasor exposes its memory to AI agents over the [Model Context Protocol](https://modelcontextprotocol.io) (stdio transport). The server is the agent boundary. Read tools are side-effect-free and annotated read-only so hosts may auto-approve them; write tools stay behind human-in-the-loop approval ([ADR-0004](docs/adr/0004-mcp-agent-boundary-and-hitl.md)) — nothing is applied or egressed without your say. The full surface, generated from [`src/mcp/tool-catalog.ts`](src/mcp/tool-catalog.ts) so this list can't drift:

<!-- BEGIN GENERATED mcp-tools — source: src/mcp/tool-catalog.ts; regenerate with `bun run gen:readme-tools`. DO NOT EDIT BY HAND. -->

**Read tools** — side-effect-free (`readOnlyHint: true`), so hosts may auto-approve them:

- `search` — FTS5 full-text search over ingested sources.
- `recall.search` — Semantic (embedding) search; degrades to FTS when no backend is enabled.
- `search.hybrid` — Hybrid search: RRF fusion of FTS + semantic hits; degrades to FTS-only.
- `source.list` — List ingested sources newest-first.
- `source.get` — Fetch one source (with body) by id.
- `source.get.full` — Bundle a source's body + outgoing provenance links + extraction_meta in one call.
- `source.history` — List a source's body versions from the event log (newest first).
- `task.list` — List tasks, most-recently-updated first.
- `decision.list` — List recorded decisions, newest-recorded first.
- `demand.list` — List connector-neutral demand (Slack @mentions/DMs + github notifications); un-acked only by default (ADR-0041).
- `priority.list` — Deterministic cross-entity next-actions ranking (tasks + commitments + un-acked demand, ADR-0041).
- `brief` — Bundle the period's tasks/decisions/sources/inbox for the host to summarize.
- `graph.related` — Provenance neighbours of an entity (1 hop) over the links projection.
- `graph.expand` — Breadth-first provenance expansion from an entity (N hops); direction in/out/both for backward trace.
- `activity.timeline` — Entity-axis merged source/task/decision timeline (newest-first) for one entity.
- `inbox.list` — List inbox items, most-recently-updated first.
- `propose.list` — List proposal candidates by state (pending/applied/rejected).
- `commitment.list` — List commitments by state (open/resolved/dismissed) and direction.
- `person.list` — List resolved persons with their connector author identities (ADR-0022).

**Write tools** — every one is HITL: a host must gate it behind human approval, and there is no auto-apply path ([ADR-0004](docs/adr/0004-mcp-agent-boundary-and-hitl.md)). The set includes **actuators** that carry out an approved action on your behalf — `task.publish` / `task.act` / `task.update` egress to your GitHub / Jira / Slack task home ([ADR-0036](docs/adr/0036-task-external-home.md)) — and `source.forget`, which irreversibly purges an ingested source. Suasor never triggers any of these on its own; you approve each one first:

- `connector.sync` — Run a read-only connector ingest pass into the local store.
- `propose.generate` — Frame reply/task/decision/triage candidates and record them as pending.
- `propose.apply` — Persist approved candidates as domain events (idempotent).
- `propose.reject` — Reject a pending candidate with a reason (idempotent).
- `proposal.feedback` — Record a regeneration hint on a pending candidate without applying/rejecting it.
- `propose.batch` — Apply and/or reject candidates in one atomic RPC (single transaction).
- `task.create` — Create a task directly (TaskProposed).
- `task.update` — Transition a task's lifecycle state (TaskApplied).
- `task.publish` — Publish a task to its external home (TaskPublished, egress).
- `task.act` — Act on a published task: complete/reopen/comment (TaskActionIssued).
- `decision.record` — Record a decision directly (DecisionRecorded).
- `inbox.add` — Capture an inbox item referencing a source (InboxItemTriaged, state open).
- `inbox.triage` — Resolve an open inbox item (task / decision / discard).
- `link.add` — Create a manual provenance link between two entities (LinkAdded, manual_link).
- `link.remove` — Remove a manual link by id (LinkRemoved).
- `person.merge` — Merge two persons into one (PersonsMerged); reversible via person.split.
- `person.split` — Split one identity off a person into another (PersonSplit).
- `commitment.resolve` — Mark an open commitment fulfilled (CommitmentResolved).
- `commitment.dismiss` — Dismiss an open commitment as a false-positive (CommitmentDismissed).
- `commitment.reopen` — Reopen a resolved/dismissed commitment back to open (CommitmentReopened).
- `demand.ack` — Mark a demand row handled — drops it from the un-acked demand.list (DemandAcknowledged).
- `demand.dismiss` — Mark a demand row not relevant — drops it from the un-acked demand.list (DemandDismissed).
- `draft.export` — Write a draft to a local file in the export sandbox (DraftExported).
- `source.forget` — Purge an ingested source locally — redact + delete + tombstone (SourceForgotten).
- `source.unforget` — Lift a forget tombstone so the source can be re-ingested (SourceUnforgotten).

<!-- END GENERATED mcp-tools -->

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
