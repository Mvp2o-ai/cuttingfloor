import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * Relays MCP messages between this process's stdio and the serving process's HTTP endpoint.
 * The stdio client then shares the server's job runner, so exports keep running after the
 * client exits, exactly as for HTTP clients.
 */
export async function bridgeStdioToHttp(url: string): Promise<void> {
  const stdio = new StdioServerTransport();
  const http = new StreamableHTTPClientTransport(new URL(url));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([stdio.close(), http.close()]);
    process.exit(0);
  };
  stdio.onmessage = (message) => {
    http.send(message).catch((error: Error) => {
      const id = (message as { id?: string | number }).id;
      if (id !== undefined) {
        void stdio.send({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: `cuttingfloor server unreachable: ${error.message}` },
        });
      }
    });
  };
  http.onmessage = (message) => {
    void stdio.send(message);
  };
  stdio.onclose = () => void close();
  http.onerror = (error) => process.stderr.write(`cuttingfloor bridge: ${error.message}\n`);
  await http.start();
  await stdio.start();
}
