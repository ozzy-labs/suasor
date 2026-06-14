#!/usr/bin/env bash
set -euo pipefail

# Suasor dev setup. Run by the devcontainer post-create hook, or manually:
#   bash scripts/setup.sh

# Install JS dependencies (Bun).
bun install

# Install git hooks (lefthook) so lint / format / commitlint run on commit.
if command -v lefthook >/dev/null 2>&1; then
  lefthook install
elif command -v mise >/dev/null 2>&1; then
  mise exec -- lefthook install
else
  echo "warning: lefthook not found; skipping git hook install" >&2
fi
