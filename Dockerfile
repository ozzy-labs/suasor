# Batteries-included image (ADR-0010): Suasor + a local Ollama sidecar, so the
# optional embedding/LLM backends (ADR-0005/0006) work out of the box with no
# external egress. Users who already run Ollama (or stay FTS-only) can prefer
# the npm package or the standalone binary instead.

# ---- build stage: compile the app bundle with Bun ----
# Pin the base images by tag + digest for reproducible, supply-chain-safe builds
# (#237). Bump in lockstep with `.mise.toml` / `package.json` `engines.bun`.
FROM oven/bun:1.2.23@sha256:6ebf306367da43ad75c4d5119563e24de9b66372929ad4fa31546be053a16f74 AS build
WORKDIR /app
# `scripts/` is copied before install because package.json's `postinstall`
# (scripts/postinstall.mjs, #155) runs during `bun install` and would otherwise
# fail with "Module not found" in this deps-only layer.
COPY package.json bun.lock ./
COPY scripts ./scripts
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime stage: Ollama base + the Bun runtime + the built app ----
# Pinned by tag + digest so each build embeds a known Ollama (a `:latest` base
# would silently change the bundled LLM/embedding runtime between builds, #237).
FROM ollama/ollama:0.12.3@sha256:c622a7adec67cf5bd7fe1802b7e26aa583a955a54e91d132889301f50c3e0bd0
# Bun is a single binary; copy it in rather than reinstalling.
COPY --from=oven/bun:1.2.23@sha256:6ebf306367da43ad75c4d5119563e24de9b66372929ad4fa31546be053a16f74 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/docs/skills ./docs/skills
COPY docker-entrypoint.sh /usr/local/bin/suasor-entrypoint
RUN chmod +x /usr/local/bin/suasor-entrypoint

# Local-first defaults: embedding via the bundled Ollama sidecar, data under a
# mountable volume.
ENV SUASOR_EMBEDDING__BACKEND=ollama \
    SUASOR_EMBEDDING__BASEURL=http://localhost:11434 \
    SUASOR_CONFIG_DIR=/data
VOLUME ["/data"]

# The Ollama base image sets its own ENTRYPOINT; override it to run the sidecar
# plus Suasor. Default command starts the MCP server over stdio.
ENTRYPOINT ["/usr/local/bin/suasor-entrypoint"]
CMD ["mcp", "serve"]
