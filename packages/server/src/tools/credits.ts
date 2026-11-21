import { fileURLToPath } from 'node:url';
import {
  type AccountGetResult,
  ClaimFreeCreditsInput,
  ClaimFreeCreditsResult,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { PLAYER_TOOL_META } from '../player.ts';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { LOCAL } from './account.ts';
import { importBundled } from './media.ts';

// credits.claim: the first call records the claim on the account, once
// (`owners/{owner}/free-credits.json`: the flag, the use case verbatim, the time; never swept, so
// it stays queryable as funnel data); every call returns the balance. It grants, spends and gates
// nothing: no other tool reads the record, and balances come from account.get's source unchanged.
// Every call also makes sure the onboarding sample is in the library (imported free, and again
// once it has expired), and the player shows it, so a new user has a video to edit at once.

/** The onboarding sample: 30 seconds of Big Buck Bunny (assets/onboarding/README.md). */
const SAMPLE = fileURLToPath(
  new URL('../../assets/onboarding/big-buck-bunny.mp4', import.meta.url),
);
const SAMPLE_NAME = 'big-buck-bunny.mp4';

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
      title: 'Claim free credits',
      description:
        "Claim the user's free cuttingfloor credits and return their balance. Pass the task the user is looking to complete with cuttingfloor.",
      inputSchema: ClaimFreeCreditsInput,
      outputSchema: ClaimFreeCreditsResult,
      _meta: PLAYER_TOOL_META,
      annotations: {
        title: 'Claim free credits',
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
      const sample = await addSample(deps).catch((error: Error) => {
        process.stderr.write(`credits.claim: ${deps.owner()}: sample: ${error.message}\n`);
        return undefined;
      });
      const tryIt = sample
        ? " Big Buck Bunny, a 30-second clip, is in the user's library and playing here: offer a few edits to try on it that fit their task, such as overlays, captions, a voiceover, a new opening or a new end card, and ask which to do."
        : '';
      const result: ClaimFreeCreditsResult = {
        claimed_now: claimedNow,
        message: claimedNow
          ? `Free credits claimed${left}.${tryIt} cuttingfloor can do anything CapCut or DaVinci Resolve can; if something gets in the way, tell us with support.contact so we can improve the user's experience.`
          : `Free credits already claimed${left}.`,
        credits: balance,
        media_id: sample?.media_id ?? null,
        ...(sample?.job ? { job_id: sample.job.id, status: sample.job.status } : {}),
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

/**
 * The onboarding sample in the owner's library: the one added before while it lives (with its
 * import job while that runs), or a new free import. `owners/{owner}/onboarding.json` names it, so
 * calls during an import don't start another.
 */
function addSample(deps: ServerDeps): Promise<Sample> {
  // Calls at once on this server share one look, so they never start two imports.
  const owner = deps.owner();
  const running = adding.get(owner);
  if (running) return running;
  const look = findOrImport(deps, owner).finally(() => adding.delete(owner));
  adding.set(owner, look);
  return look;
}

type Sample = { media_id: string; job?: { id: string; status: string } };
const adding = new Map<string, Promise<Sample>>();

async function findOrImport(deps: ServerDeps, owner: string): Promise<Sample> {
  const rt = deps.runtime;
  const file = rt.ws.ownerDir(owner, 'onboarding.json');
  const named = await rt.ws.readJson<{ media_id: string }>(file);
  const held = named && (await rt.media.find(owner, named.media_id));
  if (held && held.status !== 'failed') {
    const job = held.job_id ? await rt.jobs.store.get(held.job_id, owner) : undefined;
    return {
      media_id: held.media_id,
      ...(job && job.status === 'working' ? { job: { id: job.id, status: job.status } } : {}),
    };
  }
  const { record, job } = await importBundled(rt, owner, SAMPLE, SAMPLE_NAME, 'onboarding');
  await rt.ws.writeJson(file, { media_id: record.media_id });
  return { media_id: record.media_id, job: { id: job.id, status: job.status } };
}
