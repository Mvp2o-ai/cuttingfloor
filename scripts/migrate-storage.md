# Moving a data root: `scripts/migrate-storage.ts`

Moves a live filesystem data root (`/data`) into the target stores: records into MongoDB, files
into the bucket. It runs beside the old server while that server keeps serving, every 15 minutes,
then one last time after the old server is drained.

- The source is only ever read. It is mounted read-only (`:ro`) and the kernel holds the script to that.
- Nothing it prints or writes to a report holds a record's contents, an email, a key or a token:
  counts, sizes, the server's own ids, and hashed owner keys and names (`o:1a2b3c4d5e`, `#9f8e7d6c`).
- A second pass sends only what changed. Interrupted at any point (Ctrl-C, SIGTERM, a dropped SSH
  session), it saves what it did and the next run carries on.
- It never removes anything from the target because it expired at the source: only what is gone
  from the source altogether. After the switch, expiry is the new server's own sweep.

## Where things are

| | |
|---|---|
| Source | `cuttingfloor-1` (5.161.202.136, Ashburn). Data at `/data` in the `cuttingfloor` container, `/var/lib/cuttingfloor` on the host. |
| New server | `cuttingfloor-fsn1` (2.31.35.57, Falkenstein), temporary name `fsn.api.cuttingfloor.ai`, running with `CUTTINGFLOOR_STANDBY=1` (deploy/hetzner/README.md, "Standby") until the cutover. |
| Records | MongoDB Atlas, Frankfurt. Its access list holds both servers' addresses. |
| Files | The bucket `cuttingfloor-prod` in Falkenstein. Run `scripts/check-s3.ts` against it first: everything must hold, its rule aborting unfinished uploads must be 8 days or more, and it says whether the bucket enforces a sent SHA-256 or MD5. |
| State | `/var/lib/cuttingfloor-migrate` on the old server's host, outside the data root: the manifest, the reports, the final mark. Keep it between passes; copy it to the new server for the reread. |

## Setting up (once, on the old server)

**The image.** Every command names one release by version, never `latest`: the old server's own
`latest` moves with each release and a pass must not change version half way. Use the release
that contains this runbook (and the old server must itself run that release or later, for
draining):

```sh
IMAGE=ghcr.io/mvp2o-ai/cuttingfloor:vX.Y.Z      # the version tag of the release, or @sha256:…
```

**`migrate.env`: the migration's settings, never the server's.** The old server's own
`cuttingfloor.env` stays exactly as it is: with `CUTTINGFLOOR_BLOBS=s3` in it, any restart of
production (a release deploys automatically) would serve from the half-filled bucket. That file
already holds the bucket's and the database's credentials (unused by the old server, because
`CUTTINGFLOOR_BLOBS` and `CUTTINGFLOOR_RECORDS` are unset there); copy those lines into a file of
the migration's own:

```sh
cd /opt/cuttingfloor
grep -E '^CUTTINGFLOOR_(S3_|MONGODB_)' cuttingfloor.env > migrate.env
printf 'CUTTINGFLOOR_BLOBS=s3\nCUTTINGFLOOR_RECORDS=mongo\n' >> migrate.env
chmod 600 migrate.env
grep -c . migrate.env        # the S3 and MongoDB lines, plus the two above; nothing else
```

**The state folder**, writable by the image's user (`node`, uid 1000). The script checks this at
start, before any work, and stops if it cannot write there.

```sh
mkdir -p /var/lib/cuttingfloor-migrate
chown -R 1000:1000 /var/lib/cuttingfloor-migrate
chmod 700 /var/lib/cuttingfloor-migrate
```

**`migrate.sh`**, which every step below calls. It runs the pass detached under a fixed name (a
second pass refuses to start while one runs; a dropped SSH session cannot stop it), follows its
log, and exits with the pass's own exit code:

```sh
cat > /opt/cuttingfloor/migrate.sh <<'SH'
#!/bin/sh
# Usage: ./migrate.sh [options]   (see "Options")
set -u
IMAGE=ghcr.io/mvp2o-ai/cuttingfloor:vX.Y.Z
m() {
  docker run -d --name cf-migrate \
    --env-file /opt/cuttingfloor/migrate.env \
    -v /var/lib/cuttingfloor:/data:ro \
    -v /var/lib/cuttingfloor-migrate:/state \
    "$IMAGE" node scripts/migrate-storage.ts --source /data --state /state "$@" >/dev/null || exit $?
  docker logs -f cf-migrate
  code=$(docker wait cf-migrate)
  docker rm cf-migrate >/dev/null
  exit "$code"
}
m "$@"
SH
chmod +x /opt/cuttingfloor/migrate.sh
```

If `docker run` itself fails (a second pass while one runs: the name is taken; the image cannot
be pulled), `migrate.sh` exits with Docker's own code, 125. If the SSH session drops while
`docker logs -f` follows, the pass goes on; `docker logs -f cf-migrate` follows it again and
`docker wait cf-migrate` gives its exit code.

## The commands

**0. What moves.** `./migrate.sh --list-collections`.

**1. Dry run.** Touches nothing: counts and bytes per collection and kind of file, what is left
behind and why, and any record too big for the database.

```sh
./migrate.sh --dry-run
```

**2. First pass.** Hours: every file is read once and sent. It ends with a verify.

```sh
./migrate.sh --concurrency 4            # --bwlimit 20M holds reads to 20 MB/s; --concurrency 1 is gentlest
```

**3. Every 15 minutes until the cutover.** Exit 0 and 4 are both normal here; look at anything else.

```sh
*/15 * * * * /opt/cuttingfloor/migrate.sh >> /var/log/cf-migrate.log 2>&1
```

**4. Rehearsal on the new server (standby).** Use it as a client would. Do it with a test account
that exists only there, and leave that account out of every pass and verify:
`--exclude-owner <its user id>` (repeatable) on every command from here on (put it in
`migrate.sh`'s `m` call). Anything else a test touches (a real account's media, a timeline)
shows in the next verify; put it back with:

```sh
./migrate.sh --repair                      # rewrites what differs at the target; lists extras
./migrate.sh --repair --prune-extras 50    # and removes up to 50 things only the target has
```

`--repair` compares everything (records by value and last use, files by size and recorded hash,
every log part, every carried upload as the bucket holds it), whatever the manifest says. Never
start over with a fresh `--state` folder for this: a fresh manifest is not a repair.

## The cutover

Each step in order. Writes made on the new server after step 9 are never copied back.

1. **The key links are signed with.** The old server signs with `secret.key` in its data root
   (its env has no `CUTTINGFLOOR_URL_SECRET`). The new server must sign with the same key: its
   `CUTTINGFLOOR_URL_SECRET` is the `key` value of `/var/lib/cuttingfloor/secret.key` on the old
   server, set by hand. Check it, on the new server:
   ```sh
   docker exec cuttingfloor node scripts/url-key-fingerprint.ts
   # 3f2a…  (CUTTINGFLOOR_URL_SECRET)      → FP=3f2a…
   ```
   (If the old server ever gets `CUTTINGFLOOR_URL_SECRET` itself, give the migration
   `CUTTINGFLOOR_SOURCE_URL_SECRET` with that value in `migrate.env`.)
2. **Stop the cron**, and see that no pass is running:
   ```sh
   crontab -l | grep -v migrate.sh | crontab -
   docker ps --filter name=cf-migrate --format '{{.Names}}'     # nothing
   ```
3. **Drain the old server**: no new work, running jobs finish (deploy/hetzner/README.md, "Draining").
   ```sh
   touch /var/lib/cuttingfloor/drain
   curl -s https://api.cuttingfloor.ai/healthz/drain    # until "jobs_running":0
   ```
4. **Final pass.** Read `deletes.planned` in `/var/lib/cuttingfloor-migrate/summary-pass.json`
   from the last cron pass: about that many things went from the source since; give a little more.
   ```sh
   ./migrate.sh --final --allow-deletes 200 --links all --app-reads all \
     --target-key-fingerprint "$FP" --target-url https://fsn.api.cuttingfloor.ai
   ```
   It refuses (exit 2) unless the old server is draining with no job running. It takes every file
   however recent, reads every record again by content, carries again any upload carried more
   than 6 hours ago, compares the signing keys and fetches a signed download and upload link from
   the new server. It must exit 0. It then marks the state folder and the target, and any later
   pass is refused (`--after-final` overrides that, only to put right a wrong final pass before
   traffic moves).
5. **Verify on the old server** (records field by field, sizes, links): `./migrate.sh --verify --links all`.
6. **Reread on the new server**: every file read back from the bucket (about 90 MB/s there, so
   about 15 minutes for 77 GB) and hashed against the hashes the migration took from the source.
   ```sh
   # on the old server
   scp -r /var/lib/cuttingfloor-migrate root@2.31.35.57:/var/lib/
   # on the new server, with a migrate.env made as above from its own env
   chown -R 1000:1000 /var/lib/cuttingfloor-migrate
   docker run --rm --env-file /opt/cuttingfloor/migrate.env \
     -v /var/lib/cuttingfloor-migrate:/state "$IMAGE" \
     node scripts/migrate-storage.ts --source /data --state /state --verify --reread all
   ```
   (`--source /data` names the old server's data root as the manifest does; it is not read.)
   Exit 0, or stop and look.
7. **The new server out of standby**: in its `cuttingfloor.env` remove `CUTTINGFLOOR_STANDBY`, put
   back `RESEND_API_KEY`, then `docker compose up -d`. It writes its `live` mark; the migration
   refuses to write into it from now on.
8. **Traffic.** Set the `api` A record to 2.31.35.57 (its TTL is already 60 s). Clients that still
   reach the old server meanwhile get its drained 503 with `Retry-After`, and retry. After 10
   minutes, `curl -s https://api.cuttingfloor.ai/healthz` answers from the new server (check its
   logs), and the old server's access log goes quiet. Then check sign-in through ChatGPT and
   Claude (tokens are issued for `api.cuttingfloor.ai`), an upload from the phone app, and an
   old download link.
9. **The old server stays as it is** (drained, data untouched) for a week as the way back, then
   is stopped. Its `cuttingfloor.env` was never changed.

## Rolling back

- **Before step 8:** `rm /var/lib/cuttingfloor/drain` on the old server, and the new server back to
  `CUTTINGFLOOR_STANDBY=1`. Nothing was lost: the old server's data is as it was.
- **After step 8:** point the `api` A record back at 5.161.202.136 and `rm /var/lib/cuttingfloor/drain`
  on the old server. **Everything made on the new server after the switch is lost to the old
  one** (uploads, imports, edits, exports, keys, sign-ups, the call log): nothing copies back.
  The old server carries on from the moment it was drained.

## Options

| | |
|---|---|
| `--source <dir>` | The data root. Default `CUTTINGFLOOR_DATA`, else `/data`. |
| `--state <dir>` | Manifest and reports. Required; never inside the source. One per source and target pair. |
| `--target-dir <dir>` | A filesystem data root as the target (tests), or where records go without `CUTTINGFLOOR_RECORDS=mongo`. |
| `--dry-run`, `--verify`, `--no-verify` | As above. |
| `--final` | Writes have stopped: take everything, trust nothing by size and time, leave nothing waiting. Needs a drained source (`--no-drain-check` skips that). |
| `--after-final` | A pass after the final one ended clean. |
| `--repair`, `--prune-extras <n>` | See step 4 of "The commands". |
| `--exclude-owner <owner>` | An account left alone on both sides. Repeatable. |
| `--reread <all\|f\|n>` | With `--verify`: read files back from the target and hash them (all, a share like `0.1`, or a count). Needs only `--state` and the target settings. |
| `--app-reads <all\|n>` | Media, outputs and uploads resolved through the server's own readers at the target. Default 20 of each. |
| `--target-key-fingerprint <fp>` | The new server's link-key fingerprint. Required by `--final`. |
| `--target-url <url>` | The new server's address: a signed download and upload link are fetched from it. |
| `--allow-deletes <n>` | Remove from the target up to `n` things gone from the source, past the share below. |
| `--max-delete-fraction <f>` | Without `--allow-deletes`, at most this share of what was moved. Default 0.1. |
| `--allow-shrink` | Run although the source holds a fifth fewer accounts or bytes than at the last pass. |
| `--concurrency <n>`, `--record-concurrency <n>`, `--bwlimit <rate>` | Files at once (4), records at once (8), most read per second (`20M`). |
| `--links <n\|all>` | Signed links from job results and the email log to check. Default 200. |
| `--blob-check <sha\|size>` | `sha` (default) reads back a file whose store keeps no hash; `size` trusts its size. |
| `--rehash` | Read every source file again instead of trusting the manifest. |
| `--settle <seconds>` | Leave files written less than this ago for the next pass. Default 60. |
| `--ignore <path>` | Leave out a file or folder by its path under the data root (`lost+found`). Repeatable. |

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done, verified, the same. | Nothing. |
| 1 | A write failed, the source could not be read (a folder or file that is there but cannot be listed or read), or the run broke (the database or the bucket out of reach; the state folder not writable). Nothing was removed from the target. | Read the `FAILED` lines; run it again. |
| 2 | Refused before writing anything. | See "Refused" below. |
| 3 | The target differs from the source, or holds a record too big for it; or `--final` found something still changing. | See "Differences" below. |
| 4 | Things changed under the pass and wait for the next, or a record could not be read (`UNREADABLE`). A lone `--verify` exits 4 too while the source is live. | Normal while the source is live. Not from `--final` (which reports 3). |
| 5 | More had gone from the source than a pass removes unasked, or than `--allow-deletes` allows, or than `--prune-extras` allows; nothing was removed. | Read the counts by kind and owner it printed; if right, run with `--allow-deletes <n>`. |
| 6 | Interrupted (SIGINT, SIGTERM, SIGHUP). | Run it again. |
| 125 | Docker could not start it (another pass is running: the name `cf-migrate` is taken; the image cannot be pulled). | `docker ps -a --filter name=cf-migrate`; wait for it, or `docker rm` a stopped one. |

## Refused (exit 2)

- `UNKNOWN <path>`: a file or folder the script cannot name. Never skipped silently. If it is
  junk (`lost+found`), pass `--ignore <path>`; if the server keeps it, the script needs a rule.
- `NO RULE for collection <name>`: a collection added since the script was written. Add it to
  `COLLECTION_RULES` in `packages/server/src/migrate/layout.ts`.
- `PATH IMPORT`: a media whose file is outside the data root (local mode). Cannot exist on hosted.
- `does not look like a server's data root`: no accounts, or no `owners/` with `secret.key` or
  `keys/`. Almost always the `-v` mount: Docker makes an empty folder for a path that does not exist.
- `… at the last pass`: the source holds a fifth fewer accounts or bytes than last time. Check the
  mount; `--allow-shrink` if it is right.
- `the final pass already ended clean`: remove the cron. See step 4 of the cutover.
- `a server serves on the target`: the new server was started out of standby. Put it back in standby.
- `not draining`, `still runs N jobs`: step 3 of the cutover.

## Differences (exit 3)

The table printed after a verify names each kind; `verify-report.json` in the state folder lists
every one.

| Kind | What it means | What to do |
|---|---|---|
| `record-missing` | A source record is not at the target. | Run a pass; if it stays, look for a `FAILED` line for it. |
| `record-differs`, `record-time` | Fields (named, never their values) or the last use differ. | Something wrote to the target (a test on the standby server): `--repair`. |
| `record-extra`, `blob-extra` | The target holds a record or file the source does not have at all. | Made on the standby server: `--repair --prune-extras <n>`, or `--exclude-owner` for a test account. |
| `log` | Call log entries missing or extra. | `--repair` sends every part again. |
| `blob-missing`, `blob-size`, `blob-sha256` | A file is not at the target, or not the same bytes (`of: reread` when found by reading it back). | `--repair`, or `--rehash` to read every source file again. |
| `upload-offset`, `upload-parts`, `upload-state` | An upload carried part way is not as its record says in the bucket (its parts, or the state its record names). | `--repair` carries it again. |
| `usage` | An owner's stored bytes differ from what the target's own rules expect. | Follows from a blob difference above. The report's `stored_twice_bytes` says how much more the bucket stores than the disk did for files shared by hard link (a deduplicated media's search index is copied there): that is expected, and counts against the account's storage. |
| `age` | An upload's or a kept frame set's folder is not as old at the target. | Run a pass (it sets them last). |
| `link` | A link already handed out names a file the target does not hold. | Follows from `blob-missing`. |
| `link-live` | A link signed with the old key, fetched from the new server, failed. | The new server's `CUTTINGFLOOR_URL_SECRET`, or the file: see the detail. |
| `signing-key` | The new server signs with another key, or none was compared. | Step 1 of the cutover. |
| `app-read` | A media, output or upload does not resolve through the server's own readers to a file of the source's size. | A mapping fault in the migration: stop and look. |
| `TOO BIG` | A record over the database's 16 MB. | It cannot move as a record. Production's largest was 74 KB. |

## What is moved, and how it is found

- **Records:** every collection the code defines (`--list-collections`), each read through
  `FsRecords`, so a media's `file`, `mezzanine` and `proxy` arrive as blob keys. An upload's last
  use is the later of its record's and its folder's (bytes arriving write the folder).
- **The call log:** each `calls/{day}.{node}.jsonl`, entry by entry, each with its own time, read
  to the size its stat gave (lines appended meanwhile go next pass).
- **Files:** everything under an owner's `media/{id}/`, `uploads/{id}/` and `outputs/{id}/`.
- **Holders:** files shared by hard link are stored once and shared; a media whose record names
  another's file without a link also counts as one of its holders in the bucket.
- **Kept time:** a record's last use is its file's mtime, and so is each upload's and frame set's
  folder. Nothing gets a fresh 7 days.

## What is not moved

- `models/` (fetched again), `cache/` (disposable), `secret.key` (step 1 of the cutover), `drain`
  and `draining` (the old server's switch and marker).
- `owners/*/usage/` (legacy counts) and `owners/*/code/` (legacy `code.run` scratch).
- Files the server is still writing, by the server's own temporary names (`name.{pid}.tmp`,
  `name.{pid}.{hex}.tmp`, a search index's `*.part`). A user's own file called `clip.part` moves.
- Anything past its time at the source that was never moved: it is not moved. Anything past its
  time that was moved earlier stays at the target for the target's own sweep.
- Files with no record: a media folder without `media.json`, an output without its job. Counted
  in the summary; never removed from the target while the source has them.

## How it behaves on a live source

- Records are replaced by rename, so a read sees one whole version; the script stats before and
  after and reads again on a change. One that still cannot be read is `UNREADABLE`: it waits
  (exit 4), and nothing of it is removed from the target.
- A file written in the last minute, or belonging to a job still working, waits for the next pass.
- A record that names a file not yet at the target waits with it.
- An upload still arriving: its whole 16 MiB parts go into a multipart upload at the target, and
  its record there carries `offset`, where the sender resumes. Carried again after 24 hours, and
  by the final pass after 6: the bucket aborts unfinished uploads after 8 days and an upload link
  lasts 7 days and an hour, so at worst the multipart upload is 7 days 7 hours old when its link ends.
- A listing, stat or read that fails for any reason but "not there" stops the pass (exit 1). Only
  what is gone from the source altogether is removed from the target, only after every write of
  the pass went through, and at most a tenth of what was moved without `--allow-deletes <n>`.

## The manifest

`manifest.json` in the state folder: for each file its size, mtime, inode, SHA-256 and target
key; for each record its size, mtime, inode and a hash of what was written; for each log part the
size sent; for each carried upload its parts; the source's size at the last pass. Written once a
minute and at the end. Lose it and the next pass reads and hashes everything once more, finds what
is already at the target, and rebuilds it.

`final.json` beside it marks a final pass that ended clean (the target has the same mark in its
`migration` collection). `summary-*.json` and `verify-report.json` are the machine-readable result
of the last run of each kind.
