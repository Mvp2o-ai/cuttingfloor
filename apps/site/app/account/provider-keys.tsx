'use client';

import { useState } from 'react';
import type { SavedKey } from '../lib/provider-keys.ts';

// The user's own sync. labs key, for lip sync. Pasted once; after that only its last four
// characters show.

export function ProviderKeysPanel({ initial }: { initial: SavedKey[] }) {
  const [keys, setKeys] = useState(initial);
  const [key, setKey] = useState('');
  const [note, setNote] = useState('');
  const sync = keys.find((k) => k.provider === 'sync');

  async function change(
    body: { provider: string; key: string } | { provider: string; remove: true },
  ) {
    setNote('');
    const res = await fetch('/api/provider-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    const answer = (await res?.json().catch(() => ({}))) as { error?: string };
    if (!res?.ok) setNote(answer.error ?? 'That did not work; try again');
    else setKey('');
    const list = await fetch('/api/provider-keys', { cache: 'no-store' }).catch(() => undefined);
    if (list?.ok) setKeys(((await list.json()) as { keys: SavedKey[] }).keys);
  }

  return (
    <div className="files">
      <form
        className="key-make"
        onSubmit={(e) => {
          e.preventDefault();
          void change({ provider: 'sync', key });
        }}
      >
        <input
          aria-label="Your sync. labs API key"
          placeholder={
            sync
              ? `Saved: ends in ${sync.ends}. Paste a new one to replace it`
              : 'Paste your sync. labs API key'
          }
          value={key}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
        />
        <button type="submit" className="buy quiet" disabled={!key.trim()}>
          Save key
        </button>
      </form>
      {sync ? (
        <p className="meter-note">
          Lip sync uses your key ending in <code>{sync.ends}</code>, and sync. labs bills it.{' '}
          <button
            type="button"
            className="link"
            onClick={() => void change({ provider: 'sync', remove: true })}
          >
            Remove it
          </button>
        </p>
      ) : null}
      {note ? <p className="meter-note">{note}</p> : null}
    </div>
  );
}
