# Install

Suasor ships through four channels ([ADR-0010](../adr/0010-distribution.md)).
**Published** — npm, the standalone binaries, and the Docker image are all live
(see the [latest release](https://github.com/ozzy-labs/suasor/releases/latest)).

Suasor is an *application* (an MCP server), not a library, so it picks its own
runtime: it runs on **Bun**. Pick a channel by whether you already use Bun — the
binary and Docker image need **no runtime at all** (Bun is bundled), so they are
the simplest option if you don't already run Bun:

| You... | Use | Runtime on the host |
| --- | --- | --- |
| just want it to run / have no JS toolchain | **Standalone binary** | none (Bun compiled in) |
| want local embedding with zero egress | **Docker (+Ollama)** | none (container only) |
| already use Bun | **npm** (`bunx`) | Bun ≥ 1.2 |

> Releases are automated with release-please: merging its release PR publishes
> npm + binaries + Docker (see [Releasing](#releasing-maintainers)).
> Contributors can run from source via the
> [Quickstart](../../README.md#quickstart-provisional).

## 1. Standalone single binary

For machines without a JS runtime. Download the asset for your OS/arch from the
[GitHub Releases](https://github.com/ozzy-labs/suasor/releases) page:

| Asset | Platform |
| --- | --- |
| `suasor-bun-linux-x64` | Linux x86_64 |
| `suasor-bun-linux-arm64` | Linux arm64 |
| `suasor-bun-darwin-x64` | macOS Intel |
| `suasor-bun-darwin-arm64` | macOS Apple Silicon |
| `suasor-bun-windows-x64.exe` | Windows x64 |

```bash
chmod +x suasor-bun-linux-x64
./suasor-bun-linux-x64 --version
```

### Binary scope {#binary-scope}

> **Caveat (binary scope).** The binary bundles the Suasor core plus the one
> native piece it needs (`sqlite-vec`). Kept **external** (not in the binary) to
> keep it light:
>
> - The OS-keychain secret store (`@napi-rs/keyring`) — so in the binary connector
>   secrets must come from environment variables
>   (`SUASOR_CONNECTOR_<NAME>_<SECRET>`), not the OS keychain.
> - The heavier connector SDKs (Slack / Microsoft Graph / Google / Box / Web —
>   `@slack/web-api`, `@azure/msal-node`, `@microsoft/microsoft-graph-client`,
>   `googleapis`, `box-typescript-sdk-gen`, `playwright-core`) — so those
>   connectors are not available in the standalone binary.
> - The bundled `docs/skills` directory — so `skills install` / `skills list` /
>   `skills search` / `skills info` are not available in the standalone binary.
>
> The GitHub connector and all retrieval/MCP features work in the binary. Use the
> **npm** package or the **Docker** image for the full connector set, keychain
> secrets, and the assistant skills.

Commands that depend on the external pieces fail fast in the binary with a
human-readable error pointing here (instead of an opaque `Cannot find module` /
keyring failure):

| Command | In the binary | Escape hatch |
| --- | --- | --- |
| `skills install` / `skills list` / `skills search` / `skills info` | unavailable (no bundled `docs/skills`) | npm / Docker |
| `<connector> sync` for slack / ms-graph / google / box / web | unavailable (SDK external) | npm / Docker |
| `<connector> auth set` (all connectors) | unavailable (keychain external) | set `SUASOR_CONNECTOR_<NAME>_<SECRET>` directly |
| `<connector> auth test` for ms-graph / google / box | unavailable (SDK external) | npm / Docker |
| `github sync` / `github auth test`, `local sync` | **available** | env-override secret for `github` |
| `suasor sync` (bulk) | runs the bundled connectors; skips the external ones with a warning | npm / Docker for the rest |

## 2. Docker — batteries-included (+ Ollama)

For local embedding/LLM with zero external egress ([ADR-0006](../adr/0006-ml-delegation.md)):
the image bundles Suasor **and** an Ollama sidecar.

```bash
docker run --rm -i \
  -v suasor-data:/data \
  ghcr.io/ozzy-labs/suasor:latest        # default CMD: `mcp serve` (stdio)

# run a CLI subcommand instead
docker run --rm -v suasor-data:/data ghcr.io/ozzy-labs/suasor:latest --version
```

- Config + DB live under `/data` (`SUASOR_CONFIG_DIR=/data`); mount a volume to persist.
- `SUASOR_EMBEDDING__BACKEND=ollama` is preset; the entrypoint starts `ollama serve`
  before Suasor. Pull a model on first use (e.g. `ollama pull bge-m3`) inside the
  container or a mounted Ollama volume.
- Larger than the other channels (Ollama runtime included). Stay on npm/binary if
  you only need FTS or already run Ollama.
- The image's base layers (`oven/bun` and `ollama/ollama`) are pinned by tag +
  digest in the `Dockerfile` so each build embeds a known Bun and Ollama
  (reproducible, supply-chain-safe builds). The Bun version is kept in lockstep
  across the `Dockerfile`, `.mise.toml`, and `engines.bun`.

## 3. npm — `@ozzylabs/suasor` (for Bun users)

For people who **already use [Bun](https://bun.sh)**. Best for running the MCP
server from an agent host.

**Prerequisite — install Bun** (the runtime; `npx` / Node cannot run Suasor):

```bash
curl -fsSL https://bun.sh/install | bash   # official installer
# or:  mise use -g bun@1.2 |   brew install oven-sh/bun/bun
bun --version
```

Then run it. Any package manager (bun / pnpm / npm) can **fetch** the package,
but it always **runs on Bun**:

```bash
# one-off (no install) — ideal for an MCP host command
bunx @ozzylabs/suasor mcp serve
pnpm dlx @ozzylabs/suasor mcp serve          # pnpm equivalent (Bun still required)

# or install the CLI globally
bun add -g @ozzylabs/suasor                  # or: pnpm add -g @ozzylabs/suasor
suasor --version                             #     (npm i -g also works; Bun runs it)
```

> Requires **Bun ≥ 1.2** (`engines.bun`): Suasor uses `bun:sqlite` and other
> `Bun.*` APIs, so it cannot run under Node — use `bunx`, **not** `npx`. If you
> don't run Bun, use the standalone binary or the Docker image above.
>
> **Bun check at install & startup.** `engines.bun` is only advisory under npm, so
> a fetch with no Bun on the host still *succeeds*. To avoid a silent later
> failure, the package runs a `postinstall` hook that prints a **warning** (it
> never fails the install) when no `bun` is detected, pointing you at Bun / the
> binary / Docker. At runtime the CLI also checks the Bun version on startup and
> exits with a short, human-readable message (no stack trace) if Bun is missing or
> below 1.2 — instead of the opaque `ERR_UNSUPPORTED_ESM_URL_SCHEME` you would
> otherwise hit under Node. Set `SUASOR_SKIP_POSTINSTALL=1` to silence the
> install-time advisory (e.g. in CI that only fetches the tarball).

Published with [npm Trusted Publishers (OIDC)](../adr/0010-distribution.md) — no
long-lived `NPM_TOKEN` — with build provenance attestation (public repo).

## 4. MCP registry

Suasor is described by [`server.json`](../../server.json) for discovery via the
[MCP registry](https://github.com/modelcontextprotocol/registry). Agent hosts that
browse the registry can find and install it; under the hood it runs the npm
package over stdio (`bunx @ozzylabs/suasor mcp serve`).

## Releasing (maintainers)

Releases are **release-please-driven** ([ADR-0010](../adr/0010-distribution.md)).
`.github/workflows/release.yaml` runs on every push to `main`: release-please
maintains a **release PR** and, when it merges, cuts the tag + GitHub Release and
publishes — all in that one workflow.

One-time setup:

- Register the npm **Trusted Publisher** on npmjs.com for `@ozzylabs/suasor`
  (Settings → Publishing → GitHub Actions, workflow `release.yaml`). One publisher
  per package; no `NPM_TOKEN`. The workflow filename must stay `release.yaml`.
- MCP registry: install [`mcp-publisher`](https://github.com/modelcontextprotocol/registry),
  authenticate via GitHub for the `io.github.ozzy-labs/*` namespace.

Cutting a release:

1. **Merge Conventional Commits to `main`.** release-please opens/updates a
   `chore(main): release vX.Y.Z` PR that bumps `package.json` + writes
   `CHANGELOG.md` (in 0.x: `feat` → minor, `fix` → patch).
2. **Merge that release PR.** release-please creates tag `vX.Y.Z` + the GitHub
   Release, and the same workflow then publishes to npm (OIDC + provenance),
   cross-compiles the single binaries and attaches them to the Release, and
   builds + pushes the Docker image to GHCR.
3. **Sync `server.json` version** if needed, and submit to the MCP registry via
   `mcp-publisher publish` (separate manual step; the npm package carries
   `mcpName` for ownership validation).

> Publish runs in `release.yaml` itself (gated on `release_created`), not via a
> separate `on: release` workflow: a Release made by release-please with
> `GITHUB_TOKEN` does **not** cascade-trigger `on: release` / `on: push: tags`.
