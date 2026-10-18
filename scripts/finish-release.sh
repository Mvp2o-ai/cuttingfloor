#!/usr/bin/env bash
# Finish a release after scripts/promote-develop.sh: wait for every workflow run on main's head
# (CI, Image, CodeQL, Release), then remove the given worktree and sync the main checkout. On a
# failed run it stops, prints which, and keeps the worktree. The image build takes a while; run
# this in the background.
#
# Usage: scripts/finish-release.sh [worktree-path]
set -euo pipefail

worktree=${1:-}
git fetch -q origin main develop
sha=$(git rev-parse origin/main)
echo "Waiting for the runs on main ${sha:0:8}"

while :; do
  runs=$(gh run list --branch main --limit 30 --json headSha,name,status,conclusion \
    --jq ".[] | select(.headSha == \"$sha\") | \"\(.name)|\(.status)|\(.conclusion)\"")
  if [ -n "$runs" ] && ! grep -qv '|completed|' <<<"$runs"; then break; fi
  sleep 30
done

sed 's/|completed|/: /' <<<"$runs"
if grep -qv '|completed|success$' <<<"$runs"; then
  echo "A run on ${sha:0:8} did not succeed. The worktree is kept." >&2
  exit 1
fi

if [ -n "$worktree" ]; then
  git fetch -q origin develop
  if [ -n "$(git -C "$worktree" status --porcelain)" ]; then
    echo "Not removing $worktree: it has uncommitted changes." >&2
  elif ! git merge-base --is-ancestor "$(git -C "$worktree" rev-parse HEAD)" origin/develop; then
    echo "Not removing $worktree: its HEAD is not on origin/develop." >&2
  else
    branch=$(git -C "$worktree" symbolic-ref --quiet --short HEAD || true)
    git worktree remove --force "$worktree"
    [ -n "$branch" ] && git branch -q -D "$branch"
    echo "Removed $worktree${branch:+ and its branch $branch}."
  fi
fi

"$(dirname "$0")/sync-main-checkout.sh"
