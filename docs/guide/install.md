# Install

Suasor ships through four channels ([ADR-0010](../adr/0010-distribution.md)). Pick
the one that matches how you run it.

> Status: the release pipeline (`.github/workflows/release.yaml`) is in place, but
> **publishing is a deliberate manual step** — artifacts appear only after a
> maintainer cuts a release (see [Releasing](#releasing-maintainers)). Until the
> first release, run from source via the [Quickstart](../../README.md#quickstart-provisional).

## 1. npm — `@ozzylabs/suasor` (canonical)

For anyone who already has a JavaScript runtime. Best for running the MCP server
from an agent host.

```bash
# one-off (no install) — ideal for an MCP host command
bunx @ozzylabs/suasor mcp serve

# or install the CLI globally
bun add -g @ozzylabs/suasor
suasor --version
```

> Suasor runs on **Bun** (`engines.bun >= 1.1`): it uses `bun:sqlite` and other
> `Bun.*` APIs, so it cannot run under Node — use `bunx`, not `npx`.

Published with [npm Trusted Publishers (OIDC)](../adr/0010-distribution.md) — no
long-lived `NPM_TOKEN` — with build provenance attestation (public repo).

## 2. Standalone single binary

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

## 3. Docker — batteries-included (+ Ollama)

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
