'use client';

import { track } from '@vercel/analytics';
import { useId, useState } from 'react';
import { SHARE_CATEGORIES, type Sound } from '../lib/sounds.ts';

// "Share as a community sound" under one of the user's audio files: off until they turn it on, then
// the details a shared sound carries (name, what it is, category, tags, who it is credited to).
// The server measures and indexes it, and it is a community sound when this answers.

/** Audio files community sounds take, by name. */
export const SHAREABLE = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;

export function ShareSound({
  from,
  fileName,
  onShared,
  startOn = false,
}: {
  from: { upload_id: string } | { media_id: string };
  fileName: string;
  onShared?: (sound: Sound) => void;
  /** Already on: the person came to share this file. */
  startOn?: boolean;
}) {
  const id = useId();
  const [on, setOn] = useState(startOn);
  const [name, setName] = useState(
    fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .slice(0, 80),
  );
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [author, setAuthor] = useState('');
  const [state, setState] = useState<{ busy?: boolean; note?: string; shared?: Sound }>({});

  if (state.shared) {
    return (
      <p className="share-sound-done">
        Shared as a community sound: “{state.shared.name}”. Thank you.{' '}
        <a href={`/community-sounds?sound=${encodeURIComponent(state.shared.sound_id)}`}>See it</a>
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !description.trim() || !category.trim()) {
      return setState({ note: 'Give it a name, say what it is and pick a category.' });
    }
    setState({ busy: true, note: 'Sharing…' });
    const res = await fetch('/api/sounds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...from,
        name: name.trim(),
        description: description.trim(),
        category: category.trim(),
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 10),
        ...(author.trim() ? { author: author.trim() } : {}),
      }),
    }).catch(() => undefined);
    const body = (await res?.json().catch(() => ({}))) as {
      sound?: Sound;
      error?: string;
      hint?: string;
    };
    if (!res?.ok || !body.sound) {
      return setState({
        note:
          [body?.error, body?.hint].filter(Boolean).join('. ') ||
          'It did not go through; try again',
      });
    }
    track('Sound shared', { category: body.sound.category });
    setState({ shared: body.sound });
    onShared?.(body.sound);
  }

  return (
    <form className="share-sound" onSubmit={submit} noValidate>
      <label className="share-switch">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <i aria-hidden="true" />
        <span>
          Share as a community sound
          <small>
            A small way to give back: other creators can find it and use it in their edits.
          </small>
        </span>
      </label>
      {on ? (
        <div className="share-fields">
          <label>
            Name
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            What it is
            <textarea
              value={description}
              maxLength={500}
              placeholder="The hook from my track, a bass drop at 0:04"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="share-row">
            <label>
              Category
              <input
                value={category}
                maxLength={60}
                list={`${id}-cats`}
                placeholder="Music"
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
            <label>
              Tags
              <input
                value={tags}
                maxLength={200}
                placeholder="hype, drop, edm"
                onChange={(e) => setTags(e.target.value)}
              />
            </label>
          </div>
          <label>
            Credit as
            <input
              value={author}
              maxLength={60}
              placeholder="Your first name"
              onChange={(e) => setAuthor(e.target.value)}
            />
          </label>
          <datalist id={`${id}-cats`}>
            {SHARE_CATEGORIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <p className="share-fine">
            Share only sounds that are yours to share. You can take it down any time, and sounds
            people report are taken down.
          </p>
          <button type="submit" className="buy" disabled={state.busy}>
            Share
          </button>
          {state.note ? <p className="share-fine">{state.note}</p> : null}
        </div>
      ) : null}
    </form>
  );
}
