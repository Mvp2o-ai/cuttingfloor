#!/usr/bin/env bash
# Finish a release after scripts/promote-develop.sh: wait for every workflow run on main's head
# (CI, Image, CodeQL, Release), bring main back into develop if anything reached main since the
# promotion, then remove the given worktree and sync the main checkout. On a failed run it stops,
# prints which, and keeps the worktree. The image build takes a while; run this in the background.
#
# Usage: scripts/finish-release.sh [worktree-path]
set -euo pipefail

worktree=${1:-}
# The main checkout's scripts: run from the worktree being removed, this script's own folder
# would be gone by the time it syncs.
main=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')
scripts="$main/scripts"
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

"$scripts/merge-main-into-develop.sh"

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

# Sweep worktrees other sessions left behind: a run that failed, a session that ended before this
# script finished, or commits that reached develop under new hashes (a rebase). One goes only when
# nothing in it exists nowhere else: unlocked, clean, every commit's change already on develop
# (git cherry, so rebased commits count), no ignored file beyond installs, builds and the env
# copies worktree-setup.sh makes, and nothing touched for 12 hours (a session may still be in it).
disposable='^!! (.*/)?(node_modules|dist|coverage|\.next|\.turbo|\.models)/$|^!! .*(\.tsbuildinfo|\.DS_Store)$|^!! packages/skills/vectors\.json$'
while read -r include; do
  [ -n "$include" ] && disposable="$disposable|^!! ${include//./\\.}\$"
done < "$main/.worktreeinclude"
sweepable() {
  local wt=$1 cherry
  [ -z "$(git -C "$wt" status --porcelain)" ] || return 1
  cherry=$(git -C "$wt" cherry origin/develop HEAD) || return 1
  ! grep -q '^+' <<<"$cherry" || return 1
  ! git -C "$wt" status --porcelain --ignored | grep -Ev "$disposable" | grep -q . || return 1
  [ -z "$(find "$wt" -name node_modules -prune -o -mmin -720 -print -quit)" ]
}
git -C "$main" worktree list --porcelain | awk '
  /^worktree / { if (w) print w "\t" l; w = substr($0, 10); l = 0 }
  /^locked/ { l = 1 }
  END { if (w) print w "\t" l }' | while IFS=$'\t' read -r wt locked; do
  if [ "$wt" = "$main" ] || [ "$locked" = 1 ] || [ ! -d "$wt" ] || ! sweepable "$wt"; then
    continue
  fi
  branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD || true)
  if git -C "$main" worktree remove --force "$wt"; then
    [ -n "$branch" ] && git -C "$main" branch -q -D "$branch"
    echo "Swept $wt${branch:+ and its branch $branch}: clean, on develop, untouched for 12 hours."
  fi
done
git -C "$main" worktree prune

"$scripts/sync-main-checkout.sh"
