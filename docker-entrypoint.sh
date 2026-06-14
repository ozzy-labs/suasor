#!/bin/sh
# Batteries-included entrypoint: start the Ollama sidecar, wait for it to accept
# connections, then run Suasor with the given args (default: `mcp serve`).
set -eu

ollama serve &

# Wait up to ~30s for the Ollama HTTP API. Bun is present, so use it instead of
# requiring curl in the image.
i=0
while [ "$i" -lt 30 ]; do
  if bun -e "await fetch('http://localhost:11434/api/version')" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

exec bun /app/dist/index.js "$@"
