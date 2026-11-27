'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Credits plus or minus on one account, with a reason. Each form carries an id of its own, made
// once, so a double click or a resend after a timeout counts once; a new id comes after each one
// that went through.

const newId = () => `site-${crypto.randomUUID()}`;

export function AdjustForm({ account, balance }: { account: string; balance: number | null }) {
  const router = useRouter();
  const [id, setId] = useState(newId);
  const [credits, setCredits] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | undefined>();

  async function submit() {
    const amount = Number(credits);
    if (!Number.isFinite(amount) || amount === 0) {
      setNote({ ok: false, text: 'Credits must be a number other than 0 (negative takes away)' });
      return;
    }
    if (!reason.trim()) {
      setNote({ ok: false, text: 'Say why: the reason stays on the entry' });
      return;
    }
    setBusy(true);
    setNote(undefined);
    const res = await fetch('/api/admin/adjust', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, id, credits: amount, reason: reason.trim() }),
    }).catch(() => undefined);
    const answer = (await res?.json().catch(() => ({}))) as {
      balance?: number;
      duplicate?: boolean;
      error?: string;
    };
    setBusy(false);
    if (!res?.ok) {
      setNote({ ok: false, text: answer.error ?? 'That did not go through; try again' });
      return;
    }
    setNote({
      ok: true,
      text: `${answer.duplicate ? 'Already done' : amount > 0 ? 'Added' : 'Taken away'}: the balance is now ${answer.balance}`,
    });
    setId(newId());
    setCredits('');
    setReason('');
    router.refresh();
  }

  return (
    <form
      className="adm-adjust"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>Credits</span>
        <input
          inputMode="decimal"
          placeholder="e.g. 10 or -5"
          value={credits}
          onChange={(e) => setCredits(e.target.value)}
          required
        />
      </label>
      <label className="grow">
        <span>Reason</span>
        <input
          placeholder="e.g. export failed twice, support ticket 42"
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </label>
      <button type="submit" className="buy" disabled={busy}>
        {busy ? 'Saving…' : 'Adjust'}
      </button>
      <p className="adm-note">
        {note ? (
          <span className={note.ok ? 'ok' : 'bad'}>{note.text}</span>
        ) : (
          <>
            Balance now {balance ?? 'not opened'}. Positive adds, negative takes away (never below
            zero). It is written with your account and the reason, and can't be undone except by
            another adjustment.
          </>
        )}
      </p>
    </form>
  );
}
