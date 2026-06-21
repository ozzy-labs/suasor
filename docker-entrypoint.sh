#!/bin/sh
# Batteries-included entrypoint: start the Ollama sidecar, wait for it to accept
# connections, ensure the embedding model is present, then run Suasor with the
# given args (default: `mcp serve`).
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

# Ensure the embedding model is pulled (#294). The image presets
# SUASOR_EMBEDDING__BACKEND=ollama, so the first embed needs the model present in
# the (mounted) Ollama volume; without it the first `sync` / `recall.search`
# silently degrades to FTS until someone pulls it by hand (install.md footgun).
#
# Best-effort and local-first: we only pull from the local Ollama daemon (no
# Suasor egress; Ollama itself fetches the model). Skip entirely when the backend
# is not ollama, when SUASOR_DOCKER_SKIP_MODEL_PULL is set (air-gapped / pre-baked
# volume), or when the model is already present. A failed pull is a warning, not a
# fatal error — Suasor still starts and degrades to FTS with a visible doctor
# warning rather than refusing to boot.
backend="${SUASOR_EMBEDDING__BACKEND:-ollama}"
model="${SUASOR_EMBEDDING__MODEL:-bge-m3}"
if [ "$backend" = "ollama" ] && [ -z "${SUASOR_DOCKER_SKIP_MODEL_PULL:-}" ]; then
  # `ollama list` prints `NAME ID SIZE MODIFIED`; NAME is `<model>` or `<model>:tag`.
  # Compare the first field literally (awk, no regex) against the model with or
  # without an explicit tag, so metacharacters in the name are not interpreted.
  if ollama list 2>/dev/null | awk -v m="$model" '{n=$1; if (n==m || index(n, m ":")==1) found=1} END {exit found?0:1}'; then
    echo "suasor: embedding model '${model}' already present." >&2
  else
    echo "suasor: pulling embedding model '${model}' (first run; set SUASOR_DOCKER_SKIP_MODEL_PULL=1 to skip)..." >&2
    if ollama pull "$model"; then
      echo "suasor: embedding model '${model}' ready." >&2
    else
      echo "suasor: WARNING: could not pull '${model}'; recall degrades to FTS until it is pulled (e.g. \`ollama pull ${model}\`). See \`suasor doctor\`." >&2
    fi
  fi
fi

exec bun /app/dist/index.js "$@"
