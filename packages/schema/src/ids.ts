import * as z from 'zod/v4';

/** Project-scoped handles. Every mutating tool takes `{ project_id, base_revision }`. */
export const ProjectId = z.string().min(1).describe('Project handle');
export const Revision = z.number().int().nonnegative().describe('Project revision number');
export const MediaId = z.string().min(1).describe('Media handle');
export const JobId = z.string().min(1).describe('Job handle; the same value is the MCP task id');

/** The envelope every mutating tool's input extends. */
export const MutationEnvelope = z.object({
  project_id: ProjectId,
  base_revision: Revision,
  on_conflict: z.enum(['fail', 'rebase_if_disjoint']).default('fail'),
});
export type MutationEnvelope = z.infer<typeof MutationEnvelope>;
