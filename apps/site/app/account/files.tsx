'use client';

import { useRef, useState } from 'react';
import type { Files, Started } from '../lib/files.ts';

// Drop files from this computer for the agent to use. Each file goes up in parts straight to the
// server's signed URL and resumes after a dropped connection; the agent then finds it by name.

const PART = 16 * 1024 * 1024;

type Sending = {
  key: string;
  name: string;
  size: number;
  sent: number;
  note: string;
  state: 'sending' | 'done' | 'failed';
};

const size = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1e3))} KB`;

const day = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

class Final extends Error {}

export function FilesPanel({ initial }: { initial: Files }) {
  const [files, setFiles] = useState(initial);
  const [sending, setSending] = useState<Sending[]>([]);
  const [over, setOver] = useState(false);
  const queue = useRef(Promise.resolve());

  const update = (key: string, change: Partial<Sending>) =>
    setSending((all) => all.map((s) => (s.key === key ? { ...s, ...change } : s)));

  const refresh = async () => {
    const res = await fetch('/api/uploads', { cache: 'no-store' }).catch(() => undefined);
    if (res?.ok) setFiles((await res.json()) as Files);
  };

  async function send(file: File, key: string) {
    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, bytes: file.size }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Started> & {
        error?: string;
        hint?: string;
      };
      if (!res.ok || !body.url)
        throw new Final([body.error, body.hint].filter(Boolean).join('. ') || `HTTP ${res.status}`);
      const url = body.url;
      const offset = async () => {
        const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (!r.ok) throw new Final('The upload link stopped working. Drop the file again.');
        return {
          at: Number(r.headers.get('upload-offset') || 0),
          complete: r.headers.get('upload-complete') === 'true',
        };
      };
      let at = 0;
      let complete = false;
      for (let tries = 0; !complete; ) {
        const end = Math.min(at + PART, file.size);
        update(key, { sent: at, note: '' });
        try {
          const r = await fetch(url, {
            method: 'PUT',
            headers: { 'content-range': `bytes ${at}-${end - 1}/${file.size}` },
            body: file.slice(at, end),
          });
          const reply = (await r.json().catch(() => ({}))) as { error?: string };
          if (r.status === 413 || r.status === 403 || r.status === 404)
            throw new Final(reply.error || 'The server refused the file.');
          if (!r.ok && r.status !== 409) throw new Error(reply.error || `HTTP ${r.status}`);
          at = Number(r.headers.get('upload-offset') || end);
          complete = r.headers.get('upload-complete') === 'true';
          tries = 0;
        } catch (error) {
          if (error instanceof Final || ++tries > 5) throw error;
          update(key, { note: 'Connection dropped; picking up where it stopped…' });
          await new Promise((r) => setTimeout(r, 1000 * tries));
          ({ at, complete } = await offset());
        }
      }
      update(key, { sent: file.size, state: 'done', note: '' });
      await refresh();
    } catch (error) {
      update(key, { state: 'failed', note: (error as Error).message || String(error) });
    }
  }

  const add = (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setSending((all) => [
        { key, name: file.name, size: file.size, sent: 0, note: 'Waiting…', state: 'sending' },
        ...all,
      ]);
      // One file at a time, so each goes up as fast as the connection allows.
      queue.current = queue.current.then(() => send(file, key));
    }
  };

  const { used_bytes, max_bytes } = files.storage;
  const share = max_bytes ? Math.min(1, used_bytes / max_bytes) : 0;
  const waiting = files.uploads.filter((u) => u.complete);

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
        <strong>Drop videos, audio or images here</strong>
        <span>or click to choose files from this computer</span>
        <input
          type="file"
          multiple
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
      </label>

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
              {s.state === 'sending' ? (
                <div className="meter-bar" aria-hidden="true">
                  <span style={{ width: `${(100 * s.sent) / Math.max(1, s.size)}%` }} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
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
