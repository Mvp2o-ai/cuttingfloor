import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Final, sendFile } from '../app/account/send-file.ts';

// The account page sends files to the server's upload link. The site deploys within minutes of
// a merge and the server takes longer, so the page meets servers older than itself: one that
// does not know the parts endpoints must still get the file, sent in order.

interface Upload {
  body: Buffer;
  complete: boolean;
}

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise((r) => server?.close(r));
  server = undefined;
});

const read = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** A server that answers the parts probe with `probe` and takes PUT with Content-Range. */
async function older(probe: number): Promise<{ url: string; upload: Upload; asked: string[] }> {
  const upload: Upload = { body: Buffer.alloc(0), complete: false };
  const asked: string[] = [];
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    asked.push(`${req.method} ${path.replace(/^\/uploads\/u/, '')}`);
    if (path !== '/uploads/u') {
      // An older server checks the signature over the whole path, so any longer path fails it.
      await read(req);
      res.writeHead(probe, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid or expired upload link' }));
      return;
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(req.headers['content-range'] ?? '');
    const bytes = await read(req);
    if (!range || Number(range[1]) !== upload.body.length) {
      res.writeHead(409, { 'upload-offset': String(upload.body.length) }).end('{}');
      return;
    }
    upload.body = Buffer.concat([upload.body, bytes]);
    upload.complete = upload.body.length === Number(range[3]);
    res
      .writeHead(200, {
        'content-type': 'application/json',
        'upload-offset': String(upload.body.length),
        'upload-complete': String(upload.complete),
      })
      .end('{}');
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/uploads/u?exp=1&sig=s`, upload, asked };
}

const hooks = () => ({
  sent: () => undefined,
  note: () => undefined,
  inFlight: new Set<AbortController>(),
  pause: async () => undefined,
});

describe('sending a file from the account page', () => {
  it.each([403, 404, 405, 500])(
    'sends it in order to a server that answers %i to the parts probe',
    async (status) => {
      const { url, upload, asked } = await older(status);
      const file = new Blob([Buffer.alloc(40_000, 7)]);
      await sendFile(file, url, hooks());
      expect(upload.complete).toBe(true);
      expect(upload.body.equals(Buffer.alloc(40_000, 7))).toBe(true);
      expect(asked).toEqual(['GET /parts', 'PUT ']);
    },
  );

  it('gives up on a server that keeps answering "send from here" to what it was just sent', async () => {
    // An upload begun in parts refuses bytes in order with 409 and the same offset each time.
    let puts = 0;
    server = createServer(async (req, res) => {
      await read(req);
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== '/uploads/u') return void res.writeHead(500).end('{}');
      if (req.method === 'HEAD') return void res.writeHead(200, { 'upload-offset': '0' }).end();
      puts += 1;
      res.writeHead(409, { 'upload-offset': '0' }).end('{"error":"being sent in parts"}');
    });
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/uploads/u?exp=1&sig=s`;
    await expect(sendFile(new Blob([Buffer.alloc(10)]), url, hooks())).rejects.toThrow(
      'being sent in parts',
    );
    expect(puts).toBeLessThan(10);
  });

  it('stops at a probe that says the file is too big', async () => {
    const { url, asked } = await older(413);
    await expect(sendFile(new Blob([Buffer.alloc(10)]), url, hooks())).rejects.toBeInstanceOf(
      Final,
    );
    expect(asked).toEqual(['GET /parts']);
  });
});
