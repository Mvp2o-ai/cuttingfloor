#!/usr/bin/env bash
# Promote develop to main. Pending changesets are versioned on develop first (version bump and
# changelog, committed as "chore: release vX.Y.Z" in a throwaway worktree), then the develop →
# main pull request titled "Promote develop: <summary>" is opened (or reused), its checks are
# awaited, and it is merged with a merge commit so main and develop keep one history. On main,
# the release workflow tags the new version and publishes the image.
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
  gh pr create --base main --head develop --title "Promote develop: $1" \
    --body "$(git log --no-merges --format='- %s' origin/main..origin/develop)"
  pr=$(gh pr list --base main --head develop --state open --json number --jq '.[0].number')
fi

# Checks register a few seconds after a push to develop; until then there are none to watch.
until [ "$(gh pr checks "$pr" --json name --jq length 2>/dev/null || echo 0)" -gt 0 ]; do sleep 10; done
gh pr checks "$pr" --watch --fail-fast
gh pr merge "$pr" --merge --subject "Promote develop: $1"
git fetch -q origin main
echo "Promoted: main is $(git rev-parse --short origin/main)"
"$(dirname "$0")/sync-main-checkout.sh"
