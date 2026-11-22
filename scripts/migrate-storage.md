# Moving a data root: `scripts/migrate-storage.ts`

Moves a live filesystem data root (`/data`) into the target stores: records into `Records`
(MongoDB with `CUTTINGFLOOR_RECORDS=mongo`), files into a `BlobStore`. It runs beside the old
server while that server keeps serving, as often as needed, then one last time after writes stop.

- The source is only ever read. Mount it read-only (`:ro`) and the kernel holds the script to that.
- Nothing it prints or writes to a report holds a record's contents, an email, a key or a token:
  ids, counts, sizes and hashed owner keys (`o:1a2b3c4d5e`) only.
- A second pass sends only what changed. Interrupted at any point, the next run carries on.

## Where things are

| | |
|---|---|
| Source | `cuttingfloor-1` (5.161.202.136, Ashburn). Data at `/data` inside the `cuttingfloor` container, `/var/lib/cuttingfloor` on the host. |
| New server | `cuttingfloor-fsn1` (2.31.35.57, Falkenstein), temporary name `fsn.api.cuttingfloor.ai`, started with `CUTTINGFLOOR_STANDBY=1` (see deploy/hetzner/README.md, "Standby"). |
| Records | MongoDB Atlas, Frankfurt. Its access list holds both servers' addresses. |
| Files | The bucket in Falkenstein: `CUTTINGFLOOR_BLOBS=s3` with the `CUTTINGFLOOR_S3_*` variables, as the new server has them (`blobTargetFromEnv` in `packages/server/src/migrate/target.ts`). Records then go to MongoDB (`CUTTINGFLOOR_RECORDS=mongo`), or, with `--target-dir`, to JSON files there. Run `scripts/check-s3.ts` against the bucket first, and see that its rule aborting incomplete uploads is 8 days or more. |
| State | A folder on the old server's host, outside the data root: `/var/lib/cuttingfloor-migrate`. It holds the manifest and the reports. Keep it between passes. |

The script runs on the old server from the release image that contains it (the running container
may be older), with the data root mounted read-only and the server's own env file for the target:

```sh
cd /opt/cuttingfloor
mkdir -p /var/lib/cuttingfloor-migrate
m() {
  docker run --rm --name cf-migrate \
    --env-file cuttingfloor.env \
    -e CUTTINGFLOOR_RECORDS=mongo \
    -v /var/lib/cuttingfloor:/data:ro \
    -v /var/lib/cuttingfloor-migrate:/state \
    ghcr.io/mvp2o-ai/cuttingfloor:latest \
    node scripts/migrate-storage.ts --source /data --state /state "$@"
}
```

`cuttingfloor.env` already holds `CUTTINGFLOOR_MONGODB_*` (and, later, the bucket's settings).
With a filesystem target add `-v /mnt/target:/target` and `--target-dir /target`.

## The commands

**0. What moves.** `m --list-collections` prints every collection and whether it moves.

**1. Dry run.** Touches nothing; says what a pass would do: counts and bytes per collection and
kind of file, what is left behind and why, what would be removed, and any record too big for the
database (with its collection and size).

```sh
m --dry-run
```

**2. First pass (the rehearsal).** Hours: every file is read once and sent. It ends with a verify.

```sh
m --concurrency 4            # add --bwlimit 20M to hold reads to 20 MB/s; --concurrency 1 is gentlest
```

**3. Keep it fresh, every 15 minutes until the cutover.** One pass at a time (the container's
name makes a second refuse to start).

```sh
*/15 * * * * cd /opt/cuttingfloor && ./migrate.sh >> /var/log/cf-migrate.log 2>&1   # m() in a file
```

Exit 0 and 4 are both normal here. Look at anything else.

**4. Final pass.** After the old server stops taking writes and its jobs have ended:

```sh
m --final --allow-deletes --links all
```

`--final` takes every file however recently written and treats anything still changing as a
failure. It must exit 0.

**5. Verify alone**, at any time (reads both sides, writes neither):

```sh
m --verify --links all
```

**6. The signing key** is not moved by the script. Put the `key` value of
`/var/lib/cuttingfloor/secret.key` into the new server's `CUTTINGFLOOR_URL_SECRET`, by hand, so
links already handed out keep working.

**7. Cutover on the new server:** unset `CUTTINGFLOOR_STANDBY` and restart it.

## Options

| | |
|---|---|
| `--source <dir>` | The data root. Default `CUTTINGFLOOR_DATA`, else `/data`. |
| `--state <dir>` | Manifest and reports. Required; never inside the source. One per source and target pair. |
| `--target-dir <dir>` | The filesystem data root files go into (and records, without `CUTTINGFLOOR_RECORDS=mongo`). |
| `--dry-run`, `--verify`, `--no-verify`, `--final` | As above. |
| `--concurrency <n>` | Files at once. Default 4. |
| `--record-concurrency <n>` | Records at once. Default 8. |
| `--bwlimit <rate>` | Most to read from the source per second (`20M`, `500K`). |
| `--allow-deletes` | Remove from the target whatever has gone from the source, however much. |
| `--max-delete-fraction <f>` | Without it, a pass removes at most this share of what it has moved. Default 0.1. |
| `--links <n\|all>` | Signed links from job results and the email log to check. Default 200. |
| `--blob-check <sha\|size>` | `sha` (default) reads back a file whose store keeps no hash; `size` trusts its size. |
| `--rehash` | Read every source file again instead of trusting the manifest. |
| `--settle <seconds>` | Leave files written less than this ago for the next pass. Default 60. |
| `--ignore <path>` | Leave out a file or folder by its path under the data root (`lost+found`). Repeatable; reported. |

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done, verified, the same. | Nothing. |
| 1 | A write failed or the run broke (the database or the bucket out of reach). | Read the `FAILED` lines; run it again. |
| 2 | Refused before writing anything. | See "Refused" below. |
| 3 | The target differs from the source, or holds a record too big for it. | See "Differences" below. |
| 4 | Things changed under the pass and wait for the next. | Normal while the source is live. Not acceptable from `--final` (which reports 3 instead). |
| 5 | More had gone from the source than a pass removes unasked; nothing was removed. | Check the count is plausible (a week of expiry is), then run with `--allow-deletes`. |
| 6 | Interrupted (SIGINT, SIGTERM). | Run it again. |

## Refused (exit 2)

- `UNKNOWN <path>`: a file or folder the script cannot name. Never skipped silently. If it is
  junk (`lost+found`), pass `--ignore <path>`; if the server keeps it, the script needs a rule.
- `NO RULE for collection <name>`: a collection was added to the code since the script was
  written. Add it to `COLLECTION_RULES` in `packages/server/src/migrate/layout.ts`.
- `PATH IMPORT`: a media whose file is outside the data root (local mode). Cannot exist on
  hosted; find out how it got there before going on.

## Differences (exit 3)

The table printed after a verify names each kind; `verify-report.json` in the state folder lists
every one.

| Kind | What it means | What to do |
|---|---|---|
| `record-missing` | A source record is not at the target. | Run a pass. If it stays, look for a `FAILED` line for it. |
| `record-differs` | Fields differ (the report names the fields, not their values). | Something wrote to the target (a test on the standby server). Delete the manifest's memory of it: run a pass with a fresh `--state` folder, which compares every record with the target and rewrites those that differ. |
| `record-time` | Same record, another "last used". | Same as `record-differs`. |
| `record-extra` | The target holds a record the source does not. | Made on the standby server during the rehearsal, or left when deletes were refused. Run with `--allow-deletes`; records the script never moved are removed by hand (they are test data). |
| `log` | Call log entries missing or extra for an owner. | Run a pass; a fresh `--state` folder sends every part again. |
| `blob-missing`, `blob-size`, `blob-sha256` | A file is not at the target, or not the same bytes. | Run a pass with `--rehash`, which reads every source file again and sends what differs. |
| `blob-extra` | The target holds a file nobody moved. | A test upload or export on the standby server; delete it there. |
| `upload-offset` | An upload carried part way does not hold the bytes its record says. | Run a pass; it sends the upload's parts anew after a day in any case. |
| `usage` | An owner's stored bytes differ. | Follows from a blob difference above, or shared bytes were stored twice: check the store's `share`. |
| `age` | An upload's or a kept frame set's folder is not as old at the target. | Run a pass (it sets them last). |
| `link` | A link already handed out names a file the target does not hold. | Follows from `blob-missing`; fix that. |
| `TOO BIG` | A record over the database's 16 MB. | It cannot move as a record. Production's largest was 74 KB; find out what it is. |

## What is moved, and how it is found

- **Records:** every collection the code defines (`definedCollections()` after loading every
  module that defines one; `--list-collections`), each read through `FsRecords`, so a media's
  `file`, `mezzanine` and `proxy` arrive as blob keys. Collections that share a folder
  (`floor.json`, `free-credits.json`, `onboarding.json`, `apps.json` in the owner's folder;
  `email/unsubscribed.json` among the email slots) are told apart by id.
- **The call log:** each `calls/{day}.{node}.jsonl`, entry by entry, each with its own time.
- **Files:** everything under an owner's `media/{id}/` (source, mezzanine, proxy, `analyses/`,
  `cleaned/`, `between/`, `selected/`, `search/` with its `failed.json`), `uploads/{id}/` and
  `outputs/{id}/` (exports, interchange files, transcripts, frame sets).
- **Kept time:** a record's "last used" is its file's mtime, and so is each upload's and frame
  set's folder. Nothing gets a fresh 7 days.

## What is not moved

- `models/` (fetched again), `cache/` (disposable), `secret.key` (step 6).
- `owners/*/usage/` (legacy counts; the code only sweeps them) and `owners/*/code/` (legacy
  `code.run` scratch; nothing reads it).
- Files being written (`*.tmp`, `*.part`): they take their real name when whole.
- Anything past its time at the source: timelines, media (record and files), media index
  entries and floor cursors 7 days after last use; finished jobs past their own `ttlMs`, with
  their cancels, outputs and output records; uploads 7 days and an hour after their folder was
  last written; kept frames by their folder's age; any collection with a fixed life
  (tombstones, job keys, notices, ledger marks, keys, meter, funnel, email log) past it, so the
  database's own expiry never removes what was just written.
- Files with no record: a media folder without `media.json`, an output without its job. They
  are counted in the summary ("without the record they belong to").

## How it behaves on a live source

- Records are replaced by rename, so a read sees one whole version; the script stats before and
  after and reads again on a change.
- A file written in the last minute, or belonging to a job still working, waits for the next
  pass. A file that changes while it is read is not recorded as moved.
- A record that names a file not yet at the target waits with it, so the target never holds a
  record pointing at nothing.
- Hard-linked files (the same bytes imported twice) are stored once and shared.
- An upload still arriving: its whole 16 MiB parts go into a multipart upload at the target, and
  its record there carries `offset`, where the sender resumes. Bytes past the last whole part
  are sent again by the sender. Parts are sent anew after 24 hours (stores drop unfinished
  multipart uploads).
- What has gone from the source since the last pass is removed from the target: only things
  this script moved (by its manifest), and at most a tenth of them without `--allow-deletes`.

## The manifest

`manifest.json` in the state folder: for each file its size, mtime, inode, SHA-256 and target
key; for each record its size, mtime and a hash of what was written; for each log part its size
and mtime; for each carried upload its parts. A file whose size, mtime and inode are as recorded
is not read again. Lose it and the next pass reads and hashes everything once more, finds what
is already at the target, and rebuilds it; nothing is stored twice.

`summary-pass.json`, `summary-dry-run.json`, `summary-verify.json` and `verify-report.json` sit
beside it: the machine-readable result of the last run of each kind.
