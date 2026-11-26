import { randomBytes } from 'node:crypto';
import { defineCollection } from '@cuttingfloor/core';
import { ContactSupportInput, ContactSupportResult } from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

// support.contact: one file per message under the owner
// (`owners/{owner}/support-messages/{time}-{random}.json`: time, owner, message; never swept, so
// it stays queryable). The acknowledgement is fixed text, and it answers even when the message
// can't be kept (logged instead). It reads no balance and gates nothing.

export const SUPPORT_ACK = 'Thanks for the message.';

/** Messages an account sent with support.contact, one record each. */
export const SUPPORT_MESSAGES = defineCollection<SupportMessage & { owner?: string }>({
  name: 'support_messages',
  scope: 'owner',
  fs: { dir: 'support-messages' },
  db: { indexes: [['at']] },
});

export interface SupportMessage {
  at: string;
  message: string;
  improvement?: string;
}

/** The owner's support messages, newest first. */
export async function readSupportMessages(
  ws: ServerDeps['runtime']['ws'],
  owner: string,
): Promise<SupportMessage[]> {
  const messages = ws.records.collection(SUPPORT_MESSAGES, { owner });
  const found = await Promise.all(
    (await messages.ids()).map((id) => messages.get(id).catch(() => undefined)),
  );
  return found
    .filter((m): m is SupportMessage => typeof m?.message === 'string')
    .map(({ at, message, improvement }) => ({
      at,
      message,
      ...(improvement ? { improvement } : {}),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function registerSupportTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'support.contact',
    {
      title: 'Contact support',
      description:
        'Send a message to the cuttingfloor team: something failing or erroring; cuttingfloor not being able to do what the user asked; the user asking for a new feature or improvement; or a use case or capability the product does not yet handle - anything that would have helped the user or you be more successful. Filing it is useful even when nothing is broken; improvement says what tooling would have made the task easier. Returns an acknowledgement.',
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
    guard(async ({ message, improvement }) => {
      const owner = deps.owner();
      const at = new Date().toISOString();
      const ws = deps.runtime.ws;
      try {
        await ws.records
          .collection(SUPPORT_MESSAGES, { owner })
          .insertOnce(`${at.replace(/[:.]/g, '')}-${randomBytes(4).toString('hex')}`, {
            at,
            owner,
            message,
            ...(improvement ? { improvement } : {}),
          });
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

/**
 * Whether the nth tool error in a row offers support.contact: the 3rd, 9th, 27th…, each three
 * times further on, so an assistant stuck on one problem is asked less and less.
 */
export function offersSupport(n: number): boolean {
  let k = n;
  while (k > 3 && k % 3 === 0) k /= 3;
  return k === 3;
}

const errorRuns = new WeakMap<object, Map<string, number>>();

/**
 * The 3rd, 9th, 27th… tool error in a row from one owner (any success resets the count) also
 * offers support.contact, asking for the tooling change that would have helped. Wraps
 * tools/call as logToolCalls does, so it runs before any tool registers. The count is in memory:
 * a restart only delays the offer.
 */
export function offerSupportOnRepeatedErrors(server: McpServer, deps: ServerDeps): void {
  const protocol = server.server as unknown as {
    setRequestHandler: (method: string, ...rest: unknown[]) => void;
  };
  const set = protocol.setRequestHandler.bind(protocol);
  const counts = errorRuns.get(deps.runtime) ?? new Map<string, number>();
  errorRuns.set(deps.runtime, counts);
  protocol.setRequestHandler = (method, ...rest) => {
    const handler = rest.pop() as (request: unknown, ctx: unknown) => Promise<unknown>;
    if (method !== 'tools/call') return set(method, ...rest, handler);
    return set(method, ...rest, async (request: unknown, ctx: unknown) => {
      const result = (await handler(request, ctx)) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: { hint?: unknown };
      };
      const owner = deps.owner();
      if (!result?.isError) {
        counts.delete(owner);
        return result;
      }
      const n = (counts.get(owner) ?? 0) + 1;
      counts.set(owner, n);
      if (!offersSupport(n)) return result;
      const offer = `Seems like you're struggling, and it's not your fault: cuttingfloor should make this smoother. Tell the team with support.contact: what you were doing in message, and in improvement the tooling change that would have made it work, improved the experience, or given you the context to decide more efficiently.`;
      const sc = result.structuredContent;
      if (sc) sc.hint = typeof sc.hint === 'string' && sc.hint ? `${sc.hint}. ${offer}` : offer;
      result.content = [...(result.content ?? []), { type: 'text', text: offer }];
      return result;
    });
  };
}
