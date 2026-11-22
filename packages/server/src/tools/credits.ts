import {
  type AccountGetResult,
  ClaimFreeCreditsInput,
  ClaimFreeCreditsResult,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { askJev, JEV_URL } from '../jev.ts';
import { PLAYER_TOOL_META } from '../player.ts';
import { guard, ok } from '../result.ts';
import { FALLBACK_SAMPLE, SAMPLES, type Sample, sampleBySlug, samplePath } from '../samples.ts';
import type { ServerDeps } from '../server.ts';
import { LOCAL } from './account.ts';
import { importBundled } from './media.ts';

// credits.claim: the first call records the claim on the account, once
// (`owners/{owner}/free-credits.json`: the flag, the use case verbatim, the time; never swept, so
// it stays queryable as funnel data); every call returns the balance. It grants, spends and gates
// nothing: no other tool reads the record, and balances come from account.get's source unchanged.
// Every call also makes sure an onboarding sample is in the library (imported free, and again
// once it has expired), and the player shows it, so a new user has a video to edit at once. Which
// sample: Jev picks the shelf card (samples.ts) that fits the use case, on the server's own key.

/** How long the claim waits for the router before showing the fallback. */
const ROUTE_MS = 8_000;

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
      const sample = await addSample(deps, use_case).catch((error: Error) => {
        process.stderr.write(`credits.claim: ${deps.owner()}: sample: ${error.message}\n`);
        return undefined;
      });
      const card = sample && sampleBySlug(sample.slug);
      const tryIt = card
        ? ` A sample to try is in the user's library and playing here: ${card.shows}. Offer this first edit on it, in the user's language and fitted to their task: "${card.starter}" Offer other edits that fit too, and ask them to send their own clip when they're ready.`
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
 * import job while that runs), or the one the router picks for the use case, imported free.
 * `owners/{owner}/onboarding.json` names it, so calls during an import don't start another.
 */
function addSample(deps: ServerDeps, useCase: string): Promise<Shown> {
  // Calls at once on this server share one look, so they never start two imports.
  const owner = deps.owner();
  const running = adding.get(owner);
  if (running) return running;
  const look = findOrImport(deps, owner, useCase).finally(() => adding.delete(owner));
  adding.set(owner, look);
  return look;
}

type Shown = { slug: string; media_id: string; job?: { id: string; status: string } };
const adding = new Map<string, Promise<Shown>>();

async function findOrImport(deps: ServerDeps, owner: string, useCase: string): Promise<Shown> {
  const rt = deps.runtime;
  const file = rt.ws.ownerDir(owner, 'onboarding.json');
  const named = await rt.ws.readJson<{ media_id: string; sample?: string }>(file);
  const held = named && (await rt.media.find(owner, named.media_id));
  if (held && held.status !== 'failed') {
    const job = held.job_id ? await rt.jobs.store.get(held.job_id, owner) : undefined;
    return {
      slug: named.sample ?? FALLBACK_SAMPLE,
      media_id: held.media_id,
      ...(job && job.status === 'working' ? { job: { id: job.id, status: job.status } } : {}),
    };
  }
  const sample = await route(deps, owner, useCase);
  const { record, job } = await importBundled(
    rt,
    owner,
    samplePath(sample),
    sample.file,
    'onboarding',
  );
  await rt.ws.writeJson(file, { media_id: record.media_id, sample: sample.slug });
  return { slug: sample.slug, media_id: record.media_id, job: { id: job.id, status: job.status } };
}

/**
 * The shelf card that fits the use case, as Jev judges it (one choice question, paid by the
 * server, not the user's credits). Without a key, an answer in time, or a card Jev names: the
 * fallback.
 */
export async function route(deps: ServerDeps, owner: string, useCase: string): Promise<Sample> {
  const fallback = sampleBySlug(FALLBACK_SAMPLE);
  const key = await deps.credentials.resolve(owner, 'typesafe').catch(() => undefined);
  if (!key || !useCase.trim()) return fallback;
  try {
    const reply = await askJev({
      base: deps.runtime.config.typesafeUrl ?? JEV_URL,
      key,
      images: [],
      state: { task: useCase },
      questions: {
        sample: {
          type: 'choice',
          instructions:
            'Which sample video fits `task` best: the one closest to what the user wants to make?',
          criteria: Object.fromEntries(SAMPLES.map((s) => [s.slug, s.fits])),
        },
      },
      signal: AbortSignal.timeout(ROUTE_MS),
    });
    const answer = reply.answers.sample as { choice?: string } | undefined;
    return sampleBySlug(answer?.choice);
  } catch (error) {
    process.stderr.write(`credits.claim: ${owner}: route: ${(error as Error).message}\n`);
    return fallback;
  }
}
