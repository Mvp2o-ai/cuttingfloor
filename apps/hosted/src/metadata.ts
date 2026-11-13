// WorkOS keeps a user's metadata as one object, and an update replaces it whole. Two updates that
// each read it, add a field and write it back lose one of the fields when they overlap: an app's
// first request marks both `first_call_at` and `first_client`, and the later write erased the
// other. So every metadata write this server makes runs through one queue per user, each reading
// the metadata after the one before it wrote.

const queues = new Map<string, Promise<unknown>>();

/** Runs `work` once every earlier metadata write for `owner` has finished, failed or not. */
export function oneWriteAtATime<T>(owner: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(owner) ?? Promise.resolve()).then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(owner, settled);
  void settled.then(() => {
    if (queues.get(owner) === settled) queues.delete(owner);
  });
  return run;
}
