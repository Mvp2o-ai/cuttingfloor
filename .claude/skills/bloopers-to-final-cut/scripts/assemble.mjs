// node assemble.mjs <spec.json>  (see spec.example.json)
// Builds a Bloopers to Final Cut Short on cuttingfloor: bloopers → shrug → teach (connect panel) →
// talk to the AI (session + host in the corner) → "let's try that again" → the final cut → sign-off →
// end card. Writes <spec>.out.json with the timeline_id and beat times; export with verify.mjs.
import { call, client, words } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const S = JSON.parse(readFileSync(process.argv[2], 'utf8'));
S.words ??= { teach: await words(S.teach_media), app: await words(S.app_line_media), again: await words(S.again_media) };
const F = 30, f = (s) => Math.round(s * F);
const tl = await call('timeline.create', { sequence: { width: 1080, height: 1920, fps: { num: 30, den: 1 } } });
const V1 = tl.tracks.find((t) => (t.kind ?? t.type) === 'video').id;
let id = tl.timeline_id, r;
const batch = async (ops) => { r = await call('edit.batch', { timeline_id: id, preview: 'none', ops }); id = r.timeline_id; return r; };
await batch(['video', 'video', 'video', 'video', 'video', 'audio', 'audio'].map((kind) => ({ tool: 'track.add', args: { kind } })));
const [V2, V3, V4, V5, V6, A2, A3] = r.results.map((x) => x.track_id); // V2 overlays, V3 corner, V4 captions, V5 stamps, V6 titles
const HOOK = { font: 'Inter', bold: true, size: 0.055, color: '#FFFFFF', align: 'center', x: 0.5, y: 0.19, max_width: 0.88, outline: { color: '#000000', width: 0.12 } };
const TAG = { font: 'Noto Sans Mono', bold: true, size: 0.034, color: '#FFFFFF', align: 'center', x: 0.5, y: 0.075, box: { color: '#111111', padding: 0.4 } };
const CAPS = { font: 'Inter', bold: true, size: 0.042, color: '#FFFFFF', align: 'center', x: 0.5, y: 0.74, max_width: 0.86, outline: { color: '#000000', width: 0.12 }, highlight: { mode: 'pop', color: '#FFD43B' } };

// main line: [beat, media, in, out, rate]
const line = [
  ...S.bloopers.map(([m, a, b], i) => [`blooper${i}`, m, a, b, 1]),
  ...S.whatever.map(([a, b], i) => [`whatever${i}`, S.whatever_media, a, b, 1]),
  ...S.teach.map(([a, b], i) => [`teach${i}`, S.teach_media, a, b, 1]),
  ['app', S.app_mock, 0, S.app_mock_out, S.app_mock_out / S.app_line.reduce((n, [a, b]) => n + (f(b) - f(a)) / F, 0)],
  ...S.again.map(([a, b], i) => [`again${i}`, S.again_media, a, b, 1]),
  ['after', S.after, 0, S.after_seconds, 1],
  ...S.cta.map(([a, b], i) => [`cta${i}`, S.cta_media, a, b, 1]),
  ['tag', S.tag_media, S.tag[0], S.tag[1], 1],
];
const beats = {}, ops = [];
let t = 0;
for (const [name, m, a, b, rate] of line) {
  ops.push({ tool: 'clip.add', args: { track_id: V1, media_id: m, source: { in: f(a), out: f(b) } } });
  if (Math.abs(rate - 1) > 1e-3) ops.push({ tool: 'clip.set_speed', args: { clip_id: { $ref: `ops[${ops.length - 1}].clip_id` }, rate } });
  const len = Math.round(f(b - a) / rate) / F;
  beats[name] = [t, t + len, a]; t += len;
}
await batch(ops);
const clipOf = {}; { let k = 0; ops.forEach((o, i) => { if (o.tool === 'clip.add') clipOf[line[k++][0]] = r.results[i].clip_id; }); }
const B = (n) => f(beats[n][0]), E = (n) => f(beats[n][1]), end = f(t);
// The transcriber mishears some names ("Kazi" as Cosy/Casi): spec.spellings maps heard → written.
const fixWords = (ws) => ws.map((w) => { let text = w.text; for (const [heard, says] of Object.entries(S.spellings ?? {})) text = text.replace(new RegExp(`^${heard}`, 'i'), says); return { ...w, text }; });
const segsOf = (ws, a, b) => { const in_ = fixWords(ws).filter((w) => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 <= b); const out = []; for (let i = 0; i < in_.length; i += 3) { const g = in_.slice(i, i + 3); out.push({ start: g[0].start, end: g.at(-1).end, text: g.map((w) => w.text).join(' '), words: g.map(({ text, start, end }) => ({ text, start, end })) }); } return out; };

const ops2 = [
  { tool: 'title.add', args: { track_id: V6, text: S.hook_text, at_frame: 0, duration_frames: f(S.hook_text_until), style: HOOK } },
  { tool: 'title.add', args: { track_id: V6, text: 'TAKE 3 · FINAL CUT', at_frame: B('after'), duration_frames: f(2.0), style: TAG } },
  { tool: 'title.add', args: { track_id: V6, text: S.cta_text, at_frame: B('cta0'), duration_frames: B('tag') - B('cta0'), style: { ...HOOK, size: 0.05 } } },
  { tool: 'clip.add', args: { track_id: V2, media_id: S.hero, at_frame: B('tag'), source: { in: 0, out: end - B('tag') } } },
  { tool: 'clip.add', args: { track_id: V2, media_id: S.icons, at_frame: B('teach1'), source: { in: 0, out: Math.min(f(5.5), E(`teach${S.teach.length - 1}`) - B('teach1')) } } },
  { tool: 'clip.set_transform', args: { clip_id: { $ref: 'ops[4].clip_id' }, scale: 0.86, y: 0.43 } },
];
// bloopers: a beep and a stamp on each fumble
S.bloopers.forEach(([, a, b, beepAt], i) => {
  const at = B(`blooper${i}`) + f(beepAt - a);
  ops2.push({ tool: 'clip.add', args: { track_id: A2, media_id: S.beep, at_frame: at } });
  ops2.push({ tool: 'audio.set_gain', args: { clip_id: { $ref: `ops[${ops2.length - 1}].clip_id` }, gain_db: -9 } });
  ops2.push({ tool: 'clip.add', args: { track_id: V5, media_id: S.stamps[i], at_frame: at, source: { in: 0, out: Math.min(f(1.2), E(`blooper${i}`) - at + f(0.2)) } } });
});
// her in the corner, talking to her AI, over the app session
{ let at = B('app');
  for (const [a, b] of S.app_line) {
    ops2.push({ tool: 'clip.add', args: { track_id: V3, media_id: S.app_cutout, at_frame: at, source: { in: f(a), out: f(b) } } });
    ops2.push({ tool: 'clip.set_transform', args: { clip_id: { $ref: `ops[${ops2.length - 1}].clip_id` }, scale: 0.5, x: 0.76, y: 0.92 } });
    ops2.push({ tool: 'clip.set_mask', args: { clip_id: { $ref: `ops[${ops2.length - 2}].clip_id` }, mask: { shape: 'rectangle', x: 0.5, y: 0.33, width: 1, height: 0.66, feather: 0.03 } } });
    at += f(b) - f(a);
  } }
await batch(ops2);
// captions on everything she says to the viewer
const capOps = [];
S.teach.forEach(([a, b], i) => capOps.push({ tool: 'caption.add', args: { track_id: V4, in_clip: { clip_id: clipOf[`teach${i}`], segments: segsOf(S.words.teach, a, b) }, style: CAPS } }));
S.again.forEach(([a, b], i) => capOps.push({ tool: 'caption.add', args: { track_id: V4, in_clip: { clip_id: clipOf[`again${i}`], segments: segsOf(S.words.again, a, b) }, style: CAPS } }));
// the app line: caption timed on the main line (the corner clips carry its words)
{ let at = B('app'); const segs = [];
  for (const [a, b] of S.app_line) { for (const s of segsOf(S.words.app, a, b)) segs.push({ start_frame: at + f(s.start - a), end_frame: at + f(s.end - a), text: s.text }); at += f(b) - f(a); }
  capOps.push({ tool: 'caption.add', args: { track_id: V4, segments: segs.map((s) => ({ ...s, start_frame: Math.max(B('app'), s.start_frame), end_frame: Math.max(s.start_frame + 6, s.end_frame) })), style: { ...CAPS, y: 0.8, x: 0.33, max_width: 0.56, size: 0.038 } } }); }
await batch(capOps);
// music bed under everything, up on the hook, out at the end
const k = (fr, v) => ({ frame: fr, value: v, ease: 'sine_in_out' });
await batch([
  { tool: 'clip.add', args: { track_id: A3, media_id: S.bed, at_frame: 0, source: { in: 0, out: end } } },
  { tool: 'audio.set_gain', args: { clip_id: { $ref: 'ops[0].clip_id' }, gain_db: { keyframes: [k(0, -15), k(f(2.2), -15), k(f(2.6), -25), k(end - f(1), -25), k(end, -45)] } } },
  { tool: 'audio.set_master', args: { gain_db: 6, limit_db: -1.5 } },
]);
writeFileSync(process.argv[2].replace('.json', '.out.json'), JSON.stringify({ timeline_id: id, beats, total: t }, null, 1));
console.log(id, t.toFixed(2), JSON.stringify(Object.fromEntries(Object.entries(beats).map(([n, [a, b]]) => [n, `${a.toFixed(1)}-${b.toFixed(1)}`]))));
await client.close();
