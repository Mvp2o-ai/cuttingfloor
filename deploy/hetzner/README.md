# Hosting cuttingfloor on Hetzner Cloud

One server first. It's the same image as local, in hosted mode:
- OAuth sign-in through WorkOS AuthKit (each user is an owner), keys users make on the account page for scripts, and maintenance API keys alongside
- imports from a URL, or of a file sent to a signed upload URL (`media.upload`, resumable, kept 7 days until imported)
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
- `RESEND_API_KEY` sends account email (welcome, credits running low, a failed payment) from support@cuttingfloor.ai, or from `CUTTINGFLOOR_EMAIL_FROM` with replies to `CUTTINGFLOOR_EMAIL_REPLY_TO` when those are set (the domain is verified in Resend, its records in the Hetzner DNS zone).
- The sign-up sequence (`apps/hosted/src/sequence.ts`) sends a welcome within a minute of signing up, then one follow-up `CUTTINGFLOOR_FOLLOW_UP_AFTER_HOURS` later (72 by default): "Did it work?" without a first edit (a successful `export.video`, `first_edit_at` in WorkOS metadata), "How was the first edit?" with one; and `CUTTINGFLOOR_CREDITS_AFTER_HOURS` after signing up (168 by default), while at least one credit is left, "Your cuttingfloor credits are waiting", sending people back to the AI app they connected (`first_client`) or, with none of their own, to Kazi. It needs `RESEND_API_KEY`, `CUTTINGFLOOR_EMAIL_FROM`, `CUTTINGFLOOR_EMAIL_REPLY_TO`, `CUTTINGFLOOR_EMAIL_SIGNER` and `CUTTINGFLOOR_UNSUBSCRIBE_SECRET`, and logs `sequence: off` naming what is missing.
  - The copy is `apps/hosted/email/*.txt`, each with a `version:` that every send logs. The server reads `/opt/cuttingfloor/email` (mounted at `CUTTINGFLOOR_EMAIL_TEMPLATES`) at every send: change a file in the repo, bump its version, then `scp apps/hosted/email/<file> root@<server>:/opt/cuttingfloor/email/`. No deploy or restart.
  - In Resend, add a webhook to `<CUTTINGFLOOR_PUBLIC_URL>/email/events` for `email.bounced` and `email.complained`, and put its signing secret in `RESEND_WEBHOOK_SECRET`. Keep open tracking off for the domain (the sequence adds no pixel of its own); click tracking may stay off too.
  - What each account was sent is under `owners/<id>/email/` (no TTL: one welcome, ever) and every attempt under `email-log/` (400 days), by account id, never by address. Unsubscribes are `owners/<id>/email/unsubscribed.json`; bounced and complained addresses are `email-suppressions/<sha256>.json`.
- `CUTTINGFLOOR_ACCOUNT_KEY` is shared with the site, which acts for the signed-in account: its credits (`GET /account/usage`), its files and storage (`GET /account/media`), starting an upload from the account page's drop zone (`POST /account/uploads`; the browser then sends the file straight to the signed upload URL), and the account's keys for scripts (`GET`/`POST /account/keys`, `POST /account/keys/revoke`). A script key (`cf_…`) calls `/mcp` as its account, with the same plan checks as a sign-in; only its SHA-256 is stored (`keys/` under the data root), and it works for a year or until revoked.
- `KAZI_CREDITS_URL` and `KAZI_CREDITS_KEY` connect the server to Kazi's credit ledger, which holds the balance of every account without a given plan, for both products. The first time an account is checked it is linked (`POST /api/credits/account`), carrying over the balance it had here (free credits less what it used, less the ledger's own grant, and each pack it bought by payment intent), and the link is kept in `owners/<id>/ledger/link.json`. Each job that ends after is spent there once (`POST /api/credits/usage`, idempotent by job id; `owners/<id>/ledger-spent/` marks it, and the sweep retries any a server missed for 30 days). The ledger runs automatic top-up (`POST /account/top-up` sets it) and says when a spend crossed below 5 credits or to zero, which we email. Given plans (staff, lifetime, enterprise) stay in WorkOS and never touch the ledger. The ledger holds only the key's SHA-256. When it can't be reached, new accounts are refused retryably and accounts let in within 30 minutes keep working.
- `CUTTINGFLOOR_PARTNER_KEYS` lets a partner whose users never sign in here (the Cutting Floor AI app, through one-mcp) get a script key for each of them: `POST /partner/keys {email, sub}` with the partner's secret as the bearer answers `{key, key_id, owner, expires_at, created}`. The account is the one with that email, made (verified) when there is none; each call makes a new key and revokes the partner's earlier one for that account, which shows on the account page under the partner's name. A user id (`sub`) stays tied to its email (`partners/<name>/<sha256>.json`, 400 days after its last key): another email for it is refused with 409. Accounts a partner made get no welcome email from us. Only the secret's SHA-256 is in the env. The same secret deletes a user's account when they delete theirs with the partner (the login is shared): `DELETE /partner/users {email, sub}` deletes the account with that email, and the one tied to that `sub`, however it was made, with everything the server keeps for it (its `owners/<id>` folder, script keys, partner links, cached frames, email log lines and suppression) and last its WorkOS user. It answers `{deleted: true}`, or 404 `{error: "account_not_found"}` when there is none, so a repeat is a 404; a 503 means part is still there and a retry finishes it. The credit ledger is the partner's to delete; Stripe keeps the account's payments.
- Plans, their credits and limits are `packages/plans`; the server and the site both read it.

**Check accounts and billing:** `CHROME_PATH=<chrome> node scripts/smoke-account.ts https://cuttingfloor.ai`. It signs a throwaway user up on the site, checks the account and welcome pages, opens Checkout, then checks the server's rules on the real WorkOS and Stripe: free-plan limits, a refused unverified email, refusal when WorkOS can't be reached, no time limit on the free plan, subscribed, lifetime.

**Check paying accounts:** `ssh root@<server> 'cd /opt/cuttingfloor && docker compose exec -T cuttingfloor node scripts/smoke-paid.ts'`. On the server, with production's keys, it subscribes a throwaway account to Creator (monthly) and Pro (yearly) through a 100%-off coupon (real paid $0 invoices, no card), and checks through `/mcp` and `/account/usage` that each plan is honoured with its limits, that a yearly plan's minutes renew monthly, that the webhook arrives, and that cancelling returns it to the free plan.

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
  - One `CUTTINGFLOOR_URL_SECRET` on every server (32 bytes or more, base64 or base64url), so a link one server signed opens on any of them; set to the `key` value in the data root's `secret.key`, links already handed out keep working, and with it set that file is never made or read.

**Records in MongoDB.** `CUTTINGFLOOR_RECORDS=mongo` moves every record (timelines, media and job records, uploads' state, keys, the meter, notices, the call log) from JSON files under `/data` into a MongoDB database that every server shares; files stay under `/data`.
- The database: `CUTTINGFLOOR_MONGODB_HOST` with `CUTTINGFLOOR_MONGODB_USER` and `CUTTINGFLOOR_MONGODB_PASSWORD`, or whole as `CUTTINGFLOOR_MONGODB_URI` (which wins); `CUTTINGFLOOR_MONGODB_DB` names the database (default `cuttingfloor`). Values are trimmed, so a secrets file's trailing newline does no harm.
- Which kind of host: a name ending in `.mongodb.net` with no port is an Atlas cluster and is looked up as SRV (`mongodb+srv://`); any other host (`mongo`, `localhost`, `10.0.0.5:27017`, several with commas) is plain `mongodb://`. Start the host with `mongodb://` or `mongodb+srv://` to say which yourself.
- Starting: the server connects and makes its indexes before it listens, and does not start when it cannot connect or an index cannot be made (the error names the collection and index). The database's access list must hold the server's address.
- What is logged: the user and password never are, in a log line or an error. A failed connection or query is logged with the driver's own words, which can name the database's hosts; a client is only told the server could not reach its records.
- Size: a record is one document, up to the database's 16 MB; a bigger one is refused with a plain error. A media's analyses (transcripts, sounds, faces), the only things that grow large, are files beside the media, not records.
- Periodic work: the hourly sweep, the job reaper, the account emails and the sign-up sequence run on one server at a time (a 60-second lease in the `locks` collection that the others take over when its holder stops).
- A server left on the default keeps its files and never loads the database driver.
- Switching an existing server needs its records moved first: started on an empty database it sees no accounts' records. `scripts/migrate-storage.ts` moves them, and the files, from a live data root; its runbook is `scripts/migrate-storage.md`.

**Files in a bucket.** `CUTTINGFLOOR_BLOBS=s3` moves every file (media sources, mezzanines, proxies, analyses, derived files, uploads, exports, kept frames) from `/data` into an S3 bucket every server shares; `/data` then holds only that server's caches. Meant to run with records in MongoDB: the holder counts below are compare-and-set, which the JSON-file records do for one process only.
- The bucket: `CUTTINGFLOOR_S3_ENDPOINT`, `CUTTINGFLOOR_S3_REGION`, `CUTTINGFLOOR_S3_BUCKET`, `CUTTINGFLOOR_S3_ACCESS_KEY_ID`, `CUTTINGFLOOR_S3_SECRET_ACCESS_KEY`. It is addressed as a host under the endpoint (`CUTTINGFLOOR_S3_PATH_STYLE=1` for a path instead, as MinIO wants). Private: nothing is public, every download is a signed link.
- Starting: the server asks the bucket for itself before it listens, and does not start when a setting is missing or the bucket refuses it; the error names the variable, never a key. It also learns then whether the bucket honours a put that must not replace (`If-None-Match: *`), and claims such writes in its records where it does not.
- Layout: `media/{owner}/{media_id or upload_id}/{name}`, `derived/{owner}/{media_id}/…`, `outputs/{owner}/{job or frames id}/{name}`, and `tmp/` for the store's own probes. Cached frames (`cache/`) and models stay on the server.
- Downloads and playback: the links are the same (`/outputs/…`, `/watch/…` on this server). The server checks the signature, then answers 302 to a link to the file itself that works one hour; ranges, seeking and resuming are the bucket's. `HEAD` is answered by the server. The watch page and the views that play media allow the bucket's origin.
- Only sound, video and raster pictures are shown in a page from the bucket (`inline=1`); anything else (an SVG, HTML, a document) downloads whatever the link asks, so a signed link never makes the bucket's origin serve a page. The redirect is kept by the browser no longer than the link it answers lasts, ten minutes at most.
- **A reviewed change, possibly:** switching production to the bucket adds its origin to the CSP domains the player, editor and library views declare (`resourceDomains`/`connectDomains` in their `_meta`). That is view metadata, not reviewed text, but an app directory may treat a new declared domain as a change to review: tell the ChatGPT plugin and Claude directory reviews before the switch, and check the views live in both hosts after it.
- The bucket's CORS rule must allow `GET` and `HEAD` from any origin (a view reads an export's sound from its sandbox) and expose `content-length`, `content-range` and `etag`; Hetzner applies only the first rule whose origin matches.
- Settings that cannot work refuse to start: files in a bucket need records in MongoDB (`CUTTINGFLOOR_S3_FILE_RECORDS=1` allows files, for development and tests only); a bucket name with dots needs `CUTTINGFLOOR_S3_PATH_STYLE=1`; `CUTTINGFLOOR_S3_PART_MB` is 5 to 64 (an upload sent in order holds about twice that in memory while it is gathered into a part: 32 MiB at the default 16).
- Turns: requests to the bucket take one of 64 turns (`CUTTINGFLOOR_S3_CONNECTIONS`), except parts streamed at a sender's pace (numbered parts), which take one of 32 of their own and at most 6 per upload, so slow senders never hold up downloads and other requests. Such a part streams through (about 64 KiB of buffers), never held. A bucket request idle for two minutes is given up.
- Uploads: every upload still goes to this server's upload link, which streams it into the bucket's upload in parts and keeps nothing on disk. The link takes the file whole or in ranges as before (same answers and headers), and also as numbered parts, several at once: `GET {link}/parts?bytes={size}` (sets it up, lists the parts that are in), `PUT {link}/parts/{n}`, `POST {link}/complete`. An upload's state is its record, so any server takes any part. The proxy in front must not buffer request bodies.
- The bucket's lifecycle rules: aborting incomplete uploads must be after 8 days or more, not 2: an upload link works 7 days and an upload paused longer than the rule is lost. `tmp/` after 2 days is fine (nothing lasting is kept there).
- The cache: `CUTTINGFLOOR_BLOB_CACHE` (default `cache/blobs` under the data root) holds this server's copies of files engines read, up to `CUTTINGFLOOR_BLOB_CACHE_GB` (default 50), the least recently used going first and nothing used in the last hour. Put it on the fastest disk. Losing it loses nothing.
- Shared files: the same bytes sent or rendered again import as the media already there ("already imported", no credit), as on disk; an upload is claimed by its import, so two imports of one upload make one media. A link fetched twice is one object held by two media; how many media hold it is a count in the `blobs` collection, and the object goes with its last holder. The hourly sweep also puts right what a crash between the bucket and the records leaves (a file nothing holds, a count that is off), a day after the fact.
- What is logged: the keys never are, nor an account id: a failed request to the bucket is logged with the SDK's own words (which can name the endpoint and an object), with every owner in an object's name replaced by a hash of it (`o-…`); a client is only told the server could not read or write a file.
- `CUTTINGFLOOR_S3_CHECKSUM` has the bucket check bytes as they arrive: `md5` sends `Content-MD5` with every body the server has in hand (whole-object puts, parts of a file, parts of an in-order upload), `sha256` sends each whole-object put's SHA-256. Set the one `scripts/check-s3.ts` says the bucket enforces: Hetzner Object Storage enforces MD5 and ignores the SHA-256 (checked 2026-11-22). A part streamed from a client at its own pace carries none.
- `scripts/check-s3.ts` checks a bucket for everything the store relies on, writing only under `tmp/check-…/` and removing it: run it against a new bucket before the server uses it.
- A server left on the default keeps its files on disk and never loads the S3 SDK.
- Switching an existing server needs its files moved first: `scripts/migrate-storage.ts` (runbook `scripts/migrate-storage.md`).

**Standby: a second server on a copy of the data.** During the move a new server runs on the migrated copy while the old one is still production. Set `CUTTINGFLOOR_STANDBY=1` on the new one. It answers every request as usual (sign in, import, edit, export, upload: use it as a client would), and does nothing to the data by itself, because the copy's "last used" times are only as fresh as the last copy pass and its people must not hear from two servers. It logs one line at start saying so. What it turns off:
- The sweep at start and every hour (`Runtime.start`, `Runtime.sweep`): timelines, media, finished jobs and their outputs, kept frames, uploads, the meter, the call log, sign-in steps.
- Job recovery at start and the job reaper every minute (`JobRunner.recover`): a job the old server is running is not marked interrupted in the copy.
- The lifecycle's sweep at start and every 10 minutes (`Lifecycle.sweep`): new accounts, the welcome, expiry notices, key and partner-link sweeps, the catch-up of ledger spend.
- The sign-up email sequence (`Sequence`): it is not made, so its webhook and unsubscribe routes are not served either.
- All email: no mailer is made, whatever `RESEND_API_KEY` holds.
- Anything that costs money, messages a person or changes what production shares: jobs run unmetered (no ledger spend, no usage report to the ledger, so no automatic top-up and no low-credit notice or its marker), no WorkOS metadata is written (first call, tool, export and edit marks, last used), and `POST /account/top-up`, `DELETE /partner/users` and `POST /stripe/webhook` answer 503. The client is told nothing different.
- Still on, and harmless: sign-in (WorkOS and the ledger are read to check an account), reads, what a request writes to the copy itself (records, call log, meter entries, files), each job's own heartbeat, the five-minute refresh of the sign-in server's metadata, clearing this server's own cached frames at start, and the account page's routes that write only to WorkOS on the user's own request (provider keys, notification settings, script keys), which nobody reaches on the temporary name.
- On a database it removes the `live` mark in the `migration` collection as it starts (a server started out of standby writes it), so the migration may write into it; the migration refuses a store with that mark.
- At the cutover: unset `CUTTINGFLOOR_STANDBY` and restart (`docker compose up -d`). Unset is the default and changes nothing.

**Draining: no new work, for the cutover.** `touch /var/lib/cuttingfloor/drain` on the host (no restart; `CUTTINGFLOOR_DRAIN=1` does the same from the start) and within 5 seconds the server takes no new work: tool calls that are not read-only (edits, imports, exports, uploads started), upload PUTs and parts, and the account page's new uploads answer 503 with `Retry-After: 120` and a plain message, as an outage does (no contract text changes). Reads, downloads, watch pages, `job.get` and `media.list` keep working, and running jobs finish. `GET /healthz/drain` answers `{"draining":true,"jobs_running":N,"since":…}`, and the server keeps a `draining` file in the data root with the same, which the migration's final pass reads. `rm /var/lib/cuttingfloor/drain` ends it. The old server must run a release that has this before the cutover.

**Before a second server.** Records in MongoDB make two servers possible; these still assume one, and are to be dealt with first:
- Leases are not fenced: a server that loses a lease mid-turn (a stall, the database out of reach for a minute) finishes the turn it began while another starts its own (`packages/core/src/storage/mongo-records.ts:457`; the turns at `packages/server/src/runtime.ts:339,353`, `apps/hosted/src/lifecycle.ts:150`, `apps/hosted/src/sequence.ts:136`). Emails stay single because each is claimed by `insertOnce`; sweeps would overlap.
- A job's heartbeat fails silently (`packages/jobs/src/index.ts:762`): with the database out of reach for over 2 minutes, the reaper on another server ends healthy jobs as interrupted.
- `recover()` at startup takes a working job with no `node` as this server's (`packages/jobs/src/index.ts:608`).
- The idempotency pointer is read, then written (`packages/jobs/src/index.ts:142`): the same key on two servers at once starts two jobs.
- Jobs at once per account and per lane, queue position and estimates are counted per server (`packages/jobs/src/index.ts:459`).
- With files on disk, an upload takes one sender at a time per server only (`#busy` in `packages/server/src/uploads.ts`). With files in a bucket its state is its record, moved on by compare-and-set, and any server takes any part.
- With files in a bucket, a file made from a media (cleaned sound, in-between frames, a selection copy, a search index) is stored when it is made and fetched by the server that needs it, but two servers asked at the same moment each make it (`making` in `packages/engine/src/sourcepass.ts` and `selection.ts`, the indexer's queue in `packages/server/src/indexer.ts`): the second write replaces the first with the same content.
- Each server's cache of files (`CUTTINGFLOOR_BLOB_CACHE`) is its own: a file one server just made is fetched from the bucket by the next.
- Work shared by calls on one server is shared only there: the onboarding sample (`packages/server/src/tools/credits.ts:164`) and copy jobs (`packages/server/src/copy-jobs.ts:30`) can be started twice.
- `Rights.grant` and `revoke` read, change and write (`apps/hosted/src/rights.ts:46,60`), as does the list of apps an account was seen from (`apps/hosted/src/apps-seen.ts:45`): two at once, one is lost.
- Credits are cached 5 minutes per server (`apps/hosted/src/access.ts:112`): a top-up taken by one server is unseen on another for that long.
- `owners()` asks every collection for its owners (`packages/core/src/storage/mongo-records.ts:431`), and the reaper asks each owner for its working jobs every 60 seconds (`packages/jobs/src/index.ts:216`): fine for hundreds of accounts, a query across owners for thousands.
- Waiting on a job or the floor polls every second (`packages/server/src/result.ts`, `packages/core/src/floor.ts`); change streams would replace that.

**3. A render pool sized by load.**
- The work: exports and analyses move to worker servers.
- The scaling loop: a small script adds or removes servers through the Hetzner API (`hcloud server create/delete`, billed by the hour) according to how busy the workers are.
- Leaving the pool: a server leaves by finishing its jobs; one that dies has its jobs ended `interrupted` by the others within about 2 minutes.
- No Kubernetes is needed for this. k3s (`hetzner-k3s`) is the route if managing the servers by hand gets heavy.
