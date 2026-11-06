#!/usr/bin/env bash
# Promote develop to main. Pending changesets are versioned on develop first (version bump and
# changelog, committed as "chore: release vX.Y.Z" in a throwaway worktree), then the develop →
# main pull request titled "Promote develop: <summary>" is opened (or reused), its required checks
# are awaited (not the image, which still gates the server deploy on main), and it is merged with
# a merge commit so main and develop keep one history. On main, the release workflow tags the new
# version and publishes the image.
#
# --quick adds [quick] to the title, so main's image run skips the engine suite (lint, typecheck,
# the fast tests and the smoke test still run). Only for changes to words: descriptions, hints, docs.
#
# Usage: scripts/promote-develop.sh "<summary>" [--quick]
set -euo pipefail

if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 \"<summary>\" [--quick]" >&2
  exit 1
fi
summary="$1"
if [ "${2:-}" = --quick ]; then summary="$summary [quick]"; fi

git fetch -q origin main develop
if [ -z "$(git rev-list origin/main..origin/develop)" ]; then
  echo "main already has everything on develop" >&2
  exit 1
fi

pending=$(git ls-tree --name-only origin/develop .changeset/ | grep -v -e README.md -e config.json || true)
if [ -n "$pending" ]; then
  work=$(mktemp -d "${TMPDIR:-/tmp}/cuttingfloor-release.XXXXXX")
  cleanup() { git worktree remove --force "$work" >/dev/null 2>&1 || true; rm -rf "$work"; }
  trap cleanup EXIT
  git worktree add -q --detach "$work" origin/develop
  (
    cd "$work"
    pnpm install --frozen-lockfile --prefer-offline --silent
    pnpm changeset version
    pnpm biome check --write apps/cli/package.json >/dev/null
    version=$(node -p "require('./apps/cli/package.json').version")
    git add -A
    git commit -q -m "chore: release v${version}"
    git push -q origin HEAD:develop
    echo "Versioned v${version} on develop"
  )
fi

pr=$(gh pr list --base main --head develop --state open --json number --jq '.[0].number // empty')
if [ -z "$pr" ]; then
  gh pr create --base main --head develop --title "Promote develop: $summary" \
    --body "$(git log --no-merges --format='- %s' origin/main..origin/develop)"
  pr=$(gh pr list --base main --head develop --state open --json number --jq '.[0].number')
fi

# Checks register a few seconds after a push to develop; until then there are none to watch.
until [ "$(gh pr checks "$pr" --required --json name --jq length 2>/dev/null || echo 0)" -gt 0 ]; do sleep 10; done
gh pr checks "$pr" --required --watch --fail-fast
# A second run of a required check (the pull request's own, after develop's) can register after the
# watch returns, and the merge is refused until it passes. Wait it out rather than give up.
for _ in $(seq 60); do
  gh pr merge "$pr" --merge --subject "Promote develop: $summary" 2>/dev/null && break
  [ "$(gh pr view "$pr" --json state --jq .state)" = MERGED ] && break
  sleep 20
  gh pr checks "$pr" --required --watch --fail-fast >/dev/null
done
[ "$(gh pr view "$pr" --json state --jq .state)" = MERGED ] || {
  echo "Pull request #$pr is still not mergeable after 20 minutes: gh pr view $pr" >&2
  exit 1
}
git fetch -q origin main
echo "Promoted: main is $(git rev-parse --short origin/main)"
"$(dirname "$0")/sync-main-checkout.sh"
