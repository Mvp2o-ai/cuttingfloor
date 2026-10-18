import { randomUUID } from 'node:crypto';
import { CfError, type JudgeAnswer } from '@cuttingfloor/schema';

// TypeSafe's Jev, a judgment model: typed answers to questions about a state of text, JSON and
// images. The key stays here: it goes in the Authorization header and nowhere else, never into an
// error.

/** Images and Box need 1.14; pinned so an alias moving under us cannot change answers. */
export const JEV_MODEL = 'jev-1.14.0';
export const JEV_URL = 'https://api.typesafe.ai';

/** Requests in flight to Jev from this process, shared by every owner's jobs. */
const MAX_IN_FLIGHT = 16;
let inFlight = 0;
const waiting: Array<() => void> = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

export interface JevImage {
  /** Name the questions use in backticks: `frame`, `previous`, or a judge.ask state entry. */
  name: string;
  jpeg: Buffer;
}

export interface JevRequest {
  base: string;
  key: string;
  images: JevImage[];
  /** Text and JSON entries beside the images, e.g. the seconds between them. */
  state?: Record<string, unknown>;
  questions: Record<string, unknown>;
  signal: AbortSignal;
}

type RawAnswer = {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  box?: { top: number; bottom: number; left: number; right: number };
};

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Jev's answer in cuttingfloor's terms: boxes as {x, y, w, h} fractions, like faces and track. */
function answer(a: RawAnswer): JudgeAnswer {
  switch (a.type) {
    case 'noul':
      return { noul: round(a.noul ?? 0) };
    case 'choice':
      return {
        choice: a.choice ?? '',
        probabilities: a.probabilities ?? {},
        confidence: round(a.confidence ?? 0),
      };
    case 'score':
      return {
        score: round(a.score ?? 0),
        probabilities: a.probabilities ?? {},
        confidence: round(a.confidence ?? 0),
      };
    case 'box': {
      const b = a.box ?? { top: 0, bottom: 0, left: 0, right: 0 };
      return {
        box: {
          x: round(b.left),
          y: round(b.top),
          w: round(b.right - b.left),
          h: round(b.bottom - b.top),
        },
        confidence: round(a.confidence ?? 0),
      };
    }
    default:
      return a as JudgeAnswer;
  }
}

export interface JevReply {
  model: string;
  answers: Record<string, JudgeAnswer>;
}

/** Asks every question about one state; retries rate limits and overload. */
export async function askJev(req: JevRequest): Promise<JevReply> {
  const state: Record<string, unknown> = { ...req.state };
  const assets: Record<string, unknown> = {};
  for (const img of req.images) {
    const ref = `img-${randomUUID()}`;
    state[img.name] = ref;
    assets[ref] = { type: 'image', format: 'jpg', data_base64: img.jpeg.toString('base64') };
  }
  const body = JSON.stringify({
    model: JEV_MODEL,
    state,
    ...(req.images.length ? { assets } : {}),
    questions: req.questions,
  });
  // Images and Box questions are a preview TypeSafe turns on per request.
  const boxes = Object.values(req.questions).some((q) => (q as { type?: string }).type === 'box');
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await slot(() =>
        fetch(`${req.base}/v1/systemone`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${req.key}`,
            'content-type': 'application/json',
            ...(req.images.length || boxes ? { 'TypeSafe-Danger-Zone-Images': 'true' } : {}),
          },
          body,
          signal: req.signal,
        }),
      );
    } catch (error) {
      if (req.signal.aborted) throw new CfError('cancelled', 'Cancelled');
      if (attempt < 3) {
        await pause(attempt, req.signal);
        continue;
      }
      throw new CfError('engine_error', `TypeSafe is not reachable: ${(error as Error).message}`, {
        hint: 'Check the server can reach api.typesafe.ai, then ask again',
      });
    }
    if (res.ok) {
      const json = (await res.json()) as { model?: string; answers: Record<string, RawAnswer> };
      return {
        model: json.model ?? JEV_MODEL,
        answers: Object.fromEntries(Object.entries(json.answers).map(([id, a]) => [id, answer(a)])),
      };
    }
    const detail = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await pause(attempt, req.signal);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new CfError('credential_invalid', 'TypeSafe refused the API key', {
        detail: { provider: 'typesafe' },
        hint: 'Set a valid TYPESAFE_API_KEY (typesafe.ai) and restart the server',
      });
    }
    if (res.status === 413 || detail.includes('max_tokens_exceeded')) {
      throw new CfError(
        'limit_exceeded',
        'That is more than Jev reads in one call (64k tokens of state and questions, 32 MiB of images)',
        {
          detail: { provider: 'typesafe', status: res.status },
          hint: 'Split the questions or the state across calls: fewer or shorter text entries, fewer pictures, or half the questions in each call',
        },
      );
    }
    if (res.status === 400 || res.status === 422) {
      throw new CfError('bad_request', `TypeSafe rejected the questions: ${detail.slice(0, 500)}`, {
        hint: 'Each question is {type: noul | choice | score | box, instructions, criteria?}; choice criteria is {option: meaning}, score criteria an array of 2-10 levels, box takes no criteria',
      });
    }
    throw new CfError(
      'engine_error',
      `TypeSafe answered HTTP ${res.status}: ${detail.slice(0, 300)}`,
      {
        hint: 'Ask again shortly',
      },
    );
  }
}

function pause(attempt: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 500 * 2 ** attempt);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new CfError('cancelled', 'Cancelled'));
      },
      { once: true },
    );
  });
}
