import { randomBytes } from 'node:crypto';
import { FLOOR } from './storage/collections.ts';
import { ownerKey, type Workspace } from './workspace.ts';

// Where an account's floor stands: a cursor in `owners/{owner}/floor.json` that every change an
// app would show moves (a media added, changing status or removed, an upload sent, a job started
// or ended), on whichever server made it. An app holds POST /v1/floor.changes with the cursor it
// last saw instead of listing on a timer. The cursor says only that something changed, never what:
// the app lists again. A missing file is cursor "0", so losing it costs one extra list.

const listeners = new Set<(root: string, key: string) => void>();

/** Moves the owner's cursor. Never throws: a change is not undone because its signal failed. */
export async function floorChanged(ws: Workspace, owner: string): Promise<void> {
  const key = ownerKey(owner);
  const cursor = `${Date.now().toString(36)}.${randomBytes(4).toString('hex')}`;
  try {
    await ws.records.collection(FLOOR, { owner: key }).put('floor', { cursor });
  } catch (error) {
    process.stderr.write(`floor: ${key}: ${(error as Error).message}\n`);
  }
  for (const listener of listeners) listener(ws.root, key);
}

/** The owner's cursor now. */
export async function floorCursor(ws: Workspace, owner: string): Promise<string> {
  const floor = await ws.records
    .collection(FLOOR, { owner })
    .get('floor')
    .catch(() => undefined);
  return floor?.cursor ?? '0';
}

/**
 * Waits up to `ms` for the owner's cursor to move past `since`, and answers at once when it
 * already has. Hears this server's own changes as they happen and rereads the file every
 * `pollMs` for changes other servers make.
 */
export async function waitForFloor(
  ws: Workspace,
  owner: string,
  since: string | undefined,
  ms: number,
  options: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<{ cursor: string; changed: boolean }> {
  const key = ownerKey(owner);
  let cursor = await floorCursor(ws, owner);
  if (since === undefined || cursor !== since || !(ms > 0) || options.signal?.aborted)
    return { cursor, changed: since === undefined || cursor !== since };
  await new Promise<void>((resolve) => {
    let checking = false;
    const check = () => {
      if (checking) return;
      checking = true;
      void floorCursor(ws, owner).then((now) => {
        checking = false;
        cursor = now;
        if (now !== since) finish();
      });
    };
    const heard = (root: string, k: string) => {
      if (root === ws.root && k === key) check();
    };
    const finish = () => {
      listeners.delete(heard);
      clearTimeout(timer);
      clearInterval(poll);
      options.signal?.removeEventListener('abort', finish);
      resolve();
    };
    listeners.add(heard);
    const timer = setTimeout(finish, ms);
    const poll = setInterval(check, options.pollMs ?? 1000);
    options.signal?.addEventListener('abort', finish, { once: true });
  });
  return { cursor, changed: cursor !== since };
}
