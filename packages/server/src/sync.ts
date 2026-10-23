import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { providerHeader } from '@cuttingfloor/credentials';
import { download } from '@cuttingfloor/engine';
import { CfError } from '@cuttingfloor/schema';

// sync. labs (sync.so), the lip-sync provider behind create.lipsync, called with the user's own
// key. The key goes in the x-api-key header and nowhere else: never into an error, a log or a
// file. Upload URLs are temporary credentials too, so they stay out of errors as well.

export const SYNC_URL = 'https://api.sync.so';

/** How long a generation may take before the job gives up on it. */
const MAX_WAIT_MS = 60 * 60_000;

export interface SyncLipsync {
  base: string;
  key: string;
  /** The picture to re-sync (an MP4) and the speech (a WAV), cut out already. */
  video: string;
  audio: string;
  model: string;
  syncMode: string;
  /** Where the result goes, and what the download may take. */
  dest: string;
  maxBytes: number;
  allowPrivate: boolean;
  signal: AbortSignal;
  progress: (fraction: number, message: string) => void;
}

/**
 * How to give the server a sync. labs key, for whichever mode it runs in (both, hosted first).
 * Hosted with saved keys, the account page comes first: the user adds the key there once.
 */
export function syncKeyHint(mode: 'local' | 'hosted', keysUrl?: string): string {
  const header = `send the header ${providerHeader('sync')}: <key> with each request (put it in the headers of this server's entry in your MCP client's config)`;
  const local =
    'add SYNC_API_KEY=<key> to the .env next to compose.yaml (or the Docker secret sync_api_key), then docker compose up -d';
  const where = 'Get a key at sync.so (Settings → API keys), then';
  if (mode === 'hosted' && keysUrl)
    return `Add your sync. labs key at ${keysUrl} (get one at sync.so → Settings → API keys), then call again. Or ${header}`;
  return mode === 'hosted'
    ? `${where} ${header}. Running it yourself instead: ${local}`
    : `${where} ${local}. On a hosted server: ${header}`;
}

export function syncKeyRequired(tool: string, mode: 'local' | 'hosted', keysUrl?: string): CfError {
  return new CfError('credential_required', `${tool} needs your sync. labs API key`, {
    detail: {
      provider: 'sync',
      env: 'SYNC_API_KEY',
      header: providerHeader('sync'),
      ...(keysUrl ? { keys_url: keysUrl } : {}),
    },
    hint: syncKeyHint(mode, keysUrl),
  });
}

type SyncBody = {
  message?: unknown;
  error?: unknown;
  errorCode?: string;
  suggestion?: string;
  field?: string;
  retryAfterSeconds?: number;
};

/** sync. labs error codes that are a limit of the user's plan, model or account: facts to act on. */
const LIMITS: Record<string, string> = {
  generation_input_duration_greater_than_max_duration:
    'Send a shorter range of the video (range) or of the speech (audio_range)',
  generation_model_duration_exceeded:
    'Send a shorter range (range / audio_range), or pick another model',
  generation_plan_duration_exceeded:
    "Send a shorter range (range / audio_range), or raise the plan on the user's sync. labs account",
  file_size_exceeds_plan_limit: 'Send a shorter range of the video (range)',
  free_tier_generations_exhausted:
    "The user's free sync. labs generations for this month are used; they can upgrade at sync.so",
  insufficient_credits: 'The user needs more credits on their sync. labs account (sync.so)',
  plan_feature_unavailable:
    "Pick another model, or raise the plan on the user's sync. labs account",
  account_payment_required: 'The user needs to fix the payment on their sync. labs account',
  account_on_hold: 'The user needs to resolve the hold on their sync. labs account',
  account_suspended: 'The user needs to contact sync. labs support (support@sync.so)',
  concurrency_limit_reached:
    "The user's sync. labs plan runs fewer generations at once; wait for others to finish, then call again",
  generation_input_resolution_unsupported:
    "The provider can't take this picture size; make the video smaller first (export.video with a smaller size, then media.import)",
};

const text = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);

/** A sync. labs refusal as a CfError carrying its facts (status, error code, field). */
export function syncError(status: number, body: SyncBody, mode: 'local' | 'hosted'): CfError {
  const code = body.errorCode;
  const said = text(body.message ?? body.error).slice(0, 500) || `HTTP ${status}`;
  const detail: Record<string, unknown> = {
    provider: 'sync',
    ...(status ? { status } : {}),
    ...(code ? { error_code: code } : {}),
    ...(body.field ? { field: body.field } : {}),
  };
  const suggestion = body.suggestion ? `${body.suggestion}. ` : '';
  if (status === 401 || status === 403) {
    return new CfError('credential_invalid', `sync. labs refused the API key: ${said}`, {
      detail,
      hint: `Check the key is current and belongs to the user. ${syncKeyHint(mode)}`,
    });
  }
  if (code && LIMITS[code]) {
    return new CfError('limit_exceeded', `sync. labs: ${said}`, {
      detail,
      hint: `${suggestion}${LIMITS[code]}`,
    });
  }
  if (status === 400 || status === 404 || status === 409 || status === 422 || code) {
    return new CfError('bad_request', `sync. labs refused it: ${said}`, {
      detail,
      hint: `${suggestion}Check the video shows one clear face and the audio is speech; the provider's error codes are at https://api.sync.so/v2/errors`,
    });
  }
  return new CfError('engine_error', `sync. labs answered HTTP ${status}: ${said}`, {
    detail,
    hint: 'Call again shortly',
  });
}

/** Re-sync `video` to `audio`; the result lands at `dest`. Returns its duration when told. */
export async function syncLipsync(
  req: SyncLipsync,
  mode: 'local' | 'hosted',
): Promise<{ duration?: number; id: string }> {
  const api = async <T>(path: string, init: { method: string; body?: unknown; idem?: string }) => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${req.base}${path}`, {
          method: init.method,
          headers: {
            'x-api-key': req.key,
            accept: 'application/json',
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            ...(init.idem ? { 'idempotency-key': init.idem } : {}),
          },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
          signal: req.signal,
        });
      } catch (error) {
        if (req.signal.aborted) throw new CfError('cancelled', 'Cancelled');
        if (attempt < 3) {
          await pause(1000 * 2 ** attempt, req.signal);
          continue;
        }
        throw new CfError(
          'engine_error',
          `sync. labs is not reachable: ${(error as Error).message}`,
          {
            detail: { provider: 'sync' },
            hint: 'Check the server can reach api.sync.so, then call again',
          },
        );
      }
      const body = (await res.json().catch(() => ({}))) as SyncBody & T;
      if (res.ok) return body as T;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        const after = Number(res.headers.get('retry-after') ?? body.retryAfterSeconds);
        await pause(
          Math.min(30_000, (Number.isFinite(after) ? after : 2 ** attempt) * 1000),
          req.signal,
        );
        continue;
      }
      throw syncError(res.status, body, mode);
    }
  };

  /** Presigned upload, PUT, then register: an asset id the generation reads. */
  const upload = async (file: string, type: 'VIDEO' | 'AUDIO', contentType: string) => {
    const { size } = await stat(file);
    const name = basename(file);
    const presign = await api<{ uploadUrl: string; url: string }>('/v2/assets/upload', {
      method: 'POST',
      body: { fileName: name, contentType, size },
    });
    let put: Response;
    try {
      put = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': contentType, 'content-length': String(size) },
        body: Readable.toWeb(createReadStream(file)) as ReadableStream,
        duplex: 'half',
        signal: req.signal,
      } as RequestInit);
    } catch (error) {
      if (req.signal.aborted) throw new CfError('cancelled', 'Cancelled');
      throw new CfError(
        'engine_error',
        `Uploading to sync. labs failed: ${(error as Error).message}`,
        {
          detail: { provider: 'sync' },
          hint: 'Call again shortly',
        },
      );
    }
    if (!put.ok) {
      throw new CfError(
        'engine_error',
        `sync. labs storage refused the upload: HTTP ${put.status}`,
        {
          detail: { provider: 'sync', status: put.status },
          hint: 'Call again shortly',
        },
      );
    }
    const asset = await api<{ id: string }>('/v2/assets', {
      method: 'POST',
      body: { url: presign.url, type, name },
    });
    return asset.id;
  };

  req.progress(0, 'uploading the video to sync. labs');
  const videoId = await upload(req.video, 'VIDEO', 'video/mp4');
  req.progress(0.15, 'uploading the speech to sync. labs');
  const audioId = await upload(req.audio, 'AUDIO', 'audio/wav');
  req.progress(0.25, 'starting the lip sync');
  type Generation = {
    id: string;
    status: string;
    outputUrl?: string;
    outputDuration?: number;
    error?: string;
    errorCode?: string;
  };
  let gen = await api<Generation>('/v2/generate', {
    method: 'POST',
    idem: `cf-${randomUUID()}`,
    body: {
      model: req.model,
      input: [
        { type: 'video', assetId: videoId },
        { type: 'audio', assetId: audioId },
      ],
      options: { sync_mode: req.syncMode },
    },
  });
  const started = Date.now();
  while (gen.status !== 'COMPLETED') {
    if (gen.status === 'FAILED' || gen.status === 'REJECTED') {
      throw syncError(
        0,
        {
          message: gen.error ?? gen.status,
          ...(gen.errorCode ? { errorCode: gen.errorCode } : {}),
        },
        mode,
      );
    }
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new CfError('engine_error', `sync. labs generation ${gen.id} took over an hour`, {
        detail: { provider: 'sync', generation_id: gen.id },
        hint: 'Call again later; a shorter range finishes sooner',
      });
    }
    const minutes = Math.floor((Date.now() - started) / 60_000);
    req.progress(
      0.25 + 0.6 * (1 - 1 / (1 + (Date.now() - started) / 120_000)),
      `sync. labs: ${gen.status.toLowerCase()}${minutes ? ` (${minutes} min)` : ''}`,
    );
    gen = await api<Generation>(`/v2/generate/${encodeURIComponent(gen.id)}?wait=true&timeout=10`, {
      method: 'GET',
    });
    if (gen.status !== 'COMPLETED' && gen.status !== 'FAILED' && gen.status !== 'REJECTED')
      await pause(2000, req.signal);
  }
  if (!gen.outputUrl) {
    throw new CfError('engine_error', `sync. labs finished ${gen.id} without an output`, {
      detail: { provider: 'sync', generation_id: gen.id },
      hint: 'Call again',
    });
  }
  req.progress(0.9, 'downloading the result');
  await download(gen.outputUrl, req.dest, {
    maxBytes: req.maxBytes,
    timeoutMs: 30 * 60_000,
    signal: req.signal,
    allowPrivate: req.allowPrivate,
  });
  return { id: gen.id, ...(gen.outputDuration ? { duration: gen.outputDuration } : {}) };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CfError('cancelled', 'Cancelled'));
    const t = setTimeout(resolve, ms);
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
