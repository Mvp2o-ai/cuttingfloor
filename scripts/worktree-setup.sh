#!/usr/bin/env bash
# Set up a new worktree of this repo: copy the main checkout's local env files and give the
# worktree its own pnpm install, so workspace packages resolve to this worktree's code. Safe to
# run again. Cursor runs it from .cursor/worktrees.json, Codex from .codex/environments, and
# scripts/worktree-add.sh after creating a worktree; Claude Code copies the env files through
# .worktreeinclude, so run it there by hand before testing.
#
# Run from inside the worktree: scripts/worktree-setup.sh
set -euo pipefail

here=$(git rev-parse --show-toplevel)
main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
cd "$here"

if [ "$(pwd -P)" = "$main" ]; then
  echo "This is the main checkout, not a worktree. Nothing to set up." >&2
  exit 0
fi

# Git-ignored, so a new worktree starts without them. Copied, never linked.
while read -r env_file; do
  if [ -n "$env_file" ] && [ -f "$main/$env_file" ] && [ ! -e "$env_file" ]; then
    cp "$main/$env_file" "$env_file"
    echo "copied $env_file"
  fi
done < .worktreeinclude

if [ -L node_modules ]; then rm node_modules; fi
pnpm install --frozen-lockfile --prefer-offline
echo "Worktree ready at $(pwd -P)"
