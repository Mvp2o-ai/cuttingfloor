#!/usr/bin/env bash
# Fast-forward the main checkout (the first entry in `git worktree list`) to origin/develop.
# The main checkout belongs to the person and stays on develop; agents never edit it. A checkout
# on another branch, with local edits, or with commits of its own is left alone, and the reason
# is printed.
#
# Usage: scripts/sync-main-checkout.sh
set -euo pipefail

main=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')
git -C "$main" fetch -q origin develop

branch=$(git -C "$main" symbolic-ref --quiet --short HEAD || echo "(detached)")
behind=$(git -C "$main" rev-list --count HEAD..origin/develop)
if [ "$branch" != develop ]; then
  echo "Main checkout not synced: it is on $branch, not develop ($main)." >&2
  exit 0
fi
if [ "$behind" = 0 ]; then
  echo "Main checkout is current with origin/develop."
  exit 0
fi
if [ -n "$(git -C "$main" status --porcelain --untracked-files=no)" ]; then
  echo "Main checkout not synced: it has uncommitted edits and is $behind commits behind ($main)." >&2
  exit 0
fi
if ! git -C "$main" merge -q --ff-only origin/develop 2>/dev/null; then
  echo "Main checkout not synced: develop there has its own commits, or an untracked file is in the way ($main)." >&2
  exit 0
fi
echo "Main checkout fast-forwarded $behind commits to $(git -C "$main" rev-parse --short HEAD)."
