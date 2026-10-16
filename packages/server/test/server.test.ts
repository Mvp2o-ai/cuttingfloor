import { EnvCredentialStore } from '@cuttingfloor/credentials';
import { MemoryJobStore } from '@cuttingfloor/jobs';
import { createServer } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { TASKS_EXTENSION_ID_V2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

const anyResult = z.object({}).passthrough();

const jobStore = new MemoryJobStore();
const credentials = new EnvCredentialStore({});

async function connect() {
  const server = createServer({ jobs: jobStore, credentials, owner: () => 'local' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('cuttingfloor server', () => {
  it('advertises the Tasks extension', async () => {
    const client = await connect();
    expect(client.getServerCapabilities()?.extensions).toHaveProperty(TASKS_EXTENSION_ID_V2);
  });

  it('serves health without key values', async () => {
    const client = await connect();
    const res = await client.readResource({ uri: 'video://server/health' });
    const first = res.contents[0];
    const body = JSON.parse(first && 'text' in first ? first.text : '{}');
    expect(body.providers.elevenlabs).toEqual({ configured: false });
  });

  it('answers tasks/get from the job store, scoped to the owner', async () => {
    await jobStore.create({
      id: 't1',
      owner: 'local',
      tool: 'export.video',
      status: 'working',
      ttlMs: 60_000,
    });
    await jobStore.create({
      id: 't2',
      owner: 'someone-else',
      tool: 'export.video',
      status: 'working',
      ttlMs: 60_000,
    });
    const client = await connect();
    const got = await client.request({ method: 'tasks/get', params: { taskId: 't1' } }, anyResult);
    expect(got).toMatchObject({ taskId: 't1', status: 'working' });
    await expect(
      client.request({ method: 'tasks/get', params: { taskId: 't2' } }, anyResult),
    ).rejects.toThrow();
  });
});
