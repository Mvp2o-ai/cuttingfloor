# Hosting cuttingfloor on Hetzner Cloud

One server first. It's the same image as local, in hosted mode:
- bearer API keys, one owner per key
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
4. Run `./up.sh`. It does three things:
   - creates `cuttingfloor-1`, a CCX23 in Falkenstein, with Docker and gVisor
   - copies the compose file and the env file over SSH (cloud-init user data never holds a secret)
   - starts everything
5. Point an A record for the domain at the address it prints. Caddy gets the certificate on first request.
6. Run `./up.sh` again to deploy a new image.

**If the image is private:** export `GHCR_USER` and `GHCR_TOKEN` (`read:packages`) before running `up.sh`. Or make the GHCR package public in the GitHub UI.

**Not yet verified:** Chromium and `code.run` running under gVisor (spec §8.1). That's the first check on a new server. `scripts/smoke-motion.ts` runs those checks (escapes, network, abuse) against the local compose file. Point it at this one, whose sandbox runs under `runsc`, and run it on the server.

## Growing it

**1. One server, bigger.**
- `CUTTINGFLOOR_SERVER_TYPE=ccx33` or larger, then `./up.sh`.
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
