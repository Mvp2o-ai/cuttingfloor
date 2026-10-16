import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { createServer, Runtime, type RuntimeConfig } from '@cuttingfloor/server';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

export interface TestEnv {
  runtime: Runtime;
  dir: string;
  mediaDir: string;
  exportsDir: string;
}

export async function testRuntime(overrides: Partial<RuntimeConfig> = {}): Promise<TestEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-test-'));
  const mediaDir = join(dir, 'media');
  const exportsDir = join(dir, 'exports');
  await mkdir(mediaDir, { recursive: true });
  const runtime = new Runtime({
    dataDir: join(dir, 'data'),
    mode: 'local',
    publicUrl: 'http://127.0.0.1:8787',
    mediaRoots: [mediaDir],
    exportsDir,
    maxJobs: 2,
    outputUrlTtlMs: 3_600_000,
    maxDownloadBytes: 1024 ** 3,
    allowPrivateUrls: true,
    inlineMaxBytes: 32 * 1024 ** 2,
    motionUrl: null,
    ...overrides,
  });
  await runtime.start({ sweep: false });
  return { runtime, dir, mediaDir, exportsDir };
}

/** An SDK client over InMemoryTransport (2025-era handshake, as most clients today). */
export async function connect(runtime: Runtime, owner = 'local'): Promise<Client> {
  const server = createServer({
    runtime,
    credentials: new LocalCredentialStore({}, false),
    owner: () => owner,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

export interface CallResult {
  isError: boolean;
  structured: Record<string, unknown>;
  content: Array<{ type: string; [k: string]: unknown }>;
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content: CallResult['content'];
  };
  return {
    isError: Boolean(res.isError),
    structured: res.structuredContent ?? {},
    content: res.content,
  };
}

/** Calls a tool and returns its structured result, failing the test on a tool error. */
export async function ok<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const res = await call(client, name, args);
  if (res.isError) throw new Error(`${name} failed: ${JSON.stringify(res.structured)}`);
  return res.structured as T;
}

export const SEQ_720P25 = { width: 1280, height: 720, fps: { num: 25, den: 1 } };
