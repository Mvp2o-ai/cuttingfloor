# Hosting cuttingfloor on Hetzner Cloud

One server first. It's the same image as local, in hosted mode:
- OAuth sign-in through WorkOS AuthKit (each user is an owner), and bearer API keys alongside
- imports from a URL, or of a file sent to a signed upload URL (`media.upload`, resumable, kept a day until imported)
- the server's own TypeSafe key for `media.analyze look`, with a daily frame cap per account
- the sandbox under gVisor
- Caddy for TLS

## Start

1. Make a Hetzner Cloud project and an API token (Security → API tokens, read and write).
2. Add the token and an SSH key, once each:
   ```sh
   hcloud context create cuttingfloor
   hcloud ssh-key create --name me --public-key-from-file ~/.ssh/id_ed25519.pub
   ```
3. Copy `cuttingfloor.env.example` to `cuttingfloor.env` and fill it in. That file is git-ignored.
4. Set up sign-in (WorkOS AuthKit):
   - `CUTTINGFLOOR_OAUTH_ISSUER` is the AuthKit domain (Domains page).
   - Register `<CUTTINGFLOOR_PUBLIC_URL>/mcp` as the default resource indicator: `POST https://api.workos.com/user_management/authkit_oauth_resources {"uri": "…/mcp", "default": true}`.
   - In the dashboard, Connect → Configuration: turn on Client ID Metadata Document and Dynamic Client Registration.
5. Run `./up.sh`. It does three things:
   - creates `cuttingfloor-1`, a CCX33 (8 dedicated vCPUs, 32 GB) in Ashburn, with Docker and gVisor, on a named IPv4 and no IPv6. The address outlives a rebuilt server, and it uses one primary IP. Hetzner counts limits across every project of the account.
   - copies the compose file and the env file over SSH (cloud-init user data never holds a secret)
   - starts everything
6. Point an A record for the domain at the address it prints. Caddy gets the certificate on first request.
   Or let `up.sh` set it: `CUTTINGFLOOR_ZONE=example.com` for a Hetzner DNS zone, plus `CUTTINGFLOOR_DNS_TOKEN` when the zone is in another project.
7. After that, deploys are automatic: every merge into `main` publishes the image and the `Deploy` workflow pulls it here. Run `./up.sh` again only to change the server or its `cuttingfloor.env`.

**Moving to a new domain:**
- Point its A record at the server.
- On the server, set `CUTTINGFLOOR_DOMAIN` and `CUTTINGFLOOR_PUBLIC_URL` in `cuttingfloor.env`.
- Register `<new url>/mcp` with WorkOS as the default resource (step 4). Sign-in callbacks belong to the clients and need no change.
- Keep the old address working with `caddy/redirect.caddy` next to `compose.yaml`: `old.example.com { redir https://new.example.com{uri} 308 }`.
- Then `docker compose up -d --force-recreate`.

Signed links cover only the path, so links made under the old address still work after the redirect. A client that signed in at the old address signs in once more.

**Check it:** `CF_KEY=<a key from CUTTINGFLOOR_API_KEYS> node scripts/smoke-hosted.ts https://<domain>`. It checks that a request without a key is refused, then the sandbox (`create.still`, `create.motion`), `look` on the server's TypeSafe key, an export's signed link, and that file uploaded back in two parts and imported.

**Billing and account email:**
- `node scripts/stripe-setup.ts` makes (or updates) the prices, the billing portal and the webhook at `<CUTTINGFLOOR_PUBLIC_URL>/stripe/webhook`, and writes the webhook's secret to `cuttingfloor.env`.
- `RESEND_API_KEY` sends account email from support@cuttingfloor.ai (the domain is verified in Resend, its records in the Hetzner DNS zone).
- `CUTTINGFLOOR_ACCOUNT_KEY` is shared with the site, which acts for the signed-in account: its render minutes (`GET /account/usage`), its files and storage (`GET /account/media`), and starting an upload from the account page's drop zone (`POST /account/uploads`; the browser then sends the file straight to the signed upload URL).
- Plans, their minutes and limits are `packages/plans`; the server and the site both read it.

**Check accounts and billing:** `CHROME_PATH=<chrome> node scripts/smoke-account.ts https://cuttingfloor.ai`. It signs a throwaway user up on the site, checks the account and welcome pages, opens Checkout, then checks the server's rules on the real WorkOS and Stripe: trial limits, a refused unverified email, refusal when WorkOS can't be reached, trial over, subscribed, lifetime.

**Check sign-in:** `WORKOS_API_KEY=sk_… CHROME_PATH=<chrome> node scripts/smoke-oauth.ts https://<domain>`. It makes a throwaway WorkOS user, registers a client with AuthKit as an MCP client does, signs in on AuthKit's page in headless Chrome, calls tools with the token, then deletes the user and the client. AuthKit caches its metadata for five minutes, so a registration setting changed there takes that long to show.

## Moving authentication from staging to production

WorkOS environments have separate users, client IDs, keys and configuration. A production key
does not have to begin with `sk_live_`; validate which environment it belongs to instead of
inferring that from its prefix.

Before switching the running services:
- Configure production's callback (`https://cuttingfloor.ai/callback`), logout
  (`https://cuttingfloor.ai/`), homepage and sign-in endpoint (`https://cuttingfloor.ai/account`).
- Enable the intended sign-in methods, CIMD and DCR, and register
  `https://api.cuttingfloor.ai/mcp` as the default resource. Check the issuer's discovery document.
- Add each social sign-in provider with our own OAuth app. Staging shows Google and GitHub
  through WorkOS's shared demo apps; production shows no provider until it has its own. Google
  is the web client `cuttingfloor-workos` in the GCP project `cuttingfloor`, with the redirect URI
  that WorkOS shows under Authentication → OAuth providers → Google. The CLI's dashboard session
  can read providers (`oauthCredentialsByType`) but not create them, so credentials are entered
  in the dashboard. Check that each provider's button appears on the sign-in page before switching.
- Configure production's branding and terms/privacy links. The CLI's dashboard session also
  authorizes the dashboard GraphQL operations used by the CLI; a missing CLI flag does not mean
  a setting necessarily requires a manual dashboard edit.
- Recreate existing accounts with their verified-email state and metadata. Preserve plan tags
  and Stripe customer links; update each linked Stripe customer's `workos_user_id` metadata.
  Passwords and active sessions do not transfer: existing users sign in again using an email code.
- Copy each account's data from `owners/<staging-user-id>` to `owners/<production-user-id>`.
  Update stored media paths and completed job ownership to the new ID, preserving file mtimes
  and immutable timeline documents. Keep the original directory for rollback and check that no
  jobs are running during the final synchronization.
- Verify the Resend sending domain in Hetzner DNS. Use a domain-scoped sending key for the
  hosted server. WorkOS's Resend provider also checks domain verification and requires a separate
  full-access key; a sending-only key cannot configure that provider. Set its sender and reply-to
  to `support@cuttingfloor.ai`.

Back up the server env and Vercel production env privately. Change the production WorkOS key
and client ID in Vercel, rotate its cookie password to invalidate staging sessions, and change
the server's WorkOS key/client ID, OAuth issuer and Resend key. Keep previews and local development
on staging. Deploy through the release flow, then run both account and OAuth smoke tests against
production. For a configuration-only restart of the existing main image, the Deploy workflow
also supports `gh workflow run deploy.yml --ref main`.

Use a custom AuthKit hostname only after its DNS, TLS and discovery document work. A pending
custom hostname does not prevent using the production environment's assigned AuthKit hostname.
Treat an authorization error from WorkOS as a separate unresolved configuration issue.

**If the image is private:** export `GHCR_USER` and `GHCR_TOKEN` (`read:packages`) before running `up.sh`. Or make the GHCR package public in the GitHub UI. Or build on the server from this checkout's HEAD: `CUTTINGFLOOR_BUILD=1 ./up.sh`.

**Verified under gVisor:** `create.still` and `create.motion` run with the sandbox under `runsc` (systrap). The deeper escape and abuse checks in `scripts/smoke-motion.ts` still run only against the local compose file.

## Growing it

**1. One server, bigger.**
- `CUTTINGFLOOR_SERVER_TYPE=ccx43` or larger, then `./up.sh`.
- Accounts can't collide:
  - Each owner's data sits under its own folder.
  - Timelines are content-addressed and never change.
  - Each analysis is its own file.
  - Jobs carry their server's name and a heartbeat.

**2. Several identical servers sharing one data root.**
- What already works:
  - The job records (node name, heartbeat, any server cleaning up after a dead one) are built for this.
  - A cancel on one server reaches a job running on another.
- What it needs:
  - A shared `/data`: an NFS export over Hetzner's private network as a first step, or the S3 `BlobStore` (spec §3) for object storage. Uploads live there too, so a resumed upload can land on any server.
  - A Hetzner load balancer in front.
  - A distinct `CUTTINGFLOOR_NODE` per server (up.sh sets it to the server name).

**3. A render pool sized by load.**
- The work: exports and analyses move to worker servers.
- The scaling loop: a small script adds or removes servers through the Hetzner API (`hcloud server create/delete`, billed by the hour) according to how busy the workers are.
- Leaving the pool: a server leaves by finishing its jobs; one that dies has its jobs ended `interrupted` by the others within about 2 minutes.
- No Kubernetes is needed for this. k3s (`hetzner-k3s`) is the route if managing the servers by hand gets heavy.
