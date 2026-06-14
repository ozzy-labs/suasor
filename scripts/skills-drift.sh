#!/usr/bin/env bash
set -euo pipefail

# In-repo assistant-skill dogfood drift check (ADR-0008).
#
# The SSOT for each assistant skill is docs/skills/<name>/SKILL.md. The repo
# dogfoods the install by committing identical mirrors under .claude/skills/ and
# .agents/skills/. This script fails (exit 1) when any mirror is missing or
# diverges from the SSOT, so a `suasor skills install` is required before commit.
#
# Self-contained (diff over the file tree) so it runs in the lefthook pre-commit
# hook without building the CLI. Usage:
#   scripts/skills-drift.sh          # check; exit 1 on drift
#
# Run from the repo root (lefthook sets cwd to the repo root).

src="docs/skills"
hosts=(".claude/skills" ".agents/skills")

if [[ ! -d "$src" ]]; then
  echo "skills-drift: SSOT not found: $src (run from repo root)" >&2
  exit 1
fi

drift=0
for skill_dir in "$src"/*/; do
  ssot="$skill_dir/SKILL.md"
  [[ -f "$ssot" ]] || continue
  name="$(basename "$skill_dir")"
  for host in "${hosts[@]}"; do
    mirror="$host/$name/SKILL.md"
    if [[ ! -f "$mirror" ]]; then
      echo "skills-drift: missing mirror: $mirror" >&2
      drift=1
    elif ! diff -q "$ssot" "$mirror" >/dev/null 2>&1; then
      echo "skills-drift: out of sync: $mirror (differs from $ssot)" >&2
      drift=1
    fi
  done
done

# Detect orphan mirrors: a skill present under a host dir but no longer in SSOT.
for host in "${hosts[@]}"; do
  [[ -d "$host" ]] || continue
  for mirror_dir in "$host"/*/; do
    [[ -f "$mirror_dir/SKILL.md" ]] || continue
    name="$(basename "$mirror_dir")"
    if [[ ! -f "$src/$name/SKILL.md" ]]; then
      echo "skills-drift: orphan mirror (no SSOT): $mirror_dir/SKILL.md" >&2
      drift=1
    fi
  done
done

if [[ "$drift" -ne 0 ]]; then
  echo "skills-drift: drift detected. Run \`suasor skills install\` (or \`bun run src/index.ts skills install\`) and commit the result." >&2
  exit 1
fi

echo "skills-drift: assistant skill mirrors are in sync with docs/skills/."
