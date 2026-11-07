#!/usr/bin/env bash
# Bring origin/main back into origin/develop, so develop never sits behind main: after a
# promotion, main has the promotion's merge commit (and anything else that reached main), and
# develop takes it too. Develop is fast-forwarded to main when it has nothing main lacks;
# otherwise origin/main is merged into it with a merge commit. Never a rebase or a force push.
# The merge is made in a throwaway worktree, so no checkout is touched. A push rejected because
# someone pushed to develop meanwhile is retried. It does nothing when develop already has main,
# so it is safe to run again. promote-develop.sh and finish-release.sh run it.
#
# Usage: scripts/merge-main-into-develop.sh
set -euo pipefail

work=""
cleanup() {
  if [ -n "$work" ]; then
    git worktree remove --force "$work" >/dev/null 2>&1 || true
    rm -rf "$work"
    work=""
  fi
}
trap cleanup EXIT

for _ in 1 2 3 4 5; do
  git fetch -q origin main develop
  main=$(git rev-parse --short origin/main)
  if git merge-base --is-ancestor origin/main origin/develop; then
    echo "Develop already has main $main."
    exit 0
  fi
  if git merge-base --is-ancestor origin/develop origin/main; then
    target=$(git rev-parse origin/main)
    done_msg="Develop fast-forwarded to main $main."
  else
    work=$(mktemp -d "${TMPDIR:-/tmp}/merge-main-into-develop.XXXXXX")
    git worktree add -q --detach "$work" origin/develop
    if ! git -C "$work" merge -q --no-ff -m "Merge main into develop" origin/main; then
      git -C "$work" merge --abort || true
      echo "Merging main $main into develop conflicts. Merge origin/main into develop by hand in a worktree (no rebase, no force) and push it." >&2
      exit 1
    fi
    target=$(git -C "$work" rev-parse HEAD)
    done_msg="Merged main $main into develop: $(git rev-parse --short "$target")."
  fi
  if git push -q origin "$target:refs/heads/develop"; then
    cleanup
    echo "$done_msg"
    exit 0
  fi
  cleanup
  echo "The push to develop was rejected (someone pushed meanwhile?); trying again." >&2
  sleep 5
done
echo "Could not bring main into develop after 5 tries. Run scripts/merge-main-into-develop.sh again." >&2
exit 1
