import { lookup as dnsLookup } from 'node:dns';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { CfError } from '@cuttingfloor/schema';

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Tests only: allow loopback and private addresses. */
  allowPrivate?: boolean;
  onProgress?: (bytes: number, total: number | null) => void;
}

const MAX_REDIRECTS = 5;

/**
 * The address a share link serves the file itself at. Dropbox and Google Drive share links open
 * a web page about the file; the same file downloads with Dropbox's dl=1 and from Drive's
 * download host. Anything else is returned as it is.
 */
export function directDownloadUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.toLowerCase();
  if (host === 'dropbox.com' || host === 'www.dropbox.com') {
    u.searchParams.delete('raw');
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  if (host === 'drive.google.com') {
    const id =
      /^\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] ??
      (/^\/(open|uc)$/.test(u.pathname) ? u.searchParams.get('id') : null);
    if (id) {
      return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
    }
  }
  return url;
}

/**
 * Downloads a URL to `dest` with SSRF protection: http(s) only; private, loopback, link-local,
 * multicast and metadata addresses refused; the checked address is the one connected to (DNS is
 * pinned per request); every redirect is re-checked; size and time are capped.
 */
export async function download(
  url: string,
  dest: string,
  options: DownloadOptions,
): Promise<{ bytes: number; filename: string | null }> {
  await mkdir(dirname(dest), { recursive: true });
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new CfError(
        'bad_request',
        `Only http and https URLs can be imported (got ${current.protocol})`,
      );
    }
    if (current.username || current.password)
      throw new CfError('bad_request', 'URLs with credentials are not allowed');
    const response = await request(current, options);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      current = new URL(response.headers.location, current);
      continue;
    }
    if (status !== 200) {
      response.resume();
      throw new CfError('bad_request', `Download failed: HTTP ${status}`);
    }
    const total = Number(response.headers['content-length'] ?? Number.NaN);
    if (total > options.maxBytes) {
      response.destroy();
      throw new CfError(
        'limit_exceeded',
        `The file is larger than the ${options.maxBytes} byte import limit`,
      );
    }
    let bytes = 0;
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        response.destroy(
          new CfError(
            'limit_exceeded',
            `The file is larger than the ${options.maxBytes} byte import limit`,
          ),
        );
      }
      options.onProgress?.(bytes, Number.isFinite(total) ? total : null);
    });
    try {
      await pipeline(response, createWriteStream(dest, { mode: 0o600 }));
    } catch (error) {
      await rm(dest, { force: true });
      if (error instanceof CfError) throw error;
      if (options.signal?.aborted) throw new CfError('cancelled', 'Cancelled');
      throw new CfError('bad_request', `Download failed: ${(error as Error).message}`);
    }
    const disposition = /filename="?([^";]+)"?/i.exec(
      String(response.headers['content-disposition'] ?? ''),
    );
    const fromPath = decodeURIComponent(current.pathname.split('/').pop() ?? '');
    return { bytes, filename: disposition?.[1] ?? (fromPath || null) };
  }
  throw new CfError('bad_request', `More than ${MAX_REDIRECTS} redirects`);
}

function request(url: URL, options: DownloadOptions): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (hostname, opts, callback) => {
      dnsLookup(hostname, { ...opts, all: true }, (error, addresses) => {
        if (error) return callback(error, '', 0);
        const list = addresses as Array<{ address: string; family: number }>;
        const bad = list.find((a) => !options.allowPrivate && isBlockedAddress(a.address));
        if (bad || !list.length) {
          return callback(
            new CfError(
              'path_not_allowed',
              `Refusing to fetch from ${hostname}: private or reserved address`,
            ),
            '',
            0,
          );
        }
        if ((opts as { all?: boolean }).all)
          return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
        const first = list[0] as { address: string; family: number };
        callback(null, first.address, first.family);
      });
    };
    if (
      isIP(url.hostname.replace(/^\[|\]$/g, '')) &&
      !options.allowPrivate &&
      isBlockedAddress(url.hostname.replace(/^\[|\]$/g, ''))
    ) {
      reject(
        new CfError(
          'path_not_allowed',
          `Refusing to fetch from ${url.hostname}: private or reserved address`,
        ),
      );
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(
      url,
      { lookup, timeout: options.timeoutMs, headers: { 'user-agent': 'cuttingfloor' } },
      resolve,
    );
    req.on('timeout', () => req.destroy(new CfError('bad_request', 'Download timed out')));
    req.on('error', (error) =>
      reject(
        error instanceof CfError
          ? error
          : new CfError('bad_request', `Download failed: ${error.message}`),
      ),
    );
    options.signal?.addEventListener(
      'abort',
      () => req.destroy(new CfError('cancelled', 'Cancelled')),
      { once: true },
    );
  });
}

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isBlockedAddress(address: string): boolean {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4mapped?.[1]) return isBlockedAddress(v4mapped[1]);
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = address.toLowerCase();
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb') ||
    v6.startsWith('ff') ||
    v6.startsWith('64:ff9b') ||
    v6.startsWith('2001:db8')
  );
}
