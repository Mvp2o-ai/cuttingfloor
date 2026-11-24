import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { MongoRecords } from '@cuttingfloor/core';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { Runtime, SoundSharing } from '@cuttingfloor/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccessCheck } from '../src/access.ts';
import { createHttpServer } from '../src/http.ts';
import { Ledger } from '../src/ledger.ts';
import { Lifecycle } from '../src/lifecycle.ts';
import { mongoReachable, TEST_MONGODB_URI, testDatabase } from './mongo.ts';

// Community sounds over HTTP, as the upload box, the upload page and the site use them: a sent
// sound shared from its signed upload link (the link is the proof it is the sender's), listed
// on GET /sounds, listed and taken down by the site for its user, reported by anyone. Real
// FFmpeg and MongoDB; CLAP and the public bucket are stood in for.

const exec = promisify(execFile);
const ACCOUNT_KEY = 'account-key-0123456789abcdef';
const USER = 'user_01ABCDEFGHJKMNPQRSTVWXYZ01';

const ffmpeg = await exec('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
if (!ffmpeg && process.env.CUTTINGFLOOR_REQUIRE_ENGINES) throw new Error('FFmpeg is required');
const ready = ffmpeg && (await mongoReachable());

describe.skipIf(!ready)('community sounds over HTTP', { timeout: 60_000 }, () => {
  let base: string;
  let server: Server;
  let runtime: Runtime;
  let dir: string;
  const db = testDatabase();
  const database = () => (runtime.ws.records as unknown as MongoRecords).database();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cf-community-'));
    runtime = new Runtime({
      dataDir: join(dir, 'data'),
      mode: 'hosted',
      publicUrl: 'http://127.0.0.1:0',
      mediaRoots: [],
      exportsDir: null,
      maxJobs: 1,
      outputUrlTtlMs: 60_000,
      maxDownloadBytes: 1024 ** 2,
      allowPrivateUrls: false,
      inlineMaxBytes: 1024,
      motionUrl: null,
      records: { store: 'mongo', uri: TEST_MONGODB_URI, db },
      sounds: 'mongo',
    });
    await runtime.start({ sweep: false });
    const bucket = join(dir, 'bucket');
    runtime.sharing = new SoundSharing({
      db: database,
      files: {
        url: (key) => `https://sounds.example/${key}`,
        put: async (key, file) => {
          await mkdir(join(bucket, key, '..'), { recursive: true });
          await copyFile(file, join(bucket, key));
          return `https://sounds.example/${key}`;
        },
        delete: async () => undefined,
      },
      embed: async () => [1, 0, 0],
      model: 'stand-in',
    });
    const access = {
      get: async () => ({ allowed: true, plan: 'free' }),
      limits: async () => ({
        storageBytes: 50 * 1024 ** 2,
        account: 'https://cuttingfloor.ai/account',
      }),
    } as unknown as AccessCheck;
    const lifecycle = new Lifecycle({
      runtime,
      access,
      ledger: new Ledger('http://127.0.0.1:9', 'none'),
      workosKey: 'sk_test_none',
      stripeKey: 'sk_test_none',
      accountUrl: 'https://cuttingfloor.ai/account',
      accountKey: ACCOUNT_KEY,
    });
    server = createHttpServer({
      runtime,
      credentials: new LocalCredentialStore({}, false),
      apiKeys: new Map([['maintenance-key-0123456789abcdef', 'ops']]),
      route: (req, res, url) => lifecycle.route(req, res, url),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    (runtime.config as { publicUrl: string }).publicUrl = base;
  });

  afterAll(async () => {
    server?.close();
    await (await database()).dropDatabase();
  });

  const site = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${ACCOUNT_KEY}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** Sends a file as the account page does; answers its signed link. */
  async function send(name: string, bytes: Buffer): Promise<{ upload_id: string; url: string }> {
    const up = (await (
      await site('/account/uploads', { user: USER, name, bytes: bytes.length })
    ).json()) as {
      upload_id: string;
      url: string;
    };
    const sent = await fetch(up.url, { method: 'PUT', body: new Uint8Array(bytes) });
    expect(await sent.json()).toMatchObject({ complete: true });
    return up;
  }

  const shareAt = (url: string, body: unknown) => {
    const u = new URL(url);
    u.pathname += '/share';
    return fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const details = { name: 'Drop', description: 'A test drop', category: 'Music', tags: ['drop'] };

  it('shares a sent sound from its upload link, and lists it', async () => {
    const wav = join(dir, 'drop.wav');
    await exec('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=2',
      '-y',
      wav,
    ]);
    const up = await send('drop.wav', await readFile(wav));

    // Details are required; a forged link is refused.
    expect((await shareAt(up.url, { name: 'Drop' })).status).toBe(400);
    const forged = new URL(up.url);
    forged.searchParams.set('sig', 'AAAA');
    expect((await shareAt(forged.href, details)).status).toBe(403);

    const res = await shareAt(up.url, { ...details, author: 'Ken W.' });
    expect(res.status).toBe(200);
    const { sound } = (await res.json()) as { sound: { sound_id: string; author: string } };
    expect(sound).toMatchObject({ author: 'Ken W.', pack: 'community', seconds: 2 });

    const listed = (await (await fetch(`${base}/sounds?pack=community&order=newest`)).json()) as {
      sounds: Array<{ sound_id: string }>;
    };
    expect(listed.sounds.map((s) => s.sound_id)).toEqual([sound.sound_id]);

    const mine = (await (await site(`/account/sounds?user=${USER}`)).json()) as {
      sounds: Array<{ sound_id: string }>;
    };
    expect(mine.sounds.map((s) => s.sound_id)).toEqual([sound.sound_id]);
  });

  it('refuses what is not a sound, from the site too', async () => {
    const up = await send('notes.txt', Buffer.from('not a sound'));
    const res = await site('/account/sounds', { user: USER, upload_id: up.upload_id, ...details });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Only audio files/);
    expect(
      (await site('/account/sounds', { user: 'ops', upload_id: up.upload_id, ...details })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/account/sounds?user=${USER}`, {
          headers: { authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
  });

  it('takes reports from anyone, and takedowns from the owner', async () => {
    const mine = (await (await site(`/account/sounds?user=${USER}`)).json()) as {
      sounds: Array<{ sound_id: string }>;
    };
    const id = mine.sounds[0]?.sound_id ?? '';
    const report = (reason: string) =>
      fetch(`${base}/sounds/${id}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
    expect((await report('')).status).toBe(400);
    const reported = await report('not theirs');
    expect(reported.status).toBe(200);
    expect(reported.headers.get('access-control-allow-origin')).toBe('*');
    expect(
      (
        await site('/account/sounds/remove', {
          user: 'user_01ZYXWVTSRQPNMKJHGFEDCBA98',
          sound_id: id,
        })
      ).status,
    ).toBe(404);
    expect((await site('/account/sounds/remove', { user: USER, sound_id: id })).status).toBe(200);
    expect(
      (await fetch(`${base}/sounds/${id}/report`, { method: 'POST', body: '{"reason":"x"}' }))
        .status,
    ).toBe(404);
  });
});
