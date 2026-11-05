import { randomBytes } from 'node:crypto';
import type { Workspace } from '@cuttingfloor/core';
import type { SignInStep } from './http.ts';

// The steps toward sign-in that only this server sees, for the funnel between a visit to the
// site and a first signed-in call. One file per step under its day (`funnel/{yyyy-mm-dd}/…`), so
// servers never lose a count. A step keeps its time and the client's name from its User-Agent,
// never an address. Kept 13 months, like the meter.

/** The client's name from a User-Agent: its first product, without the version. */
export function agentName(userAgent: string): string {
  const name = userAgent.trim().split(/[\s/;(]/, 1)[0] ?? '';
  return name.replace(/[^\w.-]/g, '').slice(0, 64) || 'unknown';
}

export async function recordSignInStep(
  ws: Workspace,
  step: SignInStep,
  userAgent: string,
): Promise<void> {
  const at = new Date().toISOString();
  await ws.writeJson(
    ws.path(
      'funnel',
      at.slice(0, 10),
      `${at.slice(11, 19).replaceAll(':', '')}-${randomBytes(4).toString('hex')}.json`,
    ),
    { at, step, agent: agentName(userAgent) },
    { exclusive: true },
  );
}
