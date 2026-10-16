import { type Cf, createClient } from './client.ts';
import { sandboxTransport } from './sandbox.ts';

export {
  type Cf,
  type ClientOptions,
  createClient,
  type ToolResult,
  type Transport,
} from './client.ts';
export {
  dirs,
  file,
  importFile,
  motion,
  out,
  type PageOptions,
  progress,
  still,
} from './sandbox.ts';
export type { ToolInputs, ToolName, ToolOutputs } from './tools.generated.ts';

/** Every tool, called as the code.run job's owner: cf.clip.trim({...}), cf.media.analyze({...}). */
export const cf: Cf = createClient(sandboxTransport);
