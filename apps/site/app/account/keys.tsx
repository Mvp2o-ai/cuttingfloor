'use client';

import { useState } from 'react';
import type { KeyKind, ScriptKey } from '../lib/keys.ts';
import { Copy } from '../walkthroughs/copy.tsx';

// Keys for scripts that call the server without a browser sign-in. A new key shows once; after
// that only its first characters do.

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function KeysPanel({ initial, kind = 'script' }: { initial: ScriptKey[]; kind?: KeyKind }) {
  const api = kind === 'admin' ? '/api/admin-keys' : '/api/keys';
  const [keys, setKeys] = useState(initial);
  const [label, setLabel] = useState('');
  const [made, setMade] = useState<string | undefined>();
  const [note, setNote] = useState('');

  const refresh = async () => {
    const res = await fetch(api, { cache: 'no-store' }).catch(() => undefined);
    if (res?.ok) setKeys(((await res.json()) as { keys: ScriptKey[] }).keys);
  };

  async function change(body: { label: string } | { revoke: string }) {
    setNote('');
    const res = await fetch(api, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    const answer = (await res?.json().catch(() => ({}))) as { key?: string; error?: string };
    if (!res?.ok) setNote(answer.error ?? 'That did not work; try again');
    else if (answer.key) {
      setMade(answer.key);
      setLabel('');
    }
    await refresh();
  }

  return (
    <div className="files">
      <form
        className="key-make"
        onSubmit={(e) => {
          e.preventDefault();
          void change({ label });
        }}
      >
        <input
          aria-label="Key name"
          placeholder={kind === 'admin' ? 'Key name, e.g. CRM' : 'Key name, e.g. nightly export'}
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="buy quiet">
          Make a key
        </button>
      </form>
      {made ? (
        <div className="key-made">
          <p>Copy your new key now. It won’t be shown again.</p>
          <div className="key-value">
            <code>{made}</code>
            <Copy text={made} label="Copy" />
          </div>
          <button type="button" className="link" onClick={() => setMade(undefined)}>
            Done
          </button>
        </div>
      ) : null}
      {note ? <p className="meter-note">{note}</p> : null}
      {keys.length ? (
        <ul className="file-list">
          {keys.map((k) => (
            <li key={k.key_id} className="key-row">
              <span className="key-name">{k.label}</span>
              <code className="key-start">{k.starts}…</code>
              <span className="file-note">
                Made {day(k.created_at)} · expires {day(k.expires_at)}
              </span>
              <button
                type="button"
                className="link"
                onClick={() => void change({ revoke: k.key_id })}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
