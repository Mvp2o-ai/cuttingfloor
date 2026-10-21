import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissing, type Workspace } from '@cuttingfloor/core';
import { CfError, MEDIA_LIST_LIMIT, type MediaListResult } from '@cuttingfloor/schema';
import type * as z from 'zod/v4';
import type { OwnerLimits } from './meter.ts';
import type { Runtime } from './runtime.ts';

/** Bytes an owner keeps on the server: every file under their folder. */
export async function storedBytes(ws: Workspace, owner: string): Promise<number> {
  const root = ws.ownerDir(owner);
  let entries: { name: string; parentPath: string; isFile(): boolean }[];
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    // A file swept between the listing and its stat no longer counts.
    total += await stat(join(e.parentPath, e.name)).then(
      (s) => s.size,
      () => 0,
    );
  }
  return total;
}

export interface Storage {
  used_bytes: number;
  max_bytes: number | null;
}

export async function storageOf(
  ws: Workspace,
  owner: string,
  limits: OwnerLimits | undefined,
): Promise<Storage> {
  return { used_bytes: await storedBytes(ws, owner), max_bytes: limits?.storageBytes ?? null };
}

/**
 * The bytes the owner may still add under their plan's storage, or undefined without a cap.
 * Refuses when there is no room, or less than `need`.
 */
export async function storageRoom(
  ws: Workspace,
  owner: string,
  limits: OwnerLimits | undefined,
  need?: number,
): Promise<number | undefined> {
  const cap = limits?.storageBytes;
  if (cap === undefined) return undefined;
  const used = await storedBytes(ws, owner);
  const room = Math.max(0, cap - used);
  if (room > 0 && (need === undefined || need <= room)) return room;
  throw new CfError(
    'quota_exceeded',
    need !== undefined && room > 0
      ? `The file is ${gb(need)}; the account's storage has ${gb(room)} left of ${gb(cap)}`
      : `The account's storage is full: ${gb(used)} of ${gb(cap)}`,
    {
      hint: `Files expire on their own: uploads a day after they were sent, media and exports 7 days after last use. Wait for older ones to go${limits?.account ? `, or move to a bigger plan at ${limits.account}` : ''}`,
      detail: {
        used_bytes: used,
        max_bytes: cap,
        ...(limits?.account ? { account: limits.account } : {}),
      },
    },
  );
}

/** Starts an upload within the owner's storage: the signed URL to send one file to. */
export async function startUpload(
  rt: Runtime,
  owner: string,
  name: string,
  bytes: number | undefined,
  limits: OwnerLimits | undefined,
): Promise<{ upload_id: string; url: string; expires_at: string; max_bytes: number }> {
  const room = await storageRoom(rt.ws, owner, limits, bytes);
  return rt.uploads.create(owner, name, bytes, room);
}

/** What the owner holds: media, uploads not imported yet, and storage against the cap. */
export async function listHeld(
  rt: Runtime,
  owner: string,
  limits: OwnerLimits | undefined,
): Promise<z.infer<typeof MediaListResult>> {
  const [media, uploads, storage] = await Promise.all([
    rt.media.list(owner),
    rt.uploads.list(owner),
    storageOf(rt.ws, owner, limits),
  ]);
  return {
    media: media.slice(0, MEDIA_LIST_LIMIT).map((r) => ({
      media_id: r.media_id,
      name: r.name,
      status: r.status,
      kind: r.probe?.kind ?? null,
      duration_seconds: r.probe?.duration ?? null,
      from:
        'upload' in r.source
          ? 'upload'
          : 'url' in r.source
            ? 'url'
            : 'path' in r.source
              ? 'path'
              : 'job' in r.source
                ? 'render'
                : 'created',
      bytes: r.size,
      created_at: r.created_at,
      expires_at: r.expires_at,
    })),
    media_count: media.length,
    uploads: uploads.slice(0, MEDIA_LIST_LIMIT),
    upload_count: uploads.length,
    storage,
  };
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes < 1e9 ? 2 : 1)} GB`;
}
