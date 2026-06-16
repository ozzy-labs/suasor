# Install

Suasor ships through four channels ([ADR-0010](../adr/0010-distribution.md)).
**v0.1.0 is published** — npm, the standalone binaries, and the Docker image are
all live.

Suasor is an *application* (an MCP server), not a library, so it picks its own
runtime: it runs on **Bun**. Pick a channel by whether you already use Bun — the
binary and Docker image need **no runtime at all** (Bun is bundled), so they are
the simplest option if you don't already run Bun:

| You... | Use | Runtime on the host |
| --- | --- | --- |
| just want it to run / have no JS toolchain | **Standalone binary** | none (Bun compiled in) |
| want local embedding with zero egress | **Docker (+Ollama)** | none (container only) |
| already use Bun | **npm** (`bunx`) | Bun ≥ 1.1 |

> Publishing is a deliberate manual step: `release.yaml` runs only on a published
> GitHub Release or `workflow_dispatch`, never on push/merge (see
> [Releasing](#releasing-maintainers)). Contributors can run from source via the
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
> - The bundled `docs/skills` directory — so `skills install` / `skills list` are
>   not available in the standalone binary.
>
> The GitHub connector and all retrieval/MCP features work in the binary. Use the
> **npm** package or the **Docker** image for the full connector set, keychain
> secrets, and the assistant skills.

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

## 3. npm — `@ozzylabs/suasor` (for Bun users)

For people who **already use [Bun](https://bun.sh)**. Best for running the MCP
server from an agent host.

```bash
# one-off (no install) — ideal for an MCP host command
bunx @ozzylabs/suasor mcp serve

# or install the CLI globally
bun add -g @ozzylabs/suasor
suasor --version
```

> Requires **Bun ≥ 1.1** (`engines.bun`): Suasor uses `bun:sqlite` and other
> `Bun.*` APIs, so it cannot run under Node — use `bunx`, **not** `npx`. If you
> don't run Bun, use the standalone binary or the Docker image above.

Published with [npm Trusted Publishers (OIDC)](../adr/0010-distribution.md) — no
long-lived `NPM_TOKEN` — with build provenance attestation (public repo).

## 4. MCP registry

Suasor is described by [`server.json`](../../server.json) for discovery via the
[MCP registry](https://github.com/modelcontextprotocol/registry). Agent hosts that
browse the registry can find and install it; under the hood it runs the npm
package over stdio (`bunx @ozzylabs/suasor mcp serve`).

## Releasing (maintainers)

Publishing is **manual and gated** — `.github/workflows/release.yaml` triggers
only on `release: published` or `workflow_dispatch`, never on push/merge.

One-time setup:

- Register the npm **Trusted Publisher** on npmjs.com for `@ozzylabs/suasor`
  (Settings → Publishing → GitHub Actions, workflow `release.yaml`). One publisher
  per package; no `NPM_TOKEN`.
- MCP registry: install [`mcp-publisher`](https://github.com/modelcontextprotocol/registry),
  authenticate via GitHub for the `io.github.ozzy-labs/*` namespace.

Cutting a release:

1. Bump `version` in `package.json` (and `server.json`) per [SemVer](https://semver.org); commit via PR.
2. Create a GitHub Release with tag `v<version>` (or run the workflow via `workflow_dispatch`).
3. `release.yaml` then: publishes to npm (OIDC + provenance), cross-compiles the
   single binaries and attaches them to the Release, and builds + pushes the
   Docker image to GHCR.
4. MCP registry submission is a separate manual `mcp-publisher publish` step
   (the npm package carries `mcpName` for ownership validation).

Nothing in this flow runs automatically on merge to `main`.
