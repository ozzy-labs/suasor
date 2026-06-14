# Batteries-included image (ADR-0010): Suasor + a local Ollama sidecar, so the
# optional embedding/LLM backends (ADR-0005/0006) work out of the box with no
# external egress. Users who already run Ollama (or stay FTS-only) can prefer
# the npm package or the standalone binary instead.

# ---- build stage: compile the app bundle with Bun ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime stage: Ollama base + the Bun runtime + the built app ----
FROM ollama/ollama:latest
# Bun is a single binary; copy it in rather than reinstalling.
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
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
