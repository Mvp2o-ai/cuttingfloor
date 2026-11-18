'use client';

import { track } from '@vercel/analytics';
import { useEffect, useRef, useState } from 'react';
import type { Files, Started } from '../lib/files.ts';

// Drop or pick files for the agent to use (on a phone, tap to pick from the gallery or files). Each file goes up in parts straight to the
// server's signed URL and resumes after a dropped connection; the agent then finds it by name.
// Phones freeze a page in the background (the user switches back to their chat app), so the
// screen is kept awake while sending, a part cut off in the background is sent again when the
// page comes back, and an upload that stopped (the page was closed) carries on from what the
// server has once the user picks the same file again.
// Each upload is counted (Upload started, Upload, Upload failed) with its kind of file, never
// its name.

const PART = 16 * 1024 * 1024;

type Sending = {
  key: string;
  name: string;
  size: number;
  sent: number;
  note: string;
  state: 'sending' | 'done' | 'failed';
  /** Kept to carry on after a failure without picking the file again. */
  file: File;
  upload_id?: string;
  /** The server refused the file (too big, no room, link gone): sending again won't help. */
  refused?: boolean;
};

const size = (n: number) =>
  n === 0
    ? '0 KB'
    : n >= 1e9
      ? `${(n / 1e9).toFixed(1)} GB`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)} MB`
        : `${Math.max(1, Math.round(n / 1e3))} KB`;

/** The kind of file, for counting uploads: video, audio, image or other. */
const kind = (file: File) => /^(video|audio|image)\//.exec(file.type)?.[1] ?? 'other';

const day = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

class Final extends Error {}

type WakeLock = { release: () => Promise<void> };
const wakeLock = () =>
  (
    navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLock> } }
  ).wakeLock
    ?.request('screen')
    .catch(() => undefined);

export function FilesPanel({ initial }: { initial: Files }) {
  const [files, setFiles] = useState(initial);
  const [sending, setSending] = useState<Sending[]>([]);
  const [over, setOver] = useState(false);
  const [picking, setPicking] = useState<{ upload_id: string; note: string } | null>(null);
  const queue = useRef(Promise.resolve());
  const pick = useRef<HTMLInputElement>(null);
  // Parts in flight, cut off when the page comes back from the background so they go again.
  const inFlight = useRef(new Set<AbortController>());
  const active = useRef(0);
  const lock = useRef<WakeLock | undefined>(undefined);

  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      if (active.current) void wakeLock()?.then((l) => (lock.current = l));
      if (hiddenAt && Date.now() - hiddenAt > 3000) for (const c of inFlight.current) c.abort();
      hiddenAt = 0;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const update = (key: string, change: Partial<Sending>) =>
    setSending((all) => all.map((s) => (s.key === key ? { ...s, ...change } : s)));

  const refresh = async () => {
    const res = await fetch('/api/uploads', { cache: 'no-store' }).catch(() => undefined);
    if (res?.ok) setFiles((await res.json()) as Files);
  };

  async function send(file: File, key: string, resume?: string) {
    track(resume ? 'Upload resumed' : 'Upload started', { kind: kind(file) });
    if (active.current++ === 0) lock.current = await wakeLock();
    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          resume ? { upload_id: resume } : { name: file.name, bytes: file.size },
        ),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Started> & {
        error?: string;
        hint?: string;
      };
      if (!res.ok || !body.url)
        throw new Final([body.error, body.hint].filter(Boolean).join('. ') || `HTTP ${res.status}`);
      const url = body.url;
      update(key, { upload_id: body.upload_id });
      const offset = async () => {
        const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (!r.ok) throw new Final('The upload link stopped working. Drop the file again.');
        return {
          at: Number(r.headers.get('upload-offset') || 0),
          complete: r.headers.get('upload-complete') === 'true',
        };
      };
      let { at, complete } = resume ? await offset() : { at: 0, complete: false };
      for (let tries = 0; !complete; ) {
        const end = Math.min(at + PART, file.size);
        update(key, { sent: at, note: '' });
        const cut = new AbortController();
        inFlight.current.add(cut);
        try {
          const r = await fetch(url, {
            method: 'PUT',
            headers: { 'content-range': `bytes ${at}-${end - 1}/${file.size}` },
            body: file.slice(at, end),
            signal: cut.signal,
          });
          const reply = (await r.json().catch(() => ({}))) as { error?: string };
          if (r.status === 413 || r.status === 403 || r.status === 404)
            throw new Final(reply.error || 'The server refused the file.');
          if (!r.ok && r.status !== 409) throw new Error(reply.error || `HTTP ${r.status}`);
          at = Number(r.headers.get('upload-offset') || end);
          complete = r.headers.get('upload-complete') === 'true';
          tries = 0;
        } catch (error) {
          // A part cut off because the page came back from the background is not a failure.
          if (error instanceof Final || (!cut.signal.aborted && ++tries > 5)) throw error;
          update(key, { note: 'Connection dropped; picking up where it stopped…' });
          if (!cut.signal.aborted) await new Promise((r) => setTimeout(r, 1000 * tries));
          ({ at, complete } = await offset());
        } finally {
          inFlight.current.delete(cut);
        }
      }
      update(key, { sent: file.size, state: 'done', note: '' });
      track('Upload', { kind: kind(file), mb: Math.round(file.size / 1e6) });
    } catch (error) {
      update(key, {
        state: 'failed',
        note: (error as Error).message || String(error),
        refused: error instanceof Final,
      });
      track('Upload failed', { kind: kind(file) });
    } finally {
      if (--active.current === 0) {
        void lock.current?.release().catch(() => undefined);
        lock.current = undefined;
      }
      await refresh();
    }
  }

  // One file at a time, so each goes up as fast as the connection allows.
  const enqueue = (file: File, key: string, resume?: string) => {
    queue.current = queue.current.then(() => send(file, key, resume));
  };

  const add = (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setSending((all) => [
        {
          key,
          name: file.name,
          size: file.size,
          sent: 0,
          note: 'Waiting…',
          state: 'sending',
          file,
        },
        ...all,
      ]);
      enqueue(file, key);
    }
  };

  /** Carries on a failed send in this page, with the file it still holds. */
  const retry = (s: Sending) => {
    update(s.key, { state: 'sending', note: 'Waiting…' });
    enqueue(s.file, s.key, s.upload_id);
  };

  /** The file picked for an upload that stopped: carries on if it is the same file. */
  const resumeWith = (file: File | undefined) => {
    const upload = files.uploads.find((u) => u.upload_id === picking?.upload_id);
    if (!file || !upload) return setPicking(null);
    if (upload.bytes !== null && file.size !== upload.bytes) {
      return setPicking({
        upload_id: upload.upload_id,
        note: `That file is ${size(file.size)}; pick ${upload.name} (${size(upload.bytes)}).`,
      });
    }
    setPicking(null);
    const key = `${upload.upload_id}-${Math.random()}`;
    setSending((all) => [
      {
        key,
        name: upload.name,
        size: file.size,
        sent: upload.received_bytes,
        note: 'Waiting…',
        state: 'sending',
        file,
        upload_id: upload.upload_id,
      },
      ...all,
    ]);
    enqueue(file, key, upload.upload_id);
  };

  const { used_bytes, max_bytes } = files.storage;
  const share = max_bytes ? Math.min(1, used_bytes / max_bytes) : 0;
  const waiting = files.uploads.filter((u) => u.complete);
  // Uploads the server holds part of that this page is not sending now.
  const here = new Set(sending.map((s) => s.upload_id));
  const stopped = files.uploads.filter((u) => !u.complete && !here.has(u.upload_id));
  const busy = sending.some((s) => s.state === 'sending');

  return (
    <div className="files">
      <label
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
      >
        {/* A phone has no files to drag: the whole box is one big button to the gallery or files. */}
        <strong className="on-computer">Drop videos, audio or images here</strong>
        <span className="on-computer">or click to choose files from this computer</span>
        <strong className="on-phone">Tap to choose videos, audio or photos</strong>
        <span className="on-phone">From your gallery or files. You can pick more than one.</span>
        <input
          type="file"
          multiple
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
      </label>

      {busy ? (
        <p className="meter-note files-keep">
          Keep this page open until it is sent. If you switch apps, come back and it carries on.
        </p>
      ) : null}

      {sending.length ? (
        <ul className="file-list">
          {sending.map((s) => (
            <li key={s.key} className={s.state}>
              <span className="file-name">{s.name}</span>
              <span className="file-note">
                {s.state === 'done'
                  ? `Sent. Ask your agent to use ${s.name}.`
                  : s.state === 'failed'
                    ? s.note
                    : s.note || `${size(s.sent)} of ${size(s.size)}`}
              </span>
              {s.state === 'failed' && s.upload_id && !s.refused ? (
                <button type="button" className="link file-resume" onClick={() => retry(s)}>
                  Resume
                </button>
              ) : null}
              {s.state === 'sending' ? (
                <div className="meter-bar" aria-hidden="true">
                  <span style={{ width: `${(100 * s.sent) / Math.max(1, s.size)}%` }} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {stopped.length ? (
        <>
          <p className="files-head">Stopped part way</p>
          <ul className="file-list">
            {stopped.map((u) => (
              <li key={u.upload_id}>
                <span className="file-name">{u.name}</span>
                <span className="file-note">
                  {picking?.upload_id === u.upload_id && picking.note
                    ? picking.note
                    : `${size(u.received_bytes)}${u.bytes ? ` of ${size(u.bytes)}` : ''} sent · pick the same file to send the rest`}
                </span>
                <button
                  type="button"
                  className="link file-resume"
                  onClick={() => {
                    setPicking({ upload_id: u.upload_id, note: '' });
                    pick.current?.click();
                  }}
                >
                  Resume
                </button>
              </li>
            ))}
          </ul>
          <input
            ref={pick}
            type="file"
            hidden
            onChange={(e) => {
              resumeWith(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </>
      ) : null}

      {waiting.length ? (
        <>
          <p className="files-head">Waiting for your agent</p>
          <ul className="file-list">
            {waiting.map((u) => (
              <li key={u.upload_id}>
                <span className="file-name">{u.name}</span>
                <span className="file-note">
                  {size(u.received_bytes)} · kept until {day(u.expires_at)} unless your agent uses
                  it
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {files.media.length ? (
        <>
          <p className="files-head">With your agent</p>
          <ul className="file-list">
            {files.media.slice(0, 12).map((m) => (
              <li key={m.media_id}>
                <span className="file-name">{m.name}</span>
                <span className="file-note">
                  {m.bytes ? `${size(m.bytes)} · ` : ''}kept until {day(m.expires_at)}
                </span>
              </li>
            ))}
          </ul>
          {files.media_count > 12 ? (
            <p className="meter-note">And {files.media_count - 12} more.</p>
          ) : null}
        </>
      ) : null}

      <div className="meter">
        <p className="meter-line">
          <span>
            <strong>{size(used_bytes)}</strong>
            {max_bytes === null ? ' stored' : ` of ${size(max_bytes)} storage used`}
          </span>
          <span className="meter-renews">Files clear on their own after 7 days unused</span>
        </p>
        {max_bytes === null ? null : (
          <div
            className={`meter-bar${share >= 1 ? ' full' : share >= 0.8 ? ' high' : ''}`}
            aria-hidden="true"
          >
            <span style={{ width: `${share * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
