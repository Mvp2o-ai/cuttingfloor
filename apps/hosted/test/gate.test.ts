import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { REVIEW_CARDS, Runtime } from '@cuttingfloor/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpServer, parseApiKeys } from '../src/http.ts';

// The download gate through the HTTP face, as clients meet it: a picture export downloads
// with the watermark (here a stand-in mark that appends a tag), export.release spends its price
// once, and from then on every link serves the clean file.

const KEY = 'gate-key-0123456789abcdefghij';
const MARK = '\n[cuttingfloor watermark]';
let runtime: Runtime;
let base: string;
let server: Server;
/** Credits left per owner; null for no cap. */
const balances = new Map<string, number | null>();
const exempt = new Set<string>();
const spends: Array<{ owner: string; ref: string; credits: number }> = [];
let marked = 0;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-gate-'));
  runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'hosted',
    publicUrl: 'http://127.0.0.1:0',
    mediaRoots: [],
    exportsDir: null,
    maxJobs: 1,
    outputUrlTtlMs: 600_000,
    maxDownloadBytes: 1024,
    allowPrivateUrls: false,
    inlineMaxBytes: 1024,
    motionUrl: null,
  });
  await runtime.start({ sweep: false });
  runtime.useGate(
    {
      exempt: async (owner) => exempt.has(owner),
      balance: async (owner) => balances.get(owner) ?? 0,
      spend: async (owner, ref, credits) => {
        // The ledger takes a ref once.
        if (!spends.some((s) => s.ref === ref)) {
          spends.push({ owner, ref, credits });
          balances.set(owner, (balances.get(owner) ?? 0) - credits);
        }
        return { balance: balances.get(owner) ?? 0 };
      },
      mark: async (input, output) => {
        marked += 1;
        await copyFile(input, output);
        await writeFile(output, `${await readFile(input, 'utf8')}${MARK}`);
      },
    },
    { from: '2000-01-01T00:00:00Z' },
  );
  server = createHttpServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    apiKeys: parseApiKeys(`alice:${KEY},staff:${KEY}-staff,poor:${KEY}-poor`),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (runtime.config as { publicUrl: string }).publicUrl = base;
});

afterAll(() => server.close());

/** A finished export of `seconds`, as export.video leaves one. */
async function exported(owner: string, name: string, mime: string, seconds: number) {
  const store = runtime.jobs.store;
  const job = await store.create({ owner, tool: 'export.video' });
  await runtime.outputs.write(owner, job.id, name, `clean ${name}`, 'export');
  const signed = await runtime.signOutput(owner, job.id, name);
  const result = {
    url: signed.url,
    page_url: signed.pageUrl,
    expires_at: signed.expiresAt,
    uri: `video://jobs/${job.id}/output`,
    bytes: 10,
    frames: Math.round(seconds * 25),
    preset: 'mp4_h264',
    mime_type: mime,
    duration_seconds: seconds,
  };
  await store.update(job, {
    status: 'completed',
    progress: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    } as never,
  });
  return { jobId: job.id, url: signed.url, pageUrl: signed.pageUrl };
}

async function connect(key: string) {
  const client = new Client({ name: 't', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

type Out = { structuredContent: Record<string, unknown>; isError?: boolean };
const call = (c: Client, name: string, args: Record<string, unknown>) =>
  c.callTool({ name, arguments: args }) as Promise<Out>;

describe('the download gate', () => {
  it('serves a picture export marked until it is released, then clean everywhere, spent once', async () => {
    balances.set('alice', 3);
    const { jobId, url, pageUrl } = await exported('alice', 'short.mp4', 'video/mp4', 40);
    const alice = await connect(KEY);

    // The export says so, with its price (40 s is three quarter-minutes) and what the user has.
    const before = (await call(alice, 'job.get', { job_id: jobId })).structuredContent as {
      result: { watermarked: boolean; release_credits: number; watermark_note: string };
    };
    expect(before.result).toMatchObject({
      watermarked: true,
      release_credits: 0.75,
      credits_left: 3,
    });
    expect(before.result.watermark_note).toBe(
      'url is the review copy, with a cuttingfloor watermark, free. final_url is the final copy without it: opening it uses 0.75 credits once; this account has 3 credits, enough. Give the user both links, with the price and their credits beside final_url.',
    );
    // Both links, in the text a client reads as well as the structured result.
    const finalUrl = (before.result as unknown as { final_url: string }).final_url;
    expect(finalUrl.startsWith(`${base}/final/alice/${jobId}/short.mp4?`)).toBe(true);

    // Every way out serves the watermarked copy, made once, and never cached.
    const first = await fetch(url);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.text()).toBe(`clean short.mp4${MARK}`);
    expect(await (await fetch(url)).text()).toBe(`clean short.mp4${MARK}`);
    expect(marked).toBe(1);
    const page = await (await fetch(pageUrl)).text();
    expect(page).toContain('has a cuttingfloor watermark');
    expect(page).toContain('0.75 credit');

    // Released at the same moment from two places: one spend.
    const [a, b] = await Promise.all([
      call(alice, 'export.release', { job_id: jobId }),
      call(alice, 'export.release', { job_id: jobId }),
    ]);
    const spent = [a, b].map((r) => r.structuredContent.credits as number).sort();
    expect(spent[1]).toBe(0.75);
    expect(spends.filter((s) => s.ref === `${jobId}-release`)).toHaveLength(1);
    expect(balances.get('alice')).toBe(2.25);

    // Clean from then on: the old link, the fresh one, and the job's result.
    expect(await (await fetch(url)).text()).toBe('clean short.mp4');
    const fresh = (a.structuredContent.url as string) ?? '';
    expect(await (await fetch(fresh)).text()).toBe('clean short.mp4');
    expect(await (await fetch(pageUrl)).text()).not.toContain('has a cuttingfloor watermark');
    const after = (await call(alice, 'job.get', { job_id: jobId })).structuredContent as {
      result: { watermarked: boolean; release_credits?: number };
    };
    expect(after.result.watermarked).toBe(false);
    expect(after.result.release_credits).toBeUndefined();
    expect(after.result).not.toHaveProperty('credits_left');
    expect(after.result).not.toHaveProperty('watermark_note');

    // Again: nothing spent.
    const again = await call(alice, 'export.release', { job_id: jobId });
    expect(again.structuredContent).toMatchObject({ credits: 0, price: 0.75, balance: 2.25 });
    await alice.close();
  });

  it('refuses a release the balance does not cover, and the watermarked file still downloads', async () => {
    balances.set('poor', 0.5);
    const { jobId, url } = await exported('poor', 'long.mp4', 'video/mp4', 61);
    const poor = await connect(`${KEY}-poor`);
    // The export already says the balance falls short, with no way to buy in it.
    const told = (await call(poor, 'job.get', { job_id: jobId })).structuredContent as {
      result: { credits_left: number; watermark_note: string };
    };
    expect(told.result.credits_left).toBe(0.5);
    expect(told.result.watermark_note).toBe(
      'url is the review copy, with a cuttingfloor watermark, free. final_url is the final copy without it: opening it uses 1.25 credits once; this account has 0.5 credits, too few, and shows how to get more. Give the user both links, with the price and their credits beside final_url.',
    );
    expect(told.result.watermark_note).not.toMatch(/https?:|buy/i);
    const refused = await call(poor, 'export.release', { job_id: jobId });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      code: 'quota_exceeded',
      detail: { price: 1.25, credits_left: 0.5 },
    });
    expect(JSON.stringify(refused.structuredContent)).not.toMatch(/https?:|buy/i);
    expect(balances.get('poor')).toBe(0.5);
    expect(await (await fetch(url)).text()).toBe(`clean long.mp4${MARK}`);
    await poor.close();
  });

  it('removes the watermark when its final link is opened, once; too few credits spend nothing', async () => {
    balances.set('alice', 2);
    const { jobId } = await exported('alice', 'final.mp4', 'video/mp4', 30);
    const alice = await connect(KEY);
    const read = await alice.callTool({ name: 'job.get', arguments: { job_id: jobId } });
    const text =
      (read.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')
        ?.text ?? '';
    const finalUrl = (read.structuredContent as { result: { final_url: string } }).result.final_url;
    expect(text).toContain(finalUrl);
    // A HEAD (a link check) spends nothing.
    expect((await fetch(finalUrl, { method: 'HEAD', redirect: 'manual' })).status).toBe(302);
    expect(balances.get('alice')).toBe(2);
    // Opening it spends the price once and sends the browser to the file, now clean.
    const opened = await fetch(finalUrl, { redirect: 'manual' });
    expect(opened.status).toBe(302);
    const location = new URL(opened.headers.get('location') ?? '', base).href;
    expect(location).toContain(`/outputs/alice/${jobId}/final.mp4?`);
    expect(await (await fetch(location)).text()).toBe('clean final.mp4');
    expect(balances.get('alice')).toBe(1.5);
    expect((await fetch(finalUrl, { redirect: 'manual' })).status).toBe(302);
    expect(balances.get('alice')).toBe(1.5);
    const after = (await call(alice, 'job.get', { job_id: jobId })).structuredContent as {
      result: Record<string, unknown>;
    };
    expect(after.result.watermarked).toBe(false);
    expect(after.result).not.toHaveProperty('final_url');
    await alice.close();

    // Too few: a page with the price and what the account has, and the review copy; nothing spent.
    balances.set('poor', 0.25);
    const short = await exported('poor', 'short-of.mp4', 'video/mp4', 30);
    const poor = await connect(`${KEY}-poor`);
    const told = (await call(poor, 'job.get', { job_id: short.jobId })).structuredContent as {
      result: { final_url: string };
    };
    const page = await fetch(told.result.final_url, { redirect: 'manual' });
    expect(page.status).toBe(402);
    const html = await page.text();
    expect(html).toContain('needs 0.5 credits');
    expect(html).toContain('this account has 0.25 credits');
    expect(html).toContain('Get credits');
    expect(balances.get('poor')).toBe(0.25);
    expect(await (await fetch(short.url)).text()).toBe(`clean short-of.mp4${MARK}`);
    await poor.close();
  });

  it('removes the watermark from the watch page by its button only; opening the page spends nothing', async () => {
    balances.set('alice', 2);
    const { jobId, url, pageUrl } = await exported('alice', 'mailed.mp4', 'video/mp4', 40);
    // A mail scanner opening the emailed link: the page, with the price and the balance.
    const page = await (await fetch(pageUrl)).text();
    expect(page).toContain('Removing it uses 0.75 credits; you have 2 credits.');
    const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1]?.replaceAll('&amp;', '&');
    expect(action).toMatch(new RegExp(`^/final/alice/${jobId}/mailed\\.mp4\\?exp=\\d+&sig=`));
    expect(balances.get('alice')).toBe(2);
    // The same button over the picture while the end card plays, by the page's one allowed script.
    const over = /<form id="over"[^>]* action="([^"]+)"[^>]*hidden>/.exec(page)?.[1];
    expect(over?.replaceAll('&amp;', '&')).toBe(action);
    expect(page).toContain(`data-end="${REVIEW_CARDS.end}"`);
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
    const csp = (await fetch(pageUrl)).headers.get('content-security-policy');
    expect(csp).toContain(
      `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`,
    );
    // The button: spends once, then back to the page, which now plays the clean file.
    const pressed = await fetch(new URL(action ?? '', base), {
      method: 'POST',
      redirect: 'manual',
    });
    expect(pressed.status).toBe(303);
    expect(new URL(pressed.headers.get('location') ?? '', base).pathname).toBe(
      new URL(pageUrl).pathname,
    );
    expect(balances.get('alice')).toBe(1.25);
    const after = await (await fetch(pageUrl)).text();
    expect(after).not.toContain('<form');
    expect(await (await fetch(url)).text()).toBe('clean mailed.mp4');
    expect(
      (await fetch(new URL(action ?? '', base), { method: 'POST', redirect: 'manual' })).status,
    ).toBe(303);
    expect(balances.get('alice')).toBe(1.25);

    // Too few: the button answers the page with the price, the balance and Get credits.
    balances.set('poor', 0.25);
    const short = await exported('poor', 'mailed-short.mp4', 'video/mp4', 40);
    const shortPage = await (await fetch(short.pageUrl)).text();
    const shortAction = /<form method="post" action="([^"]+)"/
      .exec(shortPage)?.[1]
      ?.replaceAll('&amp;', '&');
    const refused = await fetch(new URL(shortAction ?? '', base), {
      method: 'POST',
      redirect: 'manual',
    });
    expect(refused.status).toBe(402);
    expect(await refused.text()).toContain('Get credits');
    expect(balances.get('poor')).toBe(0.25);
  });

  it('releases over /v1 as apps call it, the same once-only spend', async () => {
    balances.set('alice', 1);
    const { jobId, url } = await exported('alice', 'still.png', 'image/png', 0);
    const post = (body: unknown) =>
      fetch(`${base}/v1/export.release`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const res = await post({ job_id: jobId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ job_id: jobId, credits: 0.25, balance: 0.75 });
    expect(await (await fetch(url)).text()).toBe('clean still.png');
    expect(await (await post({ job_id: jobId })).json()).toMatchObject({ credits: 0 });
    const short = await post({
      job_id: (await exported('alice', 'b.mp4', 'video/mp4', 300)).jobId,
    });
    expect(short.status).toBe(402);
    expect(await short.json()).toMatchObject({ code: 'quota_exceeded' });
  });

  it("says in export.video's description that picture exports carry the watermark, inside the cut", async () => {
    const alice = await connect(KEY);
    const { tools } = await alice.listTools();
    const text = tools.find((t) => t.name === 'export.video')?.description ?? '';
    expect(text).toContain('downloads with a cuttingfloor watermark, for reviewing, which is free');
    expect(text.length).toBeLessThanOrEqual(4096);
    await alice.close();
  });

  it('releases with exactly the price left', async () => {
    balances.set('alice', 0.25);
    const { jobId } = await exported('alice', 'tiny.png', 'image/png', 0);
    const alice = await connect(KEY);
    const got = await call(alice, 'export.release', { job_id: jobId });
    expect(got.structuredContent).toMatchObject({ credits: 0.25, balance: 0 });
    await alice.close();
  });

  it('never marks audio, a given plan, or an export that has gone', async () => {
    balances.set('alice', 2);
    const audio = await exported('alice', 'mix.wav', 'audio/wav', 30);
    expect(await (await fetch(audio.url)).text()).toBe('clean mix.wav');
    const alice = await connect(KEY);
    const free = await call(alice, 'export.release', { job_id: audio.jobId });
    expect(free.structuredContent).toMatchObject({ credits: 0, price: 0 });

    exempt.add('staff');
    const given = await exported('staff', 'cut.mp4', 'video/mp4', 30);
    expect(await (await fetch(given.url)).text()).toBe('clean cut.mp4');
    // Nothing said about a watermark a file doesn't have, nor the user's credits.
    const staff = await connect(`${KEY}-staff`);
    for (const [client, id] of [
      [alice, audio.jobId],
      [staff, given.jobId],
    ] as const) {
      const clean = (await call(client, 'job.get', { job_id: id })).structuredContent as {
        result: Record<string, unknown>;
      };
      expect(clean.result.watermarked).toBe(false);
      expect(clean.result).not.toHaveProperty('watermark_note');
      expect(clean.result).not.toHaveProperty('credits_left');
    }
    await staff.close();

    const gone = await call(alice, 'export.release', { job_id: 'j_00000000000000000000000000' });
    expect(gone.structuredContent).toMatchObject({ code: 'not_found' });
    expect(balances.get('alice')).toBe(2);
    await alice.close();
  });
});
