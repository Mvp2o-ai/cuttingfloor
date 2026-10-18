---
name: ship
description: Ship a cuttingfloor change - worktree off develop, check, land on develop, promote develop to main, and confirm the automatic deploys (site on Vercel, server on Hetzner). Use whenever a change is ready to commit, merge, release or deploy.
---

# Ship a change

The flow is in AGENTS.md ("Branches and releases"). This is the checklist. Deploys are automatic:
nobody runs a deploy by hand.

## 1. Work in a worktree off develop

```sh
git fetch origin
git worktree add -b claude/<topic> .claude/worktrees/<topic> origin/develop
cd .claude/worktrees/<topic> && scripts/worktree-setup.sh
```

Never commit in the main checkout (the first entry of `git worktree list`). It is the person's
and stays on develop. Another session's worktree is theirs; leave it alone.

## 2. Check, then land on develop

- `pnpm check` must pass. Add a changeset (`pnpm changeset`) for a user-facing change.
- Conventional commits, one concern each.
- Land it: `git push origin HEAD:develop` (a rejection means someone pushed first:
  `git pull --rebase origin develop`, check again, push again). Or open a pull request into
  develop. Never into main.
- develop gets CI, CodeQL, the image (`:develop`) and a Vercel preview of the site at
  https://cuttingfloor-site-git-develop-wiltshireks-projects.vercel.app (team login; sign-in and
  Stripe work there, on the same WorkOS and Stripe accounts as production). Check it with
  `CHROME_PATH=… node scripts/smoke-account.ts <that url>`.

## 3. Promote develop to main (when the person says to release)

```sh
scripts/promote-develop.sh "<one-line summary>"
```

It versions pending changesets on develop, opens the develop → main pull request, waits for its
checks and merges it. That merge deploys everything:

| What | How it deploys | Where to look |
|---|---|---|
| Site | Vercel builds main (project `cuttingfloor-site`, root `apps/site`) | Vercel status on the commit |
| Server | `Image` workflow publishes `:<sha>` and `:latest`, then calls `Deploy` (SSH to the Hetzner server, pull, restart, check the `/mcp` sign-in challenge) | `gh run list --branch main` |
| Release | `Release` tags a new version, makes the GitHub release and the `:X.Y.Z` image | GitHub releases |

## 4. Finish

```sh
scripts/finish-release.sh .claude/worktrees/<topic>   # in the background; the image takes a while
```

It waits for every run on main's head, then removes your worktree and fast-forwards the main
checkout. On a failure it keeps the worktree and says which run failed. Report that; the
release isn't done.

Optional, deeper checks against production (they make and delete throwaway accounts):
`node scripts/smoke-hosted.ts`, `CHROME_PATH=… node scripts/smoke-oauth.ts`,
`CHROME_PATH=… node scripts/smoke-account.ts`.

## Redeploy or roll back

- Redeploy main as it is: `gh workflow run deploy.yml --ref main`.
- Roll back: revert the change on develop and promote again. In an emergency, pin an older image
  on the server: `ssh root@<server> 'cd /opt/cuttingfloor && echo CUTTINGFLOOR_IMAGE=ghcr.io/mvp2o-ai/cuttingfloor:<old sha> > .env && docker compose up -d'`.
- Server secrets live only in `/opt/cuttingfloor/cuttingfloor.env` on the server (copy:
  `deploy/hetzner/cuttingfloor.env`, git-ignored). `deploy/hetzner/up.sh` pushes that file and
  rebuilds; it's for changing the server, not for routine deploys.
