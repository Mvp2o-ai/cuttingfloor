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
