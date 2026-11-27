import {
  CfError,
  KEEP_MS,
  type ScoreDoc,
  ScoreEditArgs,
  type ScoreEditTool,
  type ScoreOp,
  scoreArgsShape,
  span,
} from '@cuttingfloor/schema';
import { scoreIdOf } from '../hash.ts';
import { GONE_TTL_MS, SCORES, SCORES_GONE } from '../storage/collections.ts';
import type { Collection } from '../storage/records.ts';
import type { Workspace } from '../workspace.ts';
import { applyScoreEdit, type ScoreMediaResolver, type ScoreOutcome } from './edit.ts';

export const SCORE_TTL_MS = KEEP_MS.score;

const GONE_DAYS = GONE_TTL_MS / 86_400_000;
const ID = /^sc_[0-9a-f]{32}$/;

/** Immutable, content-addressed scores with a sliding TTL, as timelines are kept. */
export class ScoreStore {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    this.#ws = ws;
  }

  #of(owner: string): Collection<ScoreDoc> {
    return this.#ws.records.collection(SCORES, { owner });
  }

  #id(id: string): string {
    if (!ID.test(id)) throw new CfError('bad_request', `Not a score id: ${id}`);
    return id;
  }

  /** Stores a document and returns its id. Storing the same document twice is a no-op. */
  async put(owner: string, doc: ScoreDoc): Promise<string> {
    const id = this.#id(await scoreIdOf(doc));
    const created = await this.#of(owner).insertOnce(id, doc);
    if (!created) await this.#of(owner).get(id, { touch: true });
    return id;
  }

  async get(owner: string, id: string): Promise<ScoreDoc> {
    const doc = await this.find(owner, id);
    if (doc) return doc;
    const gone = await this.#ws.records.collection(SCORES_GONE, { owner }).get(id);
    if (gone) {
      throw new CfError(
        'expired',
        `Score ${id} expired at ${gone.at}, ${span(SCORE_TTL_MS)} after its last use`,
        {
          hint: 'Pass the document from an earlier score.get to score.load to bring it back',
          detail: { score_id: id, at: gone.at },
        },
      );
    }
    throw new CfError('not_found', `No score ${id}`, {
      hint: `This account has had no score with this id in the last ${GONE_DAYS} days. Pass a score_id exactly as a result returned it (score.create, score.load or an edit); score.load brings one back from its document`,
      detail: { score_id: id },
    });
  }

  async find(owner: string, id: string): Promise<ScoreDoc | undefined> {
    return this.#of(owner).get(this.#id(id), { touch: true });
  }

  async sweep(ttlMs = SCORE_TTL_MS): Promise<number> {
    let n = 0;
    for (const owner of await this.#ws.records.owners()) {
      const gone = this.#ws.records.collection(SCORES_GONE, { owner });
      await this.#of(owner).expire(ttlMs, undefined, async (id) => {
        if (ID.test(id)) await gone.put(id, { at: new Date().toISOString() });
        n += 1;
      });
      await gone.expire(GONE_DAYS * 86_400_000);
    }
    return n;
  }
}

export interface ScoreBatchOp {
  tool: ScoreEditTool;
  args: Record<string, unknown>;
}

export type ScoreOpResult = Pick<
  ScoreOutcome,
  'part_id' | 'device_id' | 'region_id' | 'send_id' | 'note_ids'
> & { tool: string };

export interface ScoreEditOutcome {
  doc: ScoreDoc;
  /** The last op's outcome, with every op's warnings. */
  outcome: ScoreOutcome;
  results: ScoreOpResult[];
}

const REF_KEYS = ['part_id', 'device_id', 'region_id', 'send_id'] as const;

/**
 * Applies score edits to a copy of `base` and returns the new document, its parent set to
 * `baseId`. Later ops can use ids made by earlier ones: `{"$ref": "ops[2].region_id"}` or
 * `{"$ref": "ops[0].note_ids[1]"}`. All ops apply or none do.
 */
export function runScoreEdits(
  base: ScoreDoc,
  baseId: string,
  ops: ScoreBatchOp[],
  media: ScoreMediaResolver,
  record: ScoreOp,
): ScoreEditOutcome {
  const doc = structuredClone(base);
  const results: ScoreOpResult[] = [];
  const warnings: string[] = [];
  let last: ScoreOutcome | undefined;
  ops.forEach((op, index) => {
    const resolved = resolveRefs(op.args, results, index);
    const parsed = ScoreEditArgs[op.tool].safeParse(resolved);
    if (!parsed.success) {
      throw new CfError(
        'bad_request',
        `${ops.length > 1 ? `ops[${index}] (${op.tool}): ` : ''}${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`,
        { hint: `${op.tool} args: ${scoreArgsShape(op.tool)}` },
      );
    }
    try {
      last = applyScoreEdit(doc, op.tool, parsed.data as never, media);
    } catch (error) {
      if (error instanceof CfError && ops.length > 1) {
        throw new CfError(error.code, `ops[${index}] (${op.tool}): ${error.message}`, {
          ...(error.hint ? { hint: error.hint } : {}),
          detail: { ...error.detail, op_index: index },
        });
      }
      throw error;
    }
    warnings.push(...last.warnings);
    results.push({
      tool: op.tool,
      ...Object.fromEntries(REF_KEYS.flatMap((k) => (last?.[k] ? [[k, last[k]]] : []))),
      ...(last.note_ids ? { note_ids: last.note_ids } : {}),
    });
  });
  if (!last) throw new CfError('bad_request', 'No ops to apply');
  doc.parent = baseId;
  doc.op = record;
  return { doc, outcome: { ...last, warnings }, results };
}

function resolveRefs(value: unknown, results: ScoreOpResult[], index: number): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results, index));
  if (value && typeof value === 'object') {
    const ref = (value as { $ref?: unknown }).$ref;
    if (typeof ref === 'string' && Object.keys(value).length === 1) {
      return lookupRef(ref, results, index);
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results, index)]),
    );
  }
  return value;
}

function lookupRef(ref: string, results: ScoreOpResult[], index: number): string {
  const m = /^ops\[(\d+)\]\.(part_id|device_id|region_id|send_id|note_ids\[(\d+)\])$/.exec(ref);
  if (!m) {
    throw new CfError('bad_request', `Bad $ref "${ref}" in ops[${index}]`, {
      hint: 'ops[N].part_id, ops[N].device_id, ops[N].region_id, ops[N].send_id or ops[N].note_ids[M]',
    });
  }
  const target = Number(m[1]);
  if (target >= index) {
    throw new CfError(
      'bad_request',
      `ops[${index}] refers to ops[${target}], which has not run yet`,
    );
  }
  const r = results[target];
  const key = m[2] as string;
  const value =
    m[3] !== undefined ? r?.note_ids?.[Number(m[3])] : r?.[key as (typeof REF_KEYS)[number]];
  if (!value) {
    throw new CfError(
      'bad_request',
      `ops[${target}] (${r?.tool}) made no ${key} for $ref "${ref}"`,
    );
  }
  return value;
}
