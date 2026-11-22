import { writeFile } from 'node:fs/promises';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import type { AccountGetResult } from '@cuttingfloor/schema';
import { createServer } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { call, connect, type TestEnv, testRuntime } from './helpers.ts';

// support.contact: every call answers with the acknowledgement and keeps one record per message;
// it never reads or writes a balance, and answers even when the message can't be kept.

let env: TestEnv;

beforeAll(async () => {
  env = await testRuntime({ mode: 'hosted', mediaRoots: [], exportsDir: null });
});

/** A server whose account lookup counts its reads, so a test can see it is never asked. */
async function connectCounting(owner: string) {
  const reads = { count: 0 };
  const server = createServer({
    runtime: env.runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
    account: async () => {
      reads.count++;
      throw new Error('support.contact must not read the account');
    },
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return { client, reads };
}

const dir = (owner: string) => env.runtime.ws.ownerDir(owner, 'support-messages');

async function records(owner: string) {
  const files = (await env.runtime.ws.list(dir(owner))).sort();
  return Promise.all(
    files.map((f) =>
      env.runtime.ws.readJson<{ at: string; owner: string; message: string }>(`${dir(owner)}/${f}`),
    ),
  );
}

describe('support.contact', () => {
  it('acknowledges and keeps the message with its time and owner', async () => {
    const { client } = await connectCounting('user_support');
    const message = 'Tried to blur a face that moves; there is no way to track a blur to it.';
    const res = await call(client, 'support.contact', { message });
    expect(res.isError).toBe(false);
    expect(res.structured).toEqual({ message: 'Thanks for the message.' });
    const [record] = await records('user_support');
    expect(record).toMatchObject({ owner: 'user_support', message });
    expect(Number.isNaN(Date.parse(record?.at ?? ''))).toBe(false);
  });

  it('a second call also succeeds and adds another record', async () => {
    const { client } = await connectCounting('user_twice');
    for (const message of ['First: export failed.', 'Second: please add a reverse-zoom.']) {
      const res = await call(client, 'support.contact', { message });
      expect(res.isError).toBe(false);
      expect(res.structured).toEqual({ message: 'Thanks for the message.' });
    }
    expect((await records('user_twice')).map((r) => r?.message)).toEqual([
      'First: export failed.',
      'Second: please add a reverse-zoom.',
    ]);
  });

  it('reads and writes no credit balance', async () => {
    const { client, reads } = await connectCounting('user_nobalance');
    await call(client, 'support.contact', { message: 'Just a feature idea.' });
    expect(reads.count).toBe(0);
    expect(await env.runtime.ws.list(env.runtime.ws.ownerDir('user_nobalance', 'meter'))).toEqual(
      [],
    );
    // Only its own record, the call log every tool writes and the mark of the account's first
    // result: no meter, ledger or balance file.
    expect((await env.runtime.ws.list(env.runtime.ws.ownerDir('user_nobalance'))).sort()).toEqual([
      'calls',
      'claim-guided.json',
      'support-messages',
    ]);
  });

  it('still acknowledges when the message cannot be kept', async () => {
    const { client } = await connectCounting('user_nostore');
    // A file where the folder should be: every write under it fails.
    await env.runtime.ws.writeJson(env.runtime.ws.ownerDir('user_nostore', 'x.json'), {});
    await writeFile(dir('user_nostore'), 'not a folder');
    const res = await call(client, 'support.contact', { message: 'Something broke.' });
    expect(res.isError).toBe(false);
    expect(res.structured).toEqual({ message: 'Thanks for the message.' });
  });

  it('is offered only on the hosted service, with message its one required argument', async () => {
    const { tools } = await (await connect(env.runtime)).listTools();
    const tool = tools.find((t) => t.name === 'support.contact');
    expect(tool?.inputSchema.required).toEqual(['message']);
    const local = await connect((await testRuntime()).runtime);
    expect((await local.listTools()).tools.map((t) => t.name)).not.toContain('support.contact');
  });
});
