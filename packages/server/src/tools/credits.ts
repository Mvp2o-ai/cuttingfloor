import { randomBytes } from 'node:crypto';
import { defineCollection } from '@cuttingfloor/core';
import {
  type AccountGetResult,
  CfError,
  ClaimFreeCreditsInput,
  ClaimFreeCreditsResult,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { askJev, JEV_URL } from '../jev.ts';
import { PLAYER_TOOL_META } from '../player.ts';
import { guard, ok, toErrorResult } from '../result.ts';
import type { Runtime } from '../runtime.ts';
import {
  DEMO_CLIPS,
  FALLBACK_SAMPLE,
  SAMPLES,
  type Sample,
  sampleBySlug,
  samplePath,
} from '../samples.ts';
import type { ServerDeps } from '../server.ts';
import { LOCAL } from './account.ts';
import { importBundled } from './media.ts';
import { matchingSkills } from './skills.ts';

// credits.claim: the first call records the claim on the account, once
// (record `free-credits` in `account_claims`: the flag, the use case verbatim, the time; never swept, so
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

/** The account's claim of its free credits: one record, id `free-credits`. */
export const CLAIMS = defineCollection<FreeCreditsClaim>({
  name: 'account_claims',
  scope: 'owner',
  fs: { dir: '' },
});

/** The sample credits.claim added for the account: one record, id `onboarding`. */
export const ONBOARDING = defineCollection<{ media_id: string; sample?: string }>({
  name: 'account_onboarding',
  scope: 'owner',
  fs: { dir: '' },
});

/**
 * Every task an assistant gave credits.claim, one record per call (id: the time, then a random
 * tail): a user's later projects add to the list; the claim record keeps only the first.
 */
export interface ClaimedTask {
  use_case: string;
  at: string;
}
export const CLAIM_TASKS = defineCollection<ClaimedTask>({
  name: 'account_claim_tasks',
  scope: 'owner',
  fs: { dir: 'claim-tasks' },
});

/**
 * The claim's file on the filesystem store, for the one caller that must answer without waiting
 * (createServer builds the instructions synchronously). A store that is not the filesystem
 * needs the claim handed in with the account instead.
 */
export const claimFile = (deps: ServerDeps, owner: string) =>
  deps.runtime.ws.ownerDir(owner, 'free-credits.json');

/** The accounts each runtime has seen claimed. A claim is never undone, so this never goes stale. */
const seen = new WeakMap<Runtime, Set<string>>();

function sawClaim(runtime: Runtime, owner: string): void {
  const owners = seen.get(runtime) ?? new Set<string>();
  seen.set(runtime, owners);
  owners.add(owner);
}

/** Whether this process has seen the account's claim: an answer without a read, for createServer. */
export function claimSeen(runtime: Runtime, owner: string): boolean {
  return seen.get(runtime)?.has(owner) ?? false;
}

/**
 * Whether the account's free credits are claimed, from any record store. A server whose store
 * is not the filesystem awaits this and hands the answer to createServer as `claimed`. One read
 * by id until the account claims, none after.
 */
export async function creditsClaimed(runtime: Runtime, owner: string): Promise<boolean> {
  if (claimSeen(runtime, owner)) return true;
  const claimed = await runtime.ws.records.collection(CLAIMS, { owner }).has('free-credits');
  if (claimed) sawClaim(runtime, owner);
  return claimed;
}

export function registerCreditTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'credits.claim',
    {
      title: 'Activate account',
      description:
        "Activate the user's cuttingfloor account with the task they want to do, in their words. Personalises their start: records what they're making, adds a sample video that fits it to their library (playing here) and returns their balance. Once per account; later calls return the balance.",
      inputSchema: ClaimFreeCreditsInput,
      outputSchema: ClaimFreeCreditsResult,
      _meta: PLAYER_TOOL_META,
      annotations: {
        title: 'Activate account',
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
      const claimedNow = await deps.runtime.ws.records
        .collection(CLAIMS, { owner: deps.owner() })
        .insertOnce('free-credits', claim);
      // Claimed now or before: either way the account's next connection is not welcomed again.
      sawClaim(deps.runtime, deps.owner());
      // Every call adds its task, first or later: a user's next project is worth knowing too.
      await deps.runtime.ws.records
        .collection(CLAIM_TASKS, { owner: deps.owner() })
        .put(`${claim.claimed_at.replace(/\D/g, '')}${randomBytes(3).toString('hex')}`, {
          use_case,
          at: claim.claimed_at,
        })
        .catch((error: Error) =>
          process.stderr.write(`credits.claim: ${deps.owner()}: task: ${error.message}\n`),
        );
      const balance = await credits(deps);
      const left =
        balance === null ? '' : `: ${balance.left === null ? 'no cap' : `${balance.left} left`}`;
      const sample = await addSample(deps, use_case).catch((error: Error) => {
        process.stderr.write(`credits.claim: ${deps.owner()}: sample: ${error.message}\n`);
        return undefined;
      });
      // The skills that fit the task, as skills.search would find them: named, so the agent can
      // read the method before it starts. None when nothing fits or the library can't load.
      const fits = await matchingSkills(use_case).catch((error: Error) => {
        process.stderr.write(`credits.claim: ${deps.owner()}: skills: ${error.message}\n`);
        return [];
      });
      const related = fits.length
        ? ` Skills that may fit this task, to read with skills.get: ${fits
            .slice(0, RELATED_SKILLS)
            .map((f) => f.slug)
            .join('; ')}.`
        : '';
      const card = sample && sampleBySlug(sample.slug);
      const tryIt = card
        ? ` A sample to try is in the user's library and playing here: ${card.shows}. Offer this first edit on it, in the user's language and fitted to their task: "${card.starter}" Offer other edits that fit too, and ask them to send their own clip when they're ready.`
        : '';
      const result: ClaimFreeCreditsResult = {
        claimed_now: claimedNow,
        message: claimedNow
          ? `Welcome to cuttingfloor: the account is active${left}.${tryIt} Making is free: edits, exports, motion graphics and voiceovers. Exports download with a cuttingfloor watermark; export.release removes the watermark for credits, priced by length. cuttingfloor can do anything CapCut or DaVinci Resolve can; if something gets in the way, tell us with support.contact so we can improve the user's experience.${related}`
          : `The account is already active${left}.${related}`,
        credits: balance,
        media_id: sample?.media_id ?? null,
        ...(sample?.job ? { job_id: sample.job.id, status: sample.job.status } : {}),
      };
      return ok(result);
    }),
  );
}

/** At most this many related skills are named in the claim's answer. */
const RELATED_SKILLS = 3;

/** How many calls are refused for the claim before the account's calls run anyway. */
export const CLAIM_REFUSALS = 2;

/** Tools that run before a claim: the claim itself, and the way to tell us something is wrong. */
const BEFORE_CLAIM = new Set(['credits.claim', 'support.contact']);

/**
 * Until the account claims its free credits, its tool calls are refused with `claim_required`
 * and the way to claim, at most CLAIM_REFUSALS times for good (counted in the records store);
 * then they run as before, so an assistant that can't or won't claim (an old connector's tool
 * list without credits.claim) is never stuck. Hosts keep the instructions from the day a
 * connector was added, so the welcome alone doesn't reach everyone; a refusal does. A signed-in
 * hosted account only; a store that can't be read lets the call run. Wraps the request handler
 * the SDK sets when the first tool registers, so it must run before any tool is.
 */
export function gateUntilClaimed(server: McpServer, deps: ServerDeps): void {
  if (deps.runtime.config.mode !== 'hosted' || !deps.account || deps.claimGate === false) return;
  const protocol = server.server as unknown as {
    setRequestHandler: (method: string, ...rest: unknown[]) => void;
  };
  const set = protocol.setRequestHandler.bind(protocol);
  protocol.setRequestHandler = (method, ...rest) => {
    const handler = rest.pop() as (request: unknown, ctx: unknown) => Promise<unknown>;
    if (method !== 'tools/call') return set(method, ...rest, handler);
    return set(method, ...rest, async (request: unknown, ctx: unknown) => {
      const tool = String((request as { params?: { name?: unknown } }).params?.name ?? '');
      if (!BEFORE_CLAIM.has(tool) && (await refuse(deps.runtime, deps.owner())))
        return toErrorResult(
          new CfError('claim_required', "This account isn't activated yet.", {
            hint: `Call credits.claim with the task the user is doing (ask them what they'd like to make if you don't know), then call ${tool} again. It's free and puts a sample video that fits the task in their library.`,
          }),
        );
      return handler(request, ctx);
    });
  };
}

/** The account's refusals so far: one record, id `claim-gate`. */
export const CLAIM_GATE = defineCollection<{ refusals: number; first_at: string }>({
  name: 'account_claim_gate',
  scope: 'owner',
  fs: { dir: '' },
});

/** The accounts this process lets through: claimed, or refused as often as they will be. */
const open = new WeakMap<Runtime, Set<string>>();

async function refuse(runtime: Runtime, owner: string): Promise<boolean> {
  if (open.get(runtime)?.has(owner)) return false;
  try {
    if (!(await creditsClaimed(runtime, owner))) {
      const gate = runtime.ws.records.collection(CLAIM_GATE, { owner });
      await gate.insertOnce('claim-gate', { refusals: 0, first_at: new Date().toISOString() });
      const after = await gate.update('claim-gate', { inc: { refusals: 1 } });
      if ((after?.refusals ?? Number.POSITIVE_INFINITY) <= CLAIM_REFUSALS) return true;
    }
  } catch (error) {
    process.stderr.write(`credits.gate: ${owner}: ${(error as Error).message}\n`);
    return false;
  }
  const owners = open.get(runtime) ?? new Set<string>();
  open.set(runtime, owners);
  owners.add(owner);
  return false;
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
 * Activates an account on its own behalf with one of our demo clips (DEMO_CLIPS) as its
 * onboarding clip, for someone signing up through that demo: the claim is recorded with the
 * demo's task and the clip starts importing into their library, so the demo's first call
 * (credits.claim) finds both and answers at once. An account already active keeps its claim, and
 * one already holding an onboarding clip keeps that clip.
 */
export async function activateWithDemo(
  runtime: Runtime,
  owner: string,
  useCase: string,
  slug: string,
): Promise<{ media_id: string }> {
  const sample = DEMO_CLIPS.find((s) => s.slug === slug);
  if (!sample) throw new Error(`no demo clip ${slug}`);
  const at = new Date().toISOString();
  const claim: FreeCreditsClaim = { claimed: true, use_case: useCase, claimed_at: at };
  if (await runtime.ws.records.collection(CLAIMS, { owner }).insertOnce('free-credits', claim)) {
    await runtime.ws.records
      .collection(CLAIM_TASKS, { owner })
      .put(`${at.replace(/\D/g, '')}${randomBytes(3).toString('hex')}`, { use_case: useCase, at });
  }
  sawClaim(runtime, owner);
  const onboarding = runtime.ws.records.collection(ONBOARDING, { owner });
  const named = await onboarding.get('onboarding');
  const held = named && (await runtime.media.find(owner, named.media_id));
  if (held) return { media_id: held.media_id };
  const { record } = await importBundled(
    runtime,
    owner,
    samplePath(sample),
    sample.file,
    'onboarding',
  );
  await onboarding.put('onboarding', { media_id: record.media_id, sample: sample.slug });
  return { media_id: record.media_id };
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
  const onboarding = rt.ws.records.collection(ONBOARDING, { owner });
  const named = await onboarding.get('onboarding');
  const held = named && (await rt.media.find(owner, named.media_id));
  // Kept once added, even if its import failed: claiming again doesn't import it again (it would
  // fail the same way). Only a sample that has gone is added again.
  if (held) {
    const job = held.job_id ? await rt.jobs.store.get(held.job_id, owner) : undefined;
    return {
      slug: named.sample ?? FALLBACK_SAMPLE,
      media_id: held.media_id,
      ...(job && job.status === 'working' ? { job: { id: job.id, status: job.status } } : {}),
    };
  }
  // A sample already chosen for the account is imported again as it was (its import failed or
  // its file went), not routed again: the first task picked it.
  const sample =
    (named?.sample && sampleBySlug(named.sample)) || (await route(deps, owner, useCase));
  const { record, job } = await importBundled(
    rt,
    owner,
    samplePath(sample),
    sample.file,
    'onboarding',
  );
  await onboarding.put('onboarding', { media_id: record.media_id, sample: sample.slug });
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
