# Hosting cuttingfloor on Hetzner Cloud

One server first. It's the same image as local, in hosted mode:
- OAuth sign-in through WorkOS AuthKit (each user is an owner), and bearer API keys alongside
- URL imports only
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

**Check it:** `CF_KEY=<a key from CUTTINGFLOOR_API_KEYS> node scripts/smoke-hosted.ts https://<domain>`. It checks that a request without a key is refused, then the sandbox (`create.still`, `create.motion`, `code.run`), `look` on the server's TypeSafe key, and an export's signed link.

**Check sign-in:** `WORKOS_API_KEY=sk_… CHROME_PATH=<chrome> node scripts/smoke-oauth.ts https://<domain>`. It makes a throwaway WorkOS user, registers a client with AuthKit as an MCP client does, signs in on AuthKit's page in headless Chrome, calls tools with the token, then deletes the user and the client. AuthKit caches its metadata for five minutes, so a registration setting changed there takes that long to show.

**If the image is private:** export `GHCR_USER` and `GHCR_TOKEN` (`read:packages`) before running `up.sh`. Or make the GHCR package public in the GitHub UI. Or build on the server from this checkout's HEAD: `CUTTINGFLOOR_BUILD=1 ./up.sh`.

**Verified under gVisor:** `create.still`, `create.motion` and `code.run` run with the sandbox under `runsc` (systrap). The deeper escape and abuse checks in `scripts/smoke-motion.ts` still run only against the local compose file.

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
  - A shared `/data`: an NFS export over Hetzner's private network as a first step, or the S3 `BlobStore` (spec §3) for object storage.
  - A Hetzner load balancer in front.
  - A distinct `CUTTINGFLOOR_NODE` per server (up.sh sets it to the server name).

**3. A render pool sized by load.**
- The work: exports and analyses move to worker servers.
- The scaling loop: a small script adds or removes servers through the Hetzner API (`hcloud server create/delete`, billed by the hour) according to how busy the workers are.
- Leaving the pool: a server leaves by finishing its jobs; one that dies has its jobs ended `interrupted` by the others within about 2 minutes.
- No Kubernetes is needed for this. k3s (`hetzner-k3s`) is the route if managing the servers by hand gets heavy.
