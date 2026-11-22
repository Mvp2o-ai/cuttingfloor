import {
  dot,
  embedTexts,
  keyframePictures,
  keyframeVectors,
  type MediaRecord,
  type PictureIndex,
} from '@cuttingfloor/engine';
import { JUDGMENTS_PER_CREDIT } from '@cuttingfloor/plans';
import {
  CfError,
  type JudgeAnswer,
  MediaSearchInput,
  MediaSearchResult,
  SEARCH_LIMITS,
  type SeekCriterion,
  withJob,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { askFrames } from '../frames.ts';
import { askJev, JEV_MODEL, JEV_URL } from '../jev.ts';
import { admitJob } from '../meter.ts';
import { framesUri } from '../render.ts';
import { doneReply, guard, jobReply, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { jevKeyRequired } from './judge.ts';

// media.search: media.seek across the floor. Free filters first (kind, ids, origin, name,
// length, time range, and optionally local picture similarity); then Jev judges what is left:
// each keyframe of each video (picked when the media was indexed) and each image for `looks`,
// passages of existing transcripts for `says`. A search estimated over a credit runs only with
// cost_override, so the agent can tell the user first.

type Input = z.infer<typeof MediaSearchInput>;
type Result = z.infer<typeof MediaSearchResult>;
type Skip = Result['skipped'][number];
type Match = Result['matches'][string][number];

/** Credits a search may spend before it waits for the user's say-so (cost_override). */
const CONFIRM_OVER_CREDITS = 1;
/** A says passage: about this long, ended at a sentence where one ends. */
const PASSAGE_SECONDS = 30;
/** Silence that ends a passage, in seconds. */
const PASSAGE_PAUSE = 5;

/** A criterion as the noul Jev is asked about the state entry `about`. */
function noul(criterion: z.infer<typeof SeekCriterion>, about: string) {
  const fields = typeof criterion === 'string' ? { instructions: criterion } : criterion;
  const text = fields.instructions;
  const named = typeof text === 'string' && text.includes(`\`${about}\``);
  return {
    type: 'noul' as const,
    ...fields,
    instructions: typeof text === 'string' && !named ? `In \`${about}\`: ${text}` : text,
  };
}

/** The words of a criterion, for local similarity. */
function words(criterion: z.infer<typeof SeekCriterion>): string {
  const text = typeof criterion === 'string' ? criterion : criterion.instructions;
  return typeof text === 'string' ? text : JSON.stringify(text);
}

export interface Passage {
  start: number;
  end: number;
  text: string;
}

/** A transcript's words in passages of about PASSAGE_SECONDS, within [from, until). */
export function passages(
  list: Array<{ text: string; start: number; end: number }>,
  from = 0,
  until = Number.POSITIVE_INFINITY,
): Passage[] {
  const out: Passage[] = [];
  let cur: Passage | null = null;
  for (const w of list) {
    if (w.end <= from || w.start >= until) continue;
    // A passage ends before it runs long, and at a pause: speech either side of one is apart.
    if (cur && (w.end - cur.start > PASSAGE_SECONDS || w.start - cur.end > PASSAGE_PAUSE)) {
      out.push(cur);
      cur = null;
    }
    if (!cur) cur = { start: w.start, end: w.end, text: w.text.trim() };
    else {
      cur.end = w.end;
      cur.text += ` ${w.text.trim()}`;
    }
    if (cur.end - cur.start >= PASSAGE_SECONDS / 2 && /[.?!]$/.test(w.text.trim())) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The media.list `from` of a record. */
function fromOf(r: MediaRecord): string {
  const s = r.source;
  return 'upload' in s
    ? 'upload'
    : 'url' in s
      ? 'url'
      : 'path' in s
        ? 'path'
        : 'job' in s
          ? 'render'
          : 'created';
}

/** Keyframe indices whose view overlaps [from, until). */
function inRange(index: PictureIndex, from: number, until: number): number[] {
  const out: number[] = [];
  for (const [i, k] of index.keyframes.entries()) {
    if (k.end > from && k.seconds < until) out.push(i);
    else if (k.seconds === k.end && k.seconds >= from && k.seconds < until) out.push(i);
  }
  return out;
}

interface Plan {
  record: MediaRecord;
  index?: PictureIndex;
  keyframes: number[];
  passages: Passage[];
}

const judgmentsOf = (p: Plan) => p.keyframes.length + p.passages.length;

/** Runs of consecutive judged units at or above `min`, as matches. */
function runs(
  units: Array<{ start: number; end: number; p: number; peak: () => Partial<Match> }>,
  min: number,
  base: Pick<Match, 'media_id' | 'name' | 'kind'>,
): Match[] {
  const out: Match[] = [];
  let open: { start: number; end: number; best: (typeof units)[number] } | null = null;
  const close = () => {
    if (!open) return;
    out.push({
      ...base,
      start: open.start,
      end: open.end,
      peak_seconds: open.best.start,
      peak_probability: open.best.p,
      ...open.best.peak(),
    });
    open = null;
  };
  for (const u of units) {
    if (u.p < min) {
      close();
      continue;
    }
    if (open && u.start <= open.end + 1e-6) {
      open.end = Math.max(open.end, u.end);
      if (u.p > open.best.p) open.best = u;
    } else {
      close();
      open = { start: u.start, end: u.end, best: u };
    }
  }
  close();
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function registerSearchTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  server.registerTool(
    'media.search',
    {
      title: 'Search media by natural language',
      description: [
        "Find moments across all the user's media from what you describe in plain words: media.seek across every file instead of one. looks criteria are judged on pictures: each keyframe of every video (a new keyframe wherever the picture changes, at least every 10 s, picked when the media was indexed) and each image. says criteria are judged on ~30 s passages of transcripts the media already has. You get matches per criterion across files (media, start, end, best moment and its picture), most probable first.",
        'COST. Each keyframe or passage judged is one judgment, however many criteria (up to 32) it carries; 200 judgments are a credit. Images cost 1 each; a 10-minute video about 50 to 260 by how much its picture changes. Every file the search keeps adds to the cost, so narrow first: kind, media_ids, from, name_contains, duration and from/until_seconds are free and cut what is judged before anything is. candidates is free too: it keeps the N media whose pictures look most like looks by local similarity, far cheaper, though it can drop media where the thing is small or brief. Ask everything you are looking for in one call.',
        'A search estimated over 1 credit is not run: the result has searched false, the estimate (judgments, credits, by kind, the largest media) and what the free filters could cut, and nothing is charged. Tell the user the cost and run it again with cost_override once they agree.',
        'HOW TO WRITE CRITERIA. As for media.seek: say what a matching picture shows or what the speech says, one judgment each, with {instructions, criteria: {true, false}} examples for accuracy. Pictures are judged at about 512 px, so small detail (a logo in a corner, fine print) can be missed.',
        'skipped lists media the filters kept that were not judged, and why (still indexing after import, no transcript, outside candidates): not found there is not the same as not there. Long-running: returns a task, or a job_id for job.get.',
      ].join('\n'),
      inputSchema: MediaSearchInput,
      outputSchema: withJob(MediaSearchResult),
      annotations: {
        title: 'Search media by natural language',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (args: Input, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (!(await deps.credentials.status(owner, 'typesafe')).configured) {
        throw jevKeyRequired('media.search');
      }
      const looks = args.looks ?? {};
      const says = args.says ?? {};
      const count = Object.keys(looks).length + Object.keys(says).length;
      if (count > SEARCH_LIMITS.criteria) {
        throw new CfError(
          'bad_request',
          `media.search takes up to ${SEARCH_LIMITS.criteria} criteria across looks and says; got ${count}`,
          { hint: 'Split the criteria across calls' },
        );
      }
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'media.search', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      const from = args.from_seconds ?? 0;
      const until = args.until_seconds ?? Number.POSITIVE_INFINITY;
      const wantLooks = Object.keys(looks).length > 0;
      const wantSays = Object.keys(says).length > 0;

      // Free filters.
      const name = args.name_contains?.toLowerCase();
      const ids = args.media_ids ? new Set(args.media_ids) : null;
      const kept = (await rt.media.list(owner)).filter((r) => {
        const kind = r.probe?.kind ?? null;
        const length = r.probe?.duration ?? 0;
        if (ids && !ids.has(r.media_id)) return false;
        if (args.kind && !(kind && (args.kind as string[]).includes(kind))) return false;
        if (args.from && !(args.from as string[]).includes(fromOf(r))) return false;
        if (name && !r.name.toLowerCase().includes(name)) return false;
        if (args.min_duration_seconds !== undefined && length < args.min_duration_seconds)
          return false;
        if (args.max_duration_seconds !== undefined && length > args.max_duration_seconds)
          return false;
        return true;
      });

      const skipped: Skip[] = [];
      const skip = (r: MediaRecord, route: Skip['route'], reason: Skip['reason']) =>
        skipped.push({ media_id: r.media_id, name: r.name, route, reason });
      const plans: Plan[] = [];
      for (const r of kept) {
        const plan: Plan = { record: r, keyframes: [], passages: [] };
        if (r.status !== 'ready') {
          if (wantLooks) skip(r, 'looks', 'not_ready');
          if (wantSays) skip(r, 'says', 'not_ready');
          continue;
        }
        if (wantLooks) {
          const s = await rt.indexer.status(owner, r);
          if (s.state === 'indexed') {
            plan.index = s.index;
            plan.keyframes = inRange(s.index, from, until);
          } else if (s.state === 'indexing') skip(r, 'looks', 'indexing');
          else if (s.state === 'failed') skip(r, 'looks', 'index_failed');
          else skip(r, 'looks', 'no_picture');
        }
        if (wantSays && (r.probe?.kind === 'video' || r.probe?.kind === 'audio')) {
          // Listing reads records without their analyses; the transcript is read on its own.
          const t = (await rt.media.find(owner, r.media_id))?.analyses?.transcript;
          if (t?.words.length) plan.passages = passages(t.words, from, until);
          else skip(r, 'says', 'no_transcript');
        }
        if (judgmentsOf(plan)) plans.push(plan);
      }

      // Free narrowing by local similarity to the looks criteria.
      let candidates: Result['candidates'];
      if (args.candidates !== undefined && wantLooks) {
        const pictured = plans.filter((p) => p.index && p.keyframes.length);
        if (pictured.length > args.candidates) {
          const queries = await embedTexts(
            Object.values(looks).map(words),
            AbortSignal.timeout(120_000),
          );
          const scored = await Promise.all(
            pictured.map(async (p) => {
              const vectors = await keyframeVectors(
                await rt.media.derivedDir(owner, p.record.media_id, 'search'),
                p.index as PictureIndex,
              );
              let best = -1;
              for (const i of p.keyframes) {
                for (const q of queries) best = Math.max(best, dot(vectors[i] as Float32Array, q));
              }
              return { plan: p, similarity: round(best) };
            }),
          );
          scored.sort((a, b) => b.similarity - a.similarity);
          candidates = scored.map((s) => ({
            media_id: s.plan.record.media_id,
            similarity: s.similarity,
          }));
          for (const s of scored.slice(args.candidates)) {
            s.plan.keyframes = [];
            skip(s.plan.record, 'looks', 'outside_candidates');
          }
        }
      }
      const judged = plans.filter((p) => judgmentsOf(p) > 0);

      // The estimate: one judgment per keyframe or passage.
      const judgments = judged.reduce((n, p) => n + judgmentsOf(p), 0);
      const byKind: Result['estimate']['by_kind'] = {};
      for (const p of judged) {
        const k = p.record.probe?.kind ?? 'other';
        const e = byKind[k] ?? { media: 0, judgments: 0 };
        e.media += 1;
        e.judgments += judgmentsOf(p);
        byKind[k] = e;
      }
      const estimate: Result['estimate'] = {
        media: judged.length,
        judgments,
        credits: round(judgments / JUDGMENTS_PER_CREDIT),
        by_kind: byKind,
        largest: [...judged]
          .sort((a, b) => judgmentsOf(b) - judgmentsOf(a))
          .slice(0, 10)
          .map((p) => ({
            media_id: p.record.media_id,
            name: p.record.name,
            kind: p.record.probe?.kind ?? 'other',
            duration_seconds: p.record.probe?.duration ?? null,
            judgments: judgmentsOf(p),
          })),
      };
      const asked = {
        ...Object.fromEntries(Object.entries(looks).map(([id, c]) => [id, noul(c, 'frame')])),
        ...Object.fromEntries(Object.entries(says).map(([id, c]) => [id, noul(c, 'passage')])),
      };
      const base = {
        estimate,
        asked,
        judged: judged.map((p) => p.record.media_id),
        skipped,
        ...(candidates ? { candidates } : {}),
      };
      const empty = Object.fromEntries(Object.keys(asked).map((id) => [id, [] as Match[]]));

      if (judgments > SEARCH_LIMITS.judgments) {
        throw new CfError(
          'limit_exceeded',
          `This search would ask ${judgments} judgments; one call takes up to ${SEARCH_LIMITS.judgments}`,
          {
            hint: 'The filters (kind, media, origin, name, length, time range, candidates) cut what is judged',
            detail: { estimate },
          },
        );
      }
      const init = { owner, tool: 'media.search', meta: {} };
      if (!judgments) {
        return doneReply(store, init, ok({ searched: true, ...base, matches: empty }), ctx);
      }
      if (estimate.credits > CONFIRM_OVER_CREDITS && !args.cost_override) {
        return doneReply(
          store,
          init,
          ok({ searched: false, ...base, warning: warning(estimate, args), matches: empty }),
          ctx,
        );
      }

      const admit = await admitJob(deps.limits);
      const job = await store.create({
        ...init,
        statusMessage: 'search: starting',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      const looksQ = Object.fromEntries(
        Object.entries(looks).map(([id, c]) => [id, noul(c, 'frame')]),
      );
      const saysQ = Object.fromEntries(
        Object.entries(says).map(([id, c]) => [id, noul(c, 'passage')]),
      );
      rt.jobs.start(
        job,
        async ({ signal, progress }) => {
          const key = await deps.credentials.resolve(owner, 'typesafe');
          if (!key)
            throw new CfError('credential_required', 'The judgment service API key went away');
          const jev = rt.config.typesafeUrl ?? JEV_URL;
          let done = 0;
          const tick = () => progress(done / judgments, `search: judged ${done} of ${judgments}`);
          const matches: Record<string, Match[]> = Object.fromEntries(
            Object.keys(asked).map((id) => [id, [] as Match[]]),
          );
          const p = (a: JudgeAnswer | undefined) => (a as { noul?: number } | undefined)?.noul ?? 0;

          for (const plan of judged) {
            const r = plan.record;
            const info = { media_id: r.media_id, name: r.name, kind: r.probe?.kind ?? 'other' };
            if (plan.keyframes.length && plan.index) {
              const index = plan.index;
              const stills = await keyframePictures(
                await rt.media.derivedDir(owner, r.media_id, 'search'),
                index,
                plan.keyframes,
              );
              const before = done;
              const frames = await askFrames({
                base: jev,
                key,
                times: plan.keyframes.map((i) => index.keyframes[i]?.seconds ?? 0),
                stills,
                withPrevious: false,
                questions: looksQ,
                signal,
                onFrame: (n) => {
                  done = before + n;
                  tick();
                },
              });
              const fps = r.probe?.video?.fps;
              const frameAt = (s: number) => (fps ? Math.floor((s * fps.num) / fps.den + 1e-6) : 0);
              for (const id of Object.keys(looksQ)) {
                const units = plan.keyframes.map((i, n) => {
                  const k = index.keyframes[i] as { seconds: number; end: number };
                  return {
                    start: k.seconds,
                    end: k.end,
                    p: p(frames[n]?.answers[id]),
                    peak: () => ({ uri: framesUri('media', r.media_id, [frameAt(k.seconds)]) }),
                  };
                });
                matches[id]?.push(...runs(units, args.min_probability, info));
              }
            }
            if (plan.passages.length) {
              const answers: Array<Record<string, JudgeAnswer>> = new Array(plan.passages.length);
              let next = 0;
              const worker = async () => {
                while (next < plan.passages.length) {
                  const i = next++;
                  const reply = await askJev({
                    base: jev,
                    key,
                    images: [],
                    state: { passage: (plan.passages[i] as Passage).text },
                    questions: saysQ,
                    signal,
                  });
                  answers[i] = reply.answers;
                  done += 1;
                  tick();
                }
              };
              await Promise.all(Array.from({ length: Math.min(8, plan.passages.length) }, worker));
              for (const id of Object.keys(saysQ)) {
                const units = plan.passages.map((ps, i) => ({
                  start: ps.start,
                  end: ps.end,
                  p: p(answers[i]?.[id]),
                  peak: () => ({ text: ps.text }),
                }));
                matches[id]?.push(...runs(units, args.min_probability, info));
              }
            }
          }
          await rt.meterJudgments(owner, `${job.id}-judgments`, 'media.search', judgments);
          for (const list of Object.values(matches)) {
            list.sort(
              (a, b) =>
                b.peak_probability - a.peak_probability ||
                a.name.localeCompare(b.name) ||
                a.start - b.start,
            );
            for (const m of list) {
              m.start = round(m.start);
              m.end = round(m.end);
              m.peak_seconds = round(m.peak_seconds);
              m.peak_probability = round(m.peak_probability);
            }
          }
          return ok({ searched: true, ...base, model: JEV_MODEL, matches }) as never;
        },
        { ...admit, lane: 'remote', work: judgments },
      );
      return jobReply(job, ctx);
    }),
  );
}

/** What a search over the confirm line would cost, what makes it up, and what is free to cut. */
export function warning(estimate: Result['estimate'], args: Input): string {
  const kinds = Object.entries(estimate.by_kind)
    .sort((a, b) => b[1].judgments - a[1].judgments)
    .map(([k, e]) => `${k} ${e.judgments} (${e.media} media)`)
    .join(', ');
  const top = estimate.largest.slice(0, 3);
  const topShare = top.reduce((n, l) => n + l.judgments, 0);
  const unused = [
    !args.kind && 'kind',
    !args.media_ids && 'media_ids',
    !args.from && 'from',
    !args.name_contains && 'name_contains',
    args.min_duration_seconds === undefined &&
      args.max_duration_seconds === undefined &&
      'duration',
    args.from_seconds === undefined && args.until_seconds === undefined && 'from/until_seconds',
    args.candidates === undefined && args.looks && 'candidates',
  ].filter(Boolean);
  return [
    `Not run: this search would judge ${estimate.judgments} keyframes and passages across ${estimate.media} media, about ${estimate.credits} credits, over the ${CONFIRM_OVER_CREDITS} credit that needs the user's agreement. Nothing was charged.`,
    `By kind: ${kinds}. The ${top.length} largest (${top.map((l) => `${l.name}: ${l.judgments}`).join('; ')}) are ${topShare} of them.`,
    unused.length
      ? `Free filters not used yet: ${unused.join(', ')}. Whatever they rule out is never judged.`
      : 'Every free filter is in use: this is what the search costs.',
    'To run it as estimated, tell the user the cost and call again with cost_override.',
  ].join(' ');
}
