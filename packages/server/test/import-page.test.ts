import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, ok, settled, type TestEnv, testRuntime } from './helpers.ts';

// Users pasted YouTube links into media.import: the server saved YouTube's web page as the video
// and failed with "not a readable media file", which told the agent nothing about the link.

let env: TestEnv;
let client: Client;
const site = createHttpServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('\n  <!DOCTYPE html><html><head><title>A video</title></head><body></body></html>');
});

beforeAll(async () => {
  env = await testRuntime();
  client = await connect(env.runtime);
  await new Promise<void>((done) => site.listen(0, '127.0.0.1', done));
});

afterAll(() => {
  site.close();
});

describe('media.import from a link to a web page', () => {
  it('says the link opened a web page and how a file gets in', async () => {
    const { port } = site.address() as AddressInfo;
    const started = await ok<{ job_id: string }>(client, 'media.import', {
      source: { url: `http://127.0.0.1:${port}/watch?v=abc` },
    });
    const done = await settled<{ error?: { code: string; message: string; hint?: string } }>(
      client,
      started.job_id,
    );
    expect(done.status).toBe('failed');
    expect(done.error?.code).toBe('bad_request');
    expect(done.error?.message).toBe('The URL opened a web page on 127.0.0.1, not a file');
    expect(done.error?.hint).toContain('never a page about it');
    expect(done.error?.hint).toContain('media.upload');
  });
});
