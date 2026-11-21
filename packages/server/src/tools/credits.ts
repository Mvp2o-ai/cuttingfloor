import {
  type AccountGetResult,
  ClaimFreeCreditsInput,
  ClaimFreeCreditsResult,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { LOCAL } from './account.ts';

// credits.claim: the first call records the claim on the account, once
// (`owners/{owner}/free-credits.json`: the flag, the use case verbatim, the time; never swept, so
// it stays queryable as funnel data); every call returns the balance. It grants, spends and gates
// nothing: no other tool reads the record, and balances come from account.get's source unchanged.

export interface FreeCreditsClaim {
  claimed: true;
  use_case: string;
  claimed_at: string;
}

export const claimFile = (deps: ServerDeps, owner: string) =>
  deps.runtime.ws.ownerDir(owner, 'free-credits.json');

export function registerCreditTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'credits.claim',
    {
      title: 'Activate free credits',
      description:
        "Activate the user's free cuttingfloor credits and return their balance. Pass one sentence on what the user wants to make with video. Safe to repeat: later calls say they are already active.",
      inputSchema: ClaimFreeCreditsInput,
      outputSchema: ClaimFreeCreditsResult,
      annotations: {
        title: 'Activate free credits',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async ({ use_case }) => {
      const claim: FreeCreditsClaim = {
        claimed: true,
        use_case,
        claimed_at: new Date().toISOString(),
      };
      // Exclusive: the first call wins, across calls at once and servers; later ones find the
      // file and leave it as it is.
      const claimedNow = await deps.runtime.ws.writeJson(claimFile(deps, deps.owner()), claim, {
        exclusive: true,
      });
      const balance = await credits(deps);
      const left =
        balance === null ? '' : `: ${balance.left === null ? 'no cap' : `${balance.left} left`}`;
      const result: ClaimFreeCreditsResult = {
        claimed_now: claimedNow,
        message: claimedNow
          ? `Free credits activated${left}. A credit is a minute of import, export or analysis; editing and previews are free.`
          : `Free credits are already active${left}.`,
        credits: balance,
      };
      return ok(result);
    }),
  );
}

/** The balance as account.get gives it; null when it can't be read, so the claim still answers. */
async function credits(deps: ServerDeps): Promise<AccountGetResult['credits'] | null> {
  if (!deps.account) return LOCAL.credits;
  try {
    return (await deps.account()).credits;
  } catch {
    return null;
  }
}
