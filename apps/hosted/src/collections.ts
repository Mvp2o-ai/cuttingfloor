import { type CollectionSpec, definedCollections, type Workspace } from '@cuttingfloor/core';
// Each import below is a module that defines collections as it loads.
// The server loads the engine's and the jobs' with its own.
import '@cuttingfloor/server';
import './access.ts';
import { ADMIN_KEYS } from './admin-api.ts';
import './apps-seen.ts';
import { ScriptKeys } from './keys.ts';
import './lifecycle.ts';
import './rights.ts';
import './sequence.ts';

/**
 * Every collection a hosted server keeps, defined: the ones modules define as they load, and the
 * key stores', which are defined when a store is made. For anything that must know them all
 * without running a server (the storage migration).
 */
export function hostedCollections(ws: Workspace): readonly CollectionSpec<unknown>[] {
  new ScriptKeys(ws);
  new ScriptKeys(ws, ADMIN_KEYS);
  return definedCollections();
}
