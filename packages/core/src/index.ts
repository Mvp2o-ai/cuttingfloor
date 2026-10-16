import type { Sequence } from '@cuttingfloor/schema';

/**
 * The project store. A project is a user-owned `.vproj` folder (local) or a tenant
 * prefix in object storage (hosted): project.json, ops/{n}.json, snapshots, media.json.
 * Commits are compare-and-swap on `base_revision`; see plans/spec.md §6.
 */
export interface ProjectStore {
  create(input: {
    name: string;
    path?: string;
    sequence: Sequence;
  }): Promise<{ projectId: string; revision: number }>;
  head(projectId: string): Promise<number>;
}
