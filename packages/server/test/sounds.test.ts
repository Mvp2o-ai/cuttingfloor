import { SOUND_LABELS } from '@cuttingfloor/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, connect, type TestEnv, testRuntime } from './helpers.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await testRuntime();
});

describe('sounds tools', () => {
  it('lists the sound tools with their output schemas', async () => {
    const client = await connect(env.runtime);
    const { tools } = await client.listTools();
    for (const name of ['media.listen', 'create.stems']) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.outputSchema, name).toBeTruthy();
    }
    const analyze = tools.find((t) => t.name === 'media.analyze');
    expect(JSON.stringify(analyze?.inputSchema)).toContain('"sounds"');
  });

  it('serves the 447 sound names as a catalogue', async () => {
    const client = await connect(env.runtime);
    const res = await client.readResource({ uri: 'video://catalog/sounds' });
    const body = JSON.parse(String((res.contents[0] as { text: string }).text)) as {
      labels: string[];
    };
    expect(body.labels).toHaveLength(447);
    expect(body.labels).toEqual([...SOUND_LABELS]);
    expect(body.labels).toContain('Laughter');
  });

  it('asks for the cut-off and known names before any work starts', async () => {
    const client = await connect(env.runtime);
    const media_id = 'm_00000000000000000000000000';
    const noCut = await call(client, 'media.analyze', { media_id, kind: 'sounds' });
    expect(noCut.isError).toBe(true);
    expect(JSON.stringify(noCut.content)).toMatch(/min_probability/);
    const unknown = await call(client, 'media.analyze', {
      media_id,
      kind: 'sounds',
      labels: ['laughing'],
      min_probability: 0.5,
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toMatch(/Laughter/);
    const none = await call(client, 'media.listen', { media_id, sounds: {} });
    expect(none.isError).toBe(true);
    const many = await call(client, 'media.listen', {
      media_id,
      sounds: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, 'a bell'])),
    });
    expect(many.isError).toBe(true);
    expect(JSON.stringify(many.content)).toMatch(/1 to 16/);
  });
});
