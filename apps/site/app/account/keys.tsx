'use client';

import { useState } from 'react';
import type { ScriptKey } from '../lib/keys.ts';

// Keys for scripts that call the server without a browser sign-in. A new key shows once; after
// that only its first characters do.

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function KeysPanel({ initial, server }: { initial: ScriptKey[]; server: string }) {
  const [keys, setKeys] = useState(initial);
  const [label, setLabel] = useState('');
  const [made, setMade] = useState<string | undefined>();
  const [note, setNote] = useState('');

  const refresh = async () => {
    const res = await fetch('/api/keys', { cache: 'no-store' }).catch(() => undefined);
    if (res?.ok) setKeys(((await res.json()) as { keys: ScriptKey[] }).keys);
  };

  async function change(body: { label: string } | { revoke: string }) {
    setNote('');
    const res = await fetch('/api/keys', {
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
          aria-label="What the key is for"
          placeholder="What it’s for, e.g. nightly export"
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="buy quiet">
          Make a key
        </button>
      </form>
      {made ? (
        <p className="meter-note">
          Your new key, shown only now: <code>{made}</code>. A script sends it as{' '}
          <code>Authorization: Bearer {made.slice(0, 7)}…</code> to <code>{server}/mcp</code>.
        </p>
      ) : null}
      {note ? <p className="meter-note">{note}</p> : null}
      {keys.length ? (
        <ul className="file-list">
          {keys.map((k) => (
            <li key={k.key_id}>
              <span className="file-name">
                {k.label} <code>{k.starts}…</code>
              </span>
              <span className="file-note">
                made {day(k.created_at)} · works until {day(k.expires_at)} ·{' '}
                <button
                  type="button"
                  className="link"
                  onClick={() => void change({ revoke: k.key_id })}
                >
                  Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
