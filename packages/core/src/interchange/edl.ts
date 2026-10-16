import type { StoredTransition, TimelineDoc } from '@cuttingfloor/schema';
import { transitionHalves } from '../edit.ts';
import {
  type FlatClip,
  type FlatTrack,
  flatten,
  frames,
  type InterchangeMediaResolver,
  type InterchangeResult,
  isDropFrame,
  isPlaying,
  type MediaClip,
  mediaName,
  nominalRate,
  noteDocument,
  noteDropped,
  playback,
  sameCut,
  timecode,
  transitionsInto,
  Warnings,
} from './common.ts';

// CMX 3600 EDL: one event list, from the first video track (or the first audio track when no
// video track holds media), with up to two audio channels from linked sound that lines up.
// Record timecode starts at 00:00:00:00; source timecode is the source's own position from
// its first frame. Gaps are implied by the record timecodes.

const REEL = 'AX';

function line(
  event: number,
  channel: string,
  kind: string,
  duration: number | undefined,
  src: [number, number],
  rec: [number, number],
  tc: (f: number) => string,
): string {
  const num = String(event).padStart(3, '0');
  const dur = duration === undefined ? '   ' : String(duration).padStart(3, '0');
  return `${num}  ${REEL.padEnd(8)} ${channel.padEnd(5)} ${kind.padEnd(4)} ${dur} ${tc(src[0])} ${tc(src[1])} ${tc(rec[0])} ${tc(rec[1])}`;
}

/** EDL text: printable ASCII on one line. */
const plain = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?');

/** Writes the timeline as a CMX 3600 EDL. */
export function toEdl(doc: TimelineDoc, resolve: InterchangeMediaResolver): InterchangeResult {
  const w = new Warnings();
  noteDocument(doc, w);
  const { tracks, media, tpf } = flatten(doc, w);
  const fps = doc.sequence.fps;
  const tc = (f: number) => timecode(f, fps);
  const f = (ticks: number) => frames(ticks, tpf);

  const playingTracks = tracks.filter((t) => {
    if (isPlaying(t)) return true;
    if (t.clips.some((c) => c.enabled))
      w.add(`${t.kind === 'video' ? 'Hidden' : 'Muted'} tracks were left out`, t.name);
    return false;
  });
  const hasMedia = (t: FlatTrack) => t.clips.some((c) => c.enabled && c.type === 'media');
  const video = playingTracks.filter((t) => t.kind === 'video');
  const audio = playingTracks.filter((t) => t.kind === 'audio');
  const firstVideo = video[0];
  const main =
    firstVideo && hasMedia(firstVideo) ? firstVideo : (audio.find(hasMedia) ?? firstVideo);
  const sound = main?.kind === 'audio' ? audio.filter((t) => t !== main) : audio;
  // Picture plus up to two sound channels, or sound plus one more.
  const channels = sound.slice(0, main?.kind === 'audio' ? 1 : 2);

  const out: string[] = [
    `TITLE: ${plain(doc.name).slice(0, 70)}`,
    `FCM: ${isDropFrame(fps) ? 'DROP FRAME' : 'NON-DROP FRAME'}`,
    '',
  ];
  const paired = new Set<string>();
  let event = 0;

  if (main) {
    const into = transitionsInto(main);
    const outOf = new Map<string, StoredTransition>((main.transitions ?? []).map((t) => [t.a, t]));
    const clips = main.clips.filter((c): c is MediaClip => {
      if (!c.enabled) return false;
      if (c.type !== 'media') {
        const what =
          c.type === 'adjustment' ? 'Adjustment clips' : c.type === 'title' ? 'Titles' : 'Captions';
        w.add(`${what} were left out (EDL holds only media)`, c.id);
        return false;
      }
      if (!resolve(c.media_id)) {
        w.add('Clips whose media could not be found were left out', c.id);
        return false;
      }
      return true;
    });
    // A transition is written as a dissolve when both of its clips are events.
    const ids = new Set(clips.map((c) => c.id));
    const written = (tr: StoredTransition | undefined) => {
      if (!tr) return undefined;
      if (ids.has(tr.a) && ids.has(tr.b)) return tr;
      w.add('Transitions next to clips that were left out were dropped', tr.id);
      return undefined;
    };

    clips.forEach((c, i) => {
      noteDropped(c, w);
      // Channels: linked sound with the same cut on the first two audio tracks.
      const lanes: number[] = [];
      channels.forEach((t, n) => {
        const a = t.clips.find((x) => sameCut(c, x));
        if (a) {
          lanes.push(n + 1);
          paired.add(a.id);
          noteDropped(a, w);
        }
      });
      const extra = lanes.length === 2 ? 'AA' : lanes[0] === 1 ? 'A' : lanes[0] === 2 ? 'A2' : '';
      const channel =
        main.kind === 'video' ? (extra ? `${extra}/V` : 'V') : lanes.length ? 'AA' : 'A';

      const p = playback(c, tpf);
      // Source position at tick `t` from the clip start, constant speed.
      const srcAt = (t: number) => (p.reverse ? c.in + p.span - p.rate * t : c.in + p.rate * t);
      const trIn = written(into.get(c.id));
      const trOut = written(outOf.get(c.id));
      const lead = trIn ? transitionHalves(trIn.duration, tpf).before : 0;
      const tail = trOut ? transitionHalves(trOut.duration, tpf).before : 0;
      const recIn = c.start - lead;
      const recOut = c.start + c.duration - tail;
      let src: [number, number] = [f(srcAt(-lead)), f(srcAt(c.duration - tail))];
      if (p.reverse) src = [src[1], src[0]];
      if (p.rate === 0) src = [f(c.in), f(c.in) + 1];

      const name = mediaName(c.media_id, resolve(c.media_id), media);
      event++;
      if (trIn) {
        // The outgoing clip holds at the dissolve's start, then the dissolve brings this one in.
        const prev = clips[i - 1] as MediaClip;
        const pp = playback(prev, tpf);
        const at = recIn - prev.start;
        const prevSrc = f(
          pp.rate === 0
            ? prev.in
            : pp.reverse
              ? prev.in + pp.span - pp.rate * at
              : prev.in + pp.rate * at,
        );
        const length = f(trIn.duration);
        if (trIn.kind !== 'dissolve' && trIn.kind !== 'crossfade')
          w.add('Transitions other than dissolves became dissolves', trIn.id);
        out.push(
          line(event, channel, 'C', undefined, [prevSrc, prevSrc], [f(recIn), f(recIn)], tc),
        );
        out.push(line(event, channel, 'D', length, src, [f(recIn), f(recOut)], tc));
        out.push(
          `* FROM CLIP NAME: ${plain(mediaName(prev.media_id, resolve(prev.media_id), media))}`,
        );
        out.push(`* TO CLIP NAME: ${plain(name)}`);
      } else {
        out.push(line(event, channel, 'C', undefined, src, [f(recIn), f(recOut)], tc));
        out.push(`* FROM CLIP NAME: ${plain(name)}`);
      }
      const file = resolve(c.media_id)?.path;
      if (file) out.push(`* SOURCE FILE: ${plain(file)}`);
      if (p.rate !== 1 || p.reverse) {
        const speed = nominalRate(fps) * p.rate * (p.reverse ? -1 : 1);
        const value = `${speed < 0 ? '-' : ''}${Math.abs(speed).toFixed(1).padStart(5, '0')}`;
        out.push(
          `M2   ${REEL.padEnd(8)}       ${value.padStart(6)}    ${tc(Math.floor(p.first / tpf))}`,
        );
      }
      out.push('');
    });
  }

  for (const t of video) {
    if (t === main) continue;
    if (t.clips.some((c) => c.enabled))
      w.add('Video tracks after the first were left out (an EDL holds one)', t.name);
  }
  for (const t of sound) {
    const left = t.clips.filter((c: FlatClip) => c.enabled && !paired.has(c.id));
    if (!left.length) continue;
    if (!channels.includes(t))
      w.add('Audio tracks after the first two were left out (an EDL holds two channels)', t.name);
    else
      for (const c of left)
        w.add('Audio that does not line up with the main track was left out', c.id);
  }
  for (const t of playingTracks)
    if (t !== main)
      for (const tr of t.transitions ?? [])
        if (!(t.kind === 'audio' && channels.includes(t)))
          w.add('Transitions outside the main track were dropped', tr.id);

  return { text: `${out.join('\n').replace(/\n+$/, '')}\n`, warnings: w.list() };
}
