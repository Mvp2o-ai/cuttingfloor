#!/usr/bin/env bash
# Create a worktree by hand (outside Claude Code, Cursor or Codex) and set it up.
#
# Usage: scripts/worktree-add.sh <path> <ref> [new-branch]
#   scripts/worktree-add.sh .claude/worktrees/fix-x origin/develop claude/fix-x
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <path> <ref> [new-branch]" >&2
  exit 1
fi

git fetch -q origin
if [ -n "${3:-}" ]; then
  git worktree add -q -b "$3" "$1" "$2"
else
  git worktree add -q --detach "$1" "$2"
fi
cd "$1"
scripts/worktree-setup.sh
echo "On $(git rev-parse --short HEAD)"
