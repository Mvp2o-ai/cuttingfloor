import { readFile } from 'node:fs/promises';
import { CfError } from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';
import { GENERATED, generateTools } from '../scripts/generate.ts';
import { createClient, type ToolResult } from '../src/index.ts';
import { TOOL_NAMES } from '../src/tools.generated.ts';

describe('the SDK', () => {
  it('is generated from the current tool registry', async () => {
    // Stale? Run: node packages/sdk/scripts/generate.ts
    expect(await readFile(GENERATED, 'utf8')).toBe(await generateTools());
    expect(TOOL_NAMES).toContain('clip.trim');
    expect(TOOL_NAMES).toContain('code.run');
  });

  it('calls tools as cf.domain.verb and follows jobs to their result', async () => {
    const calls: string[] = [];
    let polls = 0;
    const cf = createClient(
      async (tool, args): Promise<ToolResult> => {
        calls.push(`${tool} ${JSON.stringify(args)}`);
        if (tool === 'media.import')
          return { structuredContent: { job_id: 'j_1', status: 'working', media_id: 'm_1' } };
        if (tool === 'job.get') {
          polls += 1;
          return {
            structuredContent:
              polls < 3
                ? { job_id: 'j_1', status: 'working' }
                : {
                    job_id: 'j_1',
                    status: 'completed',
                    result: { media_id: 'm_1', status: 'ready' },
                  },
          };
        }
        if (tool === 'clip.trim')
          return {
            isError: true,
            structuredContent: { code: 'not_found', message: 'No clip c9', hint: 'Use c1' },
          };
        return { content: [{ type: 'text', text: '{"timeline_id":"tl_1"}' }] };
      },
      { pollMs: 1 },
    );
    expect(await cf.media.import({ source: { path: '/x.mp4' } })).toEqual({
      media_id: 'm_1',
      status: 'ready',
    });
    expect(polls).toBe(3);
    expect(await cf.timeline.load({ timeline: {} as never })).toEqual({ timeline_id: 'tl_1' });
    const error = await cf.clip
      .trim({ timeline_id: 'tl_1', clip_id: 'c9' } as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CfError);
    expect(error).toMatchObject({ code: 'not_found', hint: 'Use c1' });
    expect(calls[0]).toBe('media.import {"source":{"path":"/x.mp4"}}');
  });

  it('turns failed jobs into typed errors', async () => {
    const cf = createClient(
      async (tool): Promise<ToolResult> =>
        tool === 'job.get'
          ? {
              structuredContent: {
                status: 'completed',
                error: { code: 'render_failed', message: 'boom' },
              },
            }
          : { structuredContent: { job_id: 'j_2', status: 'working' } },
      { pollMs: 1 },
    );
    await expect(cf.export.video({ timeline_id: 'tl_1' } as never)).rejects.toMatchObject({
      code: 'render_failed',
    });
  });
});
