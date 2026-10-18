#!/usr/bin/env bash
# Promote develop to main: open (or reuse) the develop → main pull request titled
# "Promote develop: <summary>", wait for its checks, and merge it with a merge commit so main
# and develop keep one history. The merge to main is the release: changesets on it cut the
# version, tag the image and merge the release back into develop.
#
# Usage: scripts/promote-develop.sh "<summary>"
set -euo pipefail

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 \"<summary>\"" >&2
  exit 1
fi

git fetch -q origin main develop
if [ -z "$(git rev-list origin/main..origin/develop)" ]; then
  echo "main already has everything on develop" >&2
  exit 1
fi

pr=$(gh pr list --base main --head develop --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  gh pr create --base main --head develop --title "Promote develop: $1" \
    --body "$(git log --no-merges --format='- %s' origin/main..origin/develop)"
  pr=$(gh pr list --base main --head develop --state open --json number --jq '.[0].number')
fi

gh pr checks "$pr" --watch --fail-fast
gh pr merge "$pr" --merge --subject "Promote develop: $1"
echo "Promoted: main is $(gh api repos/{owner}/{repo}/commits/main --jq '.sha[0:8]')"
"$(dirname "$0")/sync-main-checkout.sh"
