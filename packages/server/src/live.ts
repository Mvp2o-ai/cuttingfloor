import { defineCollection, type Records } from '@cuttingfloor/core';

// What a storage migration and the server it moves to tell each other through the record store.
// - `final`: the migration's last pass ended clean (written by the migration). Any later pass
//   refuses unless told otherwise: the source stops changing at the switch, so its clocks would
//   say everything is expiring.
// - `live`: a server serves on this store, not in standby (written when it starts that way,
//   removed when one starts in standby). A pass refuses to write into a store a server serves.

export interface MigrationMark {
  /** `final`: the data root the migration moved. `live`: the node serving. */
  source?: string;
  node?: string;
  finished_at?: string;
  since?: string;
}

export const MIGRATION = defineCollection<MigrationMark>({
  name: 'migration',
  scope: 'global',
  fs: { dir: 'migration' },
});

/**
 * Says in the record store whether a server serves on it: `live` written when one starts out of
 * standby, removed when one starts in standby. Only where records are not files under the data
 * root (a database): the filesystem data root of a server in production is the migration's
 * source, never its target, and gains nothing from it.
 */
export async function markLive(
  records: Records,
  options: { standby: boolean; node: string; filesystem: boolean },
): Promise<void> {
  if (options.filesystem) return;
  const marks = records.collection(MIGRATION);
  if (options.standby) await marks.delete('live');
  else await marks.put('live', { node: options.node, since: new Date().toISOString() });
}
