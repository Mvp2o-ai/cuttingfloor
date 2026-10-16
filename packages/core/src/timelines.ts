import {
  CfError,
  EditArgs,
  type EditTool,
  type TimelineDoc,
  type TimelineOp,
} from '@cuttingfloor/schema';
import { applyEdit, type MediaResolver, type OpOutcome } from './edit.ts';
import { timelineIdOf } from './hash.ts';
import type { Workspace } from './workspace.ts';

export const TIMELINE_TTL_MS = 24 * 60 * 60 * 1000;

/** Immutable, content-addressed timelines with a sliding TTL. */
export class TimelineStore {
  readonly #ws: Workspace;

  constructor(ws: Workspace) {
    this.#ws = ws;
  }

  #file(owner: string, id: string): string {
    if (!/^tl_[0-9a-f]{32}$/.test(id)) throw new CfError('bad_request', `Not a timeline id: ${id}`);
    return this.#ws.ownerDir(owner, 'timelines', `${id}.json`);
  }

  /** Stores a document and returns its id. Storing the same document twice is a no-op. */
  async put(owner: string, doc: TimelineDoc): Promise<string> {
    const id = await timelineIdOf(doc);
    const file = this.#file(owner, id);
    const created = await this.#ws.writeJson(file, doc, { exclusive: true });
    if (!created) await this.#ws.readJson(file, { touch: true });
    return id;
  }

  async get(owner: string, id: string): Promise<TimelineDoc> {
    const doc = await this.find(owner, id);
    if (!doc) {
      throw new CfError('expired', `Timeline ${id} is not available`, {
        hint: 'Timelines expire 24 hours after last use. Pass the JSON from an earlier timeline.get to timeline.load to bring it back',
      });
    }
    return doc;
  }

  async find(owner: string, id: string): Promise<TimelineDoc | undefined> {
    const doc = await this.#ws.readJson<TimelineDoc | V1Doc>(this.#file(owner, id), {
      touch: true,
    });
    return doc && migrate(doc);
  }

  async sweep(ttlMs = TIMELINE_TTL_MS): Promise<number> {
    let n = 0;
    for (const owner of await this.#ws.owners()) {
      n += await this.#ws.sweep(this.#ws.path('owners', owner, 'timelines'), ttlMs);
    }
    return n;
  }
}

/** A version 1 document: clips had no `type` and no compositing settings. */
type V1Doc = Omit<TimelineDoc, 'version'> & { version: 1 };

/** Brings a stored document up to the current version. Its id stays the handle it was stored under. */
export function migrate(doc: TimelineDoc | V1Doc): TimelineDoc {
  if (doc.version === 2) return doc;
  return {
    ...doc,
    version: 2,
    tracks: doc.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, type: 'media' })) })),
  };
}

export interface BatchOp {
  tool: EditTool;
  args: Record<string, unknown>;
}

export interface EditOutcome {
  doc: TimelineDoc;
  outcome: OpOutcome;
  results: Array<Pick<OpOutcome, 'clip_id' | 'clip_ids' | 'track_id'> & { tool: string }>;
}

/**
 * Applies edits to a copy of `base` and returns the new document, its parent set to `baseId`.
 * Later ops can use ids made by earlier ones: `{"$ref": "ops[2].clip_id"}` or
 * `{"$ref": "ops[0].clip_ids[1]"}`. All ops apply or none do.
 */
export function runEdits(
  base: TimelineDoc,
  baseId: string,
  ops: BatchOp[],
  media: MediaResolver,
  record: TimelineOp,
): EditOutcome {
  const doc = structuredClone(base);
  const results: EditOutcome['results'] = [];
  let last: OpOutcome | undefined;
  const warnings: string[] = [];
  ops.forEach((op, index) => {
    const resolved = resolveRefs(op.args, results, index);
    const parsed = EditArgs[op.tool].safeParse(resolved);
    if (!parsed.success) {
      throw new CfError(
        'bad_request',
        `ops[${index}] (${op.tool}): ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`,
      );
    }
    try {
      last = applyEdit(doc, op.tool, parsed.data as never, media);
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
      ...(last.clip_id ? { clip_id: last.clip_id } : {}),
      ...(last.clip_ids ? { clip_ids: last.clip_ids } : {}),
      ...(last.track_id ? { track_id: last.track_id } : {}),
    });
  });
  if (!last) throw new CfError('bad_request', 'No ops to apply');
  doc.parent = baseId;
  doc.op = record;
  return { doc, outcome: { ...last, warnings }, results };
}

function resolveRefs(value: unknown, results: EditOutcome['results'], index: number): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, results, index));
  if (value && typeof value === 'object') {
    const ref = (value as { $ref?: unknown }).$ref;
    if (typeof ref === 'string' && Object.keys(value).length === 1)
      return lookupRef(ref, results, index);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefs(v, results, index)]),
    );
  }
  return value;
}

function lookupRef(ref: string, results: EditOutcome['results'], index: number): string {
  const m = /^ops\[(\d+)\]\.(clip_id|track_id|clip_ids\[(\d+)\])$/.exec(ref);
  if (!m) {
    throw new CfError('bad_request', `Bad $ref "${ref}" in ops[${index}]`, {
      hint: 'Use ops[N].clip_id, ops[N].track_id or ops[N].clip_ids[M]',
    });
  }
  const target = Number(m[1]);
  if (target >= index)
    throw new CfError(
      'bad_request',
      `ops[${index}] refers to ops[${target}], which has not run yet`,
    );
  const r = results[target];
  const value =
    m[3] !== undefined
      ? r?.clip_ids?.[Number(m[3])]
      : m[2] === 'clip_id'
        ? r?.clip_id
        : r?.track_id;
  if (!value) throw new CfError('bad_request', `ops[${target}] made no ${m[2]} for $ref "${ref}"`);
  return value;
}
