#!/usr/bin/env node
import { LocalCredentialStore } from '@cuttingfloor/credentials';
import { configFromEnv, createServer, Runtime, SERVER_VERSION } from '@cuttingfloor/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { bridgeStdioToHttp } from './bridge.ts';

const USAGE = `cuttingfloor ${SERVER_VERSION}

  serve      Run the MCP server over Streamable HTTP (the container's default)
  mcp        MCP over stdio. Inside the running container (docker exec -i cuttingfloor
             cuttingfloor mcp) it forwards to the serving process, so long jobs outlive
             the client; with no server running it serves in-process.
  motion-worker
             Render motion graphics and HTML stills for a serving process. Runs only in
             the motion sandbox container (compose service \`motion\`): it executes
             agent-written HTML.
  motion-launcher
             Start a fresh motion sandbox (a motion-worker container) for each render and
             remove it after, as many at once as the machine holds. Needs the Docker socket;
             the hosted server's compose service \`motion\` runs it.
  version    Print the version
`;

const [command] = process.argv.slice(2);

switch (command) {
  case 'serve':
    await import('@cuttingfloor/hosted');
    break;
  case 'mcp': {
    const port = Number(process.env.PORT ?? 8787);
    const url = `http://127.0.0.1:${port}`;
    if (await reachable(`${url}/healthz`)) {
      await bridgeStdioToHttp(`${url}/mcp`);
      break;
    }
    const runtime = new Runtime(configFromEnv());
    await runtime.start({ sweep: false });
    const credentials = new LocalCredentialStore();
    serveStdio(() => createServer({ runtime, credentials, owner: () => 'local' }));
    break;
  }
  case 'motion-worker': {
    const { startMotionWorker } = await import('@cuttingfloor/motion');
    const port = Number(process.env.PORT ?? 8790);
    await startMotionWorker({ port, host: process.env.HOST ?? '0.0.0.0' });
    process.stderr.write(`motion worker on :${port}\n`);
    break;
  }
  case 'motion-launcher': {
    const { DockerEngine, startMotionLauncher } = await import('@cuttingfloor/motion');
    const env = process.env;
    const port = Number(env.PORT ?? 8790);
    const GiB = 1024 ** 3;
    const image = env.CUTTINGFLOOR_SANDBOX_IMAGE;
    const network = env.CUTTINGFLOOR_SANDBOX_NETWORK;
    if (!image || !network) {
      process.stderr.write(
        'motion-launcher needs CUTTINGFLOOR_SANDBOX_IMAGE and CUTTINGFLOOR_SANDBOX_NETWORK\n',
      );
      process.exit(1);
    }
    const server = await startMotionLauncher({
      port,
      host: env.HOST ?? '0.0.0.0',
      engine: new DockerEngine({
        image,
        network,
        seccomp: env.CUTTINGFLOOR_SANDBOX_SECCOMP ?? '/etc/cuttingfloor/seccomp.json',
        ...(env.CUTTINGFLOOR_SANDBOX_RUNTIME ? { runtime: env.CUTTINGFLOOR_SANDBOX_RUNTIME } : {}),
        // A render alone may use most of the machine; at once they share it.
        maxCpus: Number(env.CUTTINGFLOOR_SANDBOX_CPUS ?? 6),
        memoryBytes: Number(env.CUTTINGFLOOR_SANDBOX_MEMORY_GB ?? 4) * GiB,
        browsers: Number(env.CUTTINGFLOOR_MOTION_WORKERS ?? 3),
      }),
      // A 1080x1920 12 s render with alpha peaks near 2.4 GB and keeps six cores busy alone;
      // planned at 1.5 cores and 3 GB a render, an 8-core 32 GB server runs 5 at once.
      share: { cpus: 1.5, memoryBytes: 3 * GiB },
      ...(env.CUTTINGFLOOR_SANDBOX_MAX ? { max: Number(env.CUTTINGFLOOR_SANDBOX_MAX) } : {}),
    });
    const address = server.address();
    process.stderr.write(
      `motion launcher on :${typeof address === 'object' && address ? address.port : port}\n`,
    );
    break;
  }
  case 'version':
  case '--version':
    process.stdout.write(`${SERVER_VERSION}\n`);
    break;
  default:
    process.stderr.write(USAGE);
    process.exit(command && command !== 'help' && command !== '--help' ? 1 : 0);
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}
