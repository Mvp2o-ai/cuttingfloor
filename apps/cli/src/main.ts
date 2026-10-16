#!/usr/bin/env node
import { EnvCredentialStore } from '@cuttingfloor/credentials';
import { MemoryJobStore } from '@cuttingfloor/jobs';
import { createServer } from '@cuttingfloor/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const USAGE = `cuttingfloor <command>

  serve               Run the MCP server over Streamable HTTP (the container's default)
  mcp                 Run the MCP server over stdio
  daemon start|stop|status|logs
                      The per-user daemon that owns jobs and workers (not built yet)
  keys set|list|test|remove <provider>
                      Manage provider keys in the OS keychain (not built yet)
`;

const [command] = process.argv.slice(2);

switch (command) {
  case 'mcp': {
    // Interim: in-process stores. The real front forwards to the daemon over a 0600 socket
    // (plans/spec.md §3), so jobs outlive the client.
    const jobs = new MemoryJobStore();
    const credentials = new EnvCredentialStore();
    serveStdio(() => createServer({ jobs, credentials, owner: () => 'local' }));
    break;
  }
  case 'serve':
    await import('@cuttingfloor/hosted');
    break;
  case 'daemon':
  case 'keys':
    process.stderr.write(`cuttingfloor ${command}: not built yet\n`);
    process.exit(1);
    break;
  default:
    process.stderr.write(USAGE);
    process.exit(command ? 1 : 0);
}
