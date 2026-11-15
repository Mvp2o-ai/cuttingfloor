import { KEEP_MS, KEEPING, span } from '@cuttingfloor/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { connect, ok, type TestEnv, testRuntime } from './helpers.ts';

// How long things are kept is said once, from the same numbers the sweeps use: in the
// instructions, the descriptions that touch keeping, and on every file as kept_until and expiry.

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime();
});

const DAY = 86_400_000;

describe('keeping', () => {
  it('states the policy from the sweep numbers in the instructions and descriptions', async () => {
    const client = await connect(env.runtime);
    const text = client.getInstructions() ?? '';
    expect(text).toContain(KEEPING);
    expect(KEEPING).toContain(`everything goes ${span(KEEP_MS.media)} after last use`);
    const { tools } = await client.listTools();
    const described = (name: string) => tools.find((t) => t.name === name)?.description ?? '';
    expect(described('media.get')).toContain(`kept ${span(KEEP_MS.media)} after last use`);
    expect(described('media.upload')).toContain(`works for ${span(KEEP_MS.upload)}`);
    expect(described('export.video')).toContain(`deleted ${span(KEEP_MS.job)} after the export`);
    expect(described('timeline.get')).toContain(`${span(KEEP_MS.timeline)} after last use`);
    // No description states a span the numbers don't.
    for (const t of tools) expect(t.description, t.name).not.toMatch(/\b24 h\b|for a day/);
  });

  it('says when an upload goes, on the upload and in media.list', async () => {
    const client = await connect(env.runtime, 'keeper');
    const up = await ok<{ expires_at: string; expiry: string }>(client, 'media.upload', {
      name: 'clip.mp4',
    });
    expect(up.expiry).toMatch(
      /^Expires in 7 days, on \d{4}-\d\d-\d\d \d\d:\d\d UTC; media\.import it before then to keep it\.$/,
    );
    expect(up.expiry).toContain(up.expires_at.slice(0, 16).replace('T', ' '));
    const listed = await ok<{ uploads: Array<{ expiry: string }> }>(client, 'media.list', {});
    expect(listed.uploads[0]?.expiry).toMatch(/^Expires in (6|7) days/);
  });

  it('says a stored result’s expiry again as of now when the job is read later', async () => {
    const client = await connect(env.runtime, 'later');
    const store = env.runtime.jobs.store;
    const job = await store.create({ owner: 'later', tool: 'export.video' });
    // Finished four days ago: three of its seven days are left.
    const until = Date.now() + 3 * DAY;
    const file = {
      url: 'https://example.test/out.mp4',
      page_url: 'https://example.test/watch',
      expires_at: '2030-01-01T00:00:00Z',
      kept_until: new Date(until).toISOString(),
      expiry: 'Expires in 7 days, on 2026-01-01 00:00 UTC; save the file from its url to keep it.',
      uri: `video://jobs/${job.id}/output`,
      bytes: 10,
      frames: 25,
      preset: 'mp4_h264',
      mime_type: 'video/mp4',
    };
    await store.update(job, {
      status: 'completed',
      progress: 1,
      result: { content: [{ type: 'text', text: JSON.stringify(file) }], structuredContent: file },
    });
    const read = await ok<{ result: { kept_until: string; expiry: string } }>(client, 'job.get', {
      job_id: job.id,
    });
    expect(read.result.kept_until).toBe(file.kept_until);
    expect(read.result.expiry).toBe(
      `Expires in 3 days, on ${file.kept_until.slice(0, 16).replace('T', ' ')} UTC; save the file from its url to keep it.`,
    );
  });
});
