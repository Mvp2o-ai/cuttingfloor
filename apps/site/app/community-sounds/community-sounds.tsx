'use client';

import { track } from '@vercel/analytics';
import { useEffect, useRef, useState } from 'react';
import { Final, sendFile } from '../account/send-file.ts';
import { SHAREABLE, ShareSound } from '../account/share-sound.tsx';
import type { Started } from '../lib/files.ts';
import { COMMUNITY_PACK, type Sound, type SoundPage } from '../lib/sounds.ts';

// Community sounds to play, by popular (most used in edits this week) or newest, or
// searched by words and by how they sound; a sound named in the address (?sound=) comes first.
// Signed in, a person shares a new sound (it goes up like any upload, then the share details)
// and sees and takes down their own. Anyone reports a sound that shouldn't be here.

type Order = 'popular' | 'newest';

const seconds = (s: number) =>
  s < 60
    ? `${s.toFixed(s < 10 ? 1 : 0)} s`
    : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function CommunitySounds({ first, base }: { first: SoundPage | null; base: string }) {
  // Known once /api/sounds answers: the person's own sounds, or 401 when signed out.
  const [signedIn, setSignedIn] = useState(false);
  const [order, setOrder] = useState<Order>('popular');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<SoundPage | null>(first);
  const [busy, setBusy] = useState(false);
  const [named, setNamed] = useState<Sound | null>(null);
  const [mine, setMine] = useState<Sound[] | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const firstLoad = useRef(true);

  const load = async (o: Order, q: string, offset = 0) => {
    const params = new URLSearchParams({
      pack: COMMUNITY_PACK,
      limit: '30',
      offset: String(offset),
    });
    if (q) params.set('query', q);
    else params.set('order', o);
    setBusy(true);
    const res = await fetch(`${base}/sounds?${params}`).catch(() => undefined);
    setBusy(false);
    if (!res?.ok) return;
    const next = (await res.json()) as SoundPage;
    setPage((was) => (offset && was ? { ...next, sounds: [...was.sounds, ...next.sounds] } : next));
  };

  // A new order or search (typed, then a pause) loads again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load reads only what is listed
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    const t = setTimeout(() => void load(order, query.trim()), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [order, query]);

  // The sound the address names, and the person's own sounds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('sound');
    if (id) {
      fetch(`${base}/sounds?${new URLSearchParams({ sound_ids: id })}`)
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (d: SoundPage | null) => setNamed(d?.sounds[0] ?? null),
          () => undefined,
        );
    }
    void refreshMine();
  }, []);

  async function refreshMine() {
    const res = await fetch('/api/sounds', { cache: 'no-store' }).catch(() => undefined);
    setSignedIn(Boolean(res?.ok));
    if (res?.ok) setMine(((await res.json()) as { sounds: Sound[] }).sounds);
  }

  function play(sound: Sound) {
    const el = audio.current;
    if (!el) return;
    if (playing === sound.sound_id) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = sound.url;
    void el.play().then(
      () => setPlaying(sound.sound_id),
      () => setPlaying(null),
    );
    track('Sound played', { pack: sound.pack });
  }

  async function remove(sound: Sound) {
    const res = await fetch('/api/sounds', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remove: sound.sound_id }),
    }).catch(() => undefined);
    if (res?.ok) {
      setMine((all) => all?.filter((s) => s.sound_id !== sound.sound_id) ?? null);
      setPage((p) =>
        p ? { ...p, sounds: p.sounds.filter((s) => s.sound_id !== sound.sound_id) } : p,
      );
    }
  }

  const row = (s: Sound, own = false) => (
    <SoundRow
      key={`${own ? 'mine' : 'all'}-${s.sound_id}`}
      sound={s}
      playing={playing === s.sound_id}
      onPlay={() => play(s)}
      {...(own ? { onRemove: () => void remove(s) } : { base })}
    />
  );

  return (
    <div className="csound-body">
      {/* biome-ignore lint/a11y/useMediaCaption: sound effects have no words to caption */}
      <audio ref={audio} onEnded={() => setPlaying(null)} preload="none" />

      <ShareNew signedIn={signedIn} onShared={() => void refreshMine()} />

      {named ? (
        <>
          <p className="files-head">The sound you followed</p>
          <ul className="sound-list">{row(named)}</ul>
        </>
      ) : null}

      <div className="csound-bar">
        <input
          type="search"
          className="csound-search"
          placeholder="Search: “bass drop”, “crowd cheer”, “sad violin”…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the sounds"
        />
        <div className="csound-order" role="tablist">
          {(['popular', 'newest'] as const).map((o) => (
            <button
              key={o}
              type="button"
              role="tab"
              aria-selected={!query && order === o}
              className={!query && order === o ? 'on' : ''}
              onClick={() => {
                setQuery('');
                setOrder(o);
              }}
            >
              {o === 'popular' ? 'Popular' : 'Newest'}
            </button>
          ))}
        </div>
      </div>

      {page === null ? (
        <p className="lede">The sounds can't be listed just now. Try again in a minute.</p>
      ) : page.sounds.length ? (
        <ul className="sound-list">{page.sounds.map((s) => row(s))}</ul>
      ) : (
        <p className="lede">
          {query ? 'No sound matches that yet.' : 'No sounds shared yet. Be the first.'}
        </p>
      )}
      {page?.next_offset ? (
        <button
          type="button"
          className="buy quiet csound-more"
          disabled={busy}
          onClick={() => void load(order, query.trim(), page.next_offset ?? 0)}
        >
          More sounds
        </button>
      ) : null}

      {mine?.length ? (
        <>
          <p className="files-head">Your shared sounds</p>
          <ul className="sound-list">{mine.map((s) => row(s, true))}</ul>
        </>
      ) : null}
    </div>
  );
}

function SoundRow({
  sound,
  playing,
  onPlay,
  onRemove,
  base,
}: {
  sound: Sound;
  playing: boolean;
  onPlay: () => void;
  onRemove?: () => void;
  base?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [reporting, setReporting] = useState<'closed' | 'open' | 'sent'>('closed');
  const [reason, setReason] = useState('');
  const ask = `Add the sound “${sound.name}” from cuttingfloor's community sounds (sound_id ${sound.sound_id}) to my video.`;

  async function report(e: React.FormEvent) {
    e.preventDefault();
    if (!base || !reason.trim()) return;
    const res = await fetch(`${base}/sounds/${encodeURIComponent(sound.sound_id)}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() }),
    }).catch(() => undefined);
    if (res?.ok) setReporting('sent');
  }

  return (
    <li className="sound">
      <button
        type="button"
        className={`sound-play${playing ? ' on' : ''}`}
        onClick={onPlay}
        aria-label={playing ? `Stop ${sound.name}` : `Play ${sound.name}`}
      >
        {playing ? '■' : '▶'}
      </button>
      <div className="sound-main">
        <span className="sound-name">{sound.name}</span>
        <span className="sound-meta">
          {sound.author ? `by ${sound.author} · ` : ''}
          {sound.category} · {seconds(sound.seconds)}
          {sound.uses
            ? ` · used in ${sound.uses} edit${sound.uses === 1 ? '' : 's'} this week`
            : ''}
        </span>
        <span className="sound-desc">{sound.description}</span>
        {reporting === 'open' ? (
          <form className="sound-report" onSubmit={report}>
            <input
              value={reason}
              maxLength={500}
              placeholder="What's wrong with it? (not theirs to share, offensive…)"
              onChange={(e) => setReason(e.target.value)}
              aria-label="Why report it"
            />
            <button type="submit" className="link">
              Send
            </button>
          </form>
        ) : reporting === 'sent' ? (
          <span className="sound-meta">Thanks, we'll look at it.</span>
        ) : null}
      </div>
      <div className="sound-actions">
        <button
          type="button"
          className="link"
          onClick={() => {
            void navigator.clipboard?.writeText(ask).then(() => setCopied(true));
            track('Sound asked', { pack: sound.pack });
          }}
        >
          {copied ? 'Copied' : 'Copy for your AI'}
        </button>
        {onRemove ? (
          <button type="button" className="link" onClick={onRemove}>
            Take down
          </button>
        ) : reporting === 'closed' && sound.pack === COMMUNITY_PACK ? (
          <button type="button" className="link sound-quiet" onClick={() => setReporting('open')}>
            Report
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** A new sound from this device: sent like any upload, then shared with its details. */
function ShareNew({ signedIn, onShared }: { signedIn: boolean; onShared: () => void }) {
  const [state, setState] = useState<
    | { at: 'idle'; note?: string }
    | { at: 'sending'; name: string; sent: number; size: number }
    | { at: 'sent'; name: string; upload_id: string }
  >({ at: 'idle' });
  const pick = useRef<HTMLInputElement>(null);

  if (!signedIn) {
    return (
      <div className="csound-share">
        <a className="buy" href="/upload">
          Share a sound
        </a>
        <span className="share-fine">
          Sign in, drop your sound, and switch on “Share as a community sound”.
        </span>
      </div>
    );
  }

  async function send(file: File | undefined) {
    if (!file) return;
    if (!SHAREABLE.test(file.name)) {
      return setState({ at: 'idle', note: 'Pick an MP3, WAV, M4A, FLAC or OGG file.' });
    }
    setState({ at: 'sending', name: file.name, sent: 0, size: file.size });
    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, bytes: file.size }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Started> & { error?: string };
      if (!res.ok || !body.url || !body.upload_id)
        throw new Final(body.error || `HTTP ${res.status}`);
      await sendFile(file, body.url, {
        sent: (sent) => setState({ at: 'sending', name: file.name, sent, size: file.size }),
        note: () => undefined,
        inFlight: new Set(),
      });
      setState({ at: 'sent', name: file.name, upload_id: body.upload_id });
    } catch (error) {
      setState({
        at: 'idle',
        note: (error as Error).message || 'It did not go through; try again',
      });
    }
  }

  return (
    <div className="csound-share">
      {state.at === 'sent' ? (
        <ShareSound
          from={{ upload_id: state.upload_id }}
          fileName={state.name}
          startOn
          onShared={onShared}
        />
      ) : state.at === 'sending' ? (
        <span className="share-fine">
          Sending {state.name}: {Math.round((100 * state.sent) / Math.max(1, state.size))}%
        </span>
      ) : (
        <>
          <button type="button" className="buy" onClick={() => pick.current?.click()}>
            Share a sound
          </button>
          <span className="share-fine">
            {state.note ?? 'An MP3, WAV, M4A, FLAC or OGG of yours, up to 3 minutes.'}
          </span>
          <input
            ref={pick}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
            hidden
            onChange={(e) => {
              void send(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </>
      )}
    </div>
  );
}
