import { randomBytes } from 'node:crypto';
import { ContactSupportInput, ContactSupportResult } from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

// support.contact: one file per message under the owner
// (`owners/{owner}/support-messages/{time}-{random}.json`: time, owner, message; never swept, so
// it stays queryable). The acknowledgement is fixed text, and it answers even when the message
// can't be kept (logged instead). It reads no balance and gates nothing.

export const SUPPORT_ACK = 'Thanks for the message.';

export function registerSupportTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'support.contact',
    {
      title: 'Contact support',
      description:
        'Send a message to the cuttingfloor team: something failing or erroring; cuttingfloor not being able to do what the user asked; the user asking for a new feature or improvement; or a use case or capability the product does not yet handle - anything that would have helped the user or you be more successful. Filing it is useful even when nothing is broken. Returns an acknowledgement.',
      inputSchema: ContactSupportInput,
      outputSchema: ContactSupportResult,
      annotations: {
        title: 'Contact support',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard(async ({ message }) => {
      const owner = deps.owner();
      const at = new Date().toISOString();
      const ws = deps.runtime.ws;
      try {
        await ws.writeJson(
          ws.ownerDir(
            owner,
            'support-messages',
            `${at.replace(/[:.]/g, '')}-${randomBytes(4).toString('hex')}.json`,
          ),
          { at, owner, message },
          { exclusive: true },
        );
      } catch (error) {
        process.stderr.write(
          `support.contact: ${owner}: not kept: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      const result: ContactSupportResult = { message: SUPPORT_ACK };
      return ok(result);
    }),
  );
}
