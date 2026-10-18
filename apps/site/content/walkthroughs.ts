import type { SessionData } from '../app/session/types.ts';

// Every walkthrough, as data. /walkthroughs and /walkthroughs/[slug] render from this array
// alone, so adding an entry here adds a page and a hub card, and nothing else changes.
// Scripts use the real tools and argument shapes (packages/schema/src/tools.ts).

export type ResultTrack = {
  name: string;
  /** Seconds of the finished edit. */
  segments: { from: number; to: number; tone?: 'alt' }[];
  /** Points to mark on the lane, in seconds: joins, transitions. */
  marks?: number[];
};

export type Walkthrough = {
  slug: string;
  /** The technique's name: the H1 and the hub card. */
  title: string;
  metaTitle: string;
  metaDescription: string;
  /** One sentence: the technique and the problem it solves. */
  oneLiner: string;
  /** The answer under the H1, 40 to 60 words, for readers and answer engines alike. */
  answer: string;
  updated: string;
  /** What the user typed, verbatim. */
  prompt: string;
  session: SessionData;
  result: {
    /** Seconds the lanes span. */
    length: number;
    tracks: ResultTrack[];
    legend: { swatch: 'cut' | 'alt' | 'mark'; text: string }[];
    stats: { label: string; value: string }[];
  };
  file: { name: string; container: string; codec: string; duration: string; resolution: string };
  /** The page copy: each heading is a question people ask. */
  sections: { heading: string; body: string[] }[];
};

// Fix jagged cuts: 22:14 of talking head with 28 retakes left in. The agent keeps the last take of
// each, so 29 passages remain, 41 seconds shorter.
const EP12_LENGTH = 1293;
const EP12_JOINS = [
  38, 81, 117, 166, 204, 251, 290, 338, 377, 414, 462, 503, 548, 590, 631, 676, 719, 757, 806, 845,
  893, 934, 978, 1021, 1068, 1109, 1157, 1203,
];
const EP12_PASSAGES = [0, ...EP12_JOINS, EP12_LENGTH]
  .slice(1)
  .map((to, i) => ({ from: i === 0 ? 0 : (EP12_JOINS[i - 1] ?? 0), to }));

export const WALKTHROUGHS: Walkthrough[] = [
  {
    slug: 'fix-jagged-cuts',
    title: 'Fix jagged cuts',
    metaTitle: 'Fix jagged jump cuts in a long YouTube video with an AI agent | cuttingfloor',
    metaDescription:
      'Hard cuts between retakes on the same angle read as jolts. The prompt, and every tool call, an agent used to find 28 of them and make each one invisible.',
    oneLiner:
      'Turn the hard cuts between retakes on one camera angle into joins nobody notices, without changing the running order or losing a word.',
    answer:
      'Fixing jagged cuts means turning the jump cuts between retakes on one camera angle into joins nobody notices. Here an agent connected to the cuttingfloor MCP server reads the transcript of a 22-minute video, finds 28 retake joins, adds L-cuts, audio crossfades and alternating punch-ins, checks the frames and exports a 4K file.',
    updated: '2026-10-18',
    prompt: `Here's the raw export of my 22-minute video: ./footage/ep12-raw.mp4.
There are about thirty jump cuts in the talking-head sections: pauses
and retakes I left in. They're hard cuts on the same angle, so they
read as little jolts. Find them and clean them up so the cuts feel
invisible. Don't change the running order and don't lose anything I
actually said.`,
    session: {
      agent: 'claude code',
      preview: { aspect: '16:9', length: EP12_LENGTH, fps: 30 },
      tracks: ['V1', 'A1'],
      steps: [
        {
          kind: 'user',
          text: 'Here’s my 22-minute episode. About thirty jump cuts on the same angle read as jolts. Make them invisible; keep the order and every word.',
        },
        {
          kind: 'agent',
          text: 'Importing it and reading the transcript. A retake shows up in the words: a pause, then the same sentence again.',
        },
        {
          kind: 'call',
          fn: 'media.import',
          args: '{ source: { path: "/media/footage/ep12-raw.mp4" } }',
          ret: 'm_3e91 · 22:14 · 3840x2160 · 29.97 fps',
        },
        {
          kind: 'call',
          fn: 'media.analyze',
          args: '{ media_id: "m_3e91", kind: "transcript" }',
          ret: '3,180 words, timed',
        },
        {
          kind: 'agent',
          text: 'I found 28 retakes. I’m keeping the last take of each sentence, so 29 passages stay, in order.',
        },
        {
          kind: 'call',
          fn: 'timeline.create',
          args: '{ 3840x2160, 29.97 fps }',
          full: '{ name: "ep12", sequence: { width: 3840, height: 2160, fps: { num: 30000, den: 1001 } } }',
          ret: 'tl_01 · V1, A1',
          effect: { type: 'timeline' },
        },
        {
          kind: 'call',
          fn: 'edit.batch',
          args: '{ ops: 29 × clip.add { source: { words } } }',
          full: '{ timeline_id: "tl_01", ops: [ { tool: "clip.add", args: { track_id: "V1", media_id: "m_3e91", source: { words: [0, 96] } } }, { tool: "clip.add", args: { track_id: "V1", media_id: "m_3e91", source: { words: [112, 205] } } }, … 27 more, to words [3041, 3179] ] }',
          ret: 'tl_02 · 29 clips · 21:33',
          effect: {
            type: 'clip',
            tracks: ['V1', 'A1'],
            from: 0,
            to: EP12_LENGTH,
            cuts: EP12_JOINS,
          },
        },
        {
          kind: 'agent',
          text: 'Now the joins. Each gets an L-cut, so the room tone carries under the picture change, and a short audio crossfade.',
        },
        {
          kind: 'call',
          fn: 'edit.batch',
          args: '{ ops: 28 × clip.trim { side: "audio" } }',
          full: '{ timeline_id: "tl_02", ops: [ { tool: "clip.trim", args: { clip_id: "c_a01", edge: "end", side: "audio", to_frame: 1145 } }, … 27 more, each 6 frames past its cut ] }',
          ret: 'tl_03 · 28 L-cuts, 6-frame audio tails',
        },
        {
          kind: 'call',
          fn: 'edit.batch',
          args: '{ ops: 28 × transition.add { kind: "crossfade" } }',
          full: '{ timeline_id: "tl_03", ops: [ { tool: "transition.add", args: { clip_id: "c_a01", kind: "crossfade", duration_frames: 4 } }, … 27 more ] }',
          ret: 'tl_04 · 28 audio crossfades, 4 frames',
        },
        {
          kind: 'call',
          fn: 'edit.batch',
          args: '{ ops: 14 × clip.set_transform { scale: 1.08 } }',
          full: '{ timeline_id: "tl_04", ops: [ { tool: "clip.set_transform", args: { clip_id: "c_v02", scale: 1.08, y: 0.46 } }, … every other passage, 14 in all ] }',
          ret: 'tl_05 · punch-in on alternate passages',
        },
        {
          kind: 'call',
          fn: 'render.frames',
          args: '{ frames: both sides of joins 1–8 }',
          full: '{ timeline_id: "tl_05", frames: [1138, 1139, 2427, 2428, 3506, 3507, 4975, 4976, 6114, 6115, 7522, 7523, 8691, 8692, 10129, 10130], layout: "grid" }',
          ret: 'one contact sheet, 16 frames',
        },
        {
          kind: 'agent',
          text: 'Each join reads as a cut-in now, not a jolt. I checked the other twenty the same way. Running QA, then the export.',
        },
        {
          kind: 'call',
          fn: 'qa.check',
          args: '{ timeline_id: "tl_05" }',
          ret: 'passed · no gaps · no black frames · −14.2 LUFS',
          effect: { type: 'qa', checks: ['no gaps', 'no black frames', 'loudness ok'] },
        },
        {
          kind: 'call',
          fn: 'export.video',
          args: '{ preset: "web_1080p_h264", 3840x2160 }',
          full: '{ timeline_id: "tl_05", preset: "web_1080p_h264", overrides: { width: 3840, height: 2160 }, filename: "ep12-clean" }',
          ret: 'ep12-clean.mp4 · 00:21:33:00 · 3840x2160',
          effect: { type: 'export', file: 'ep12-clean.mp4' },
          wait: 1.8,
        },
        {
          kind: 'agent',
          text: 'Done. 21:33, 41 seconds of dead frames gone, every sentence kept and in order.',
        },
      ],
    },
    result: {
      length: EP12_LENGTH,
      tracks: [
        {
          name: 'V1',
          segments: EP12_PASSAGES.map((p, i) => ({
            ...p,
            tone: i % 2 ? ('alt' as const) : undefined,
          })),
        },
        { name: 'A1', segments: EP12_PASSAGES, marks: EP12_JOINS },
      ],
      legend: [
        { swatch: 'cut', text: 'a passage, the last take kept' },
        { swatch: 'alt', text: 'punched in to 108%' },
        { swatch: 'mark', text: 'L-cut and 4-frame crossfade' },
      ],
      stats: [
        { label: 'Retake joins', value: '28' },
        { label: 'Running time', value: '22:14 → 21:33' },
        { label: 'Words lost', value: '0' },
        { label: 'Tool calls', value: '10' },
      ],
    },
    file: {
      name: 'ep12-clean.mp4',
      container: 'MP4',
      codec: 'H.264, AAC',
      duration: '21:33',
      resolution: '3840 × 2160, 29.97 fps',
    },
    sections: [
      {
        heading: 'Why do jump cuts on the same angle look jagged?',
        body: [
          'Between two takes of the same shot the words change and the background doesn’t, so the eye reads the cut as a jolt even when it is technically clean. Long talking-head videos collect dozens of them: every pause and every retake you left in.',
        ],
      },
      {
        heading: 'How does the agent find the jump cuts?',
        body: [
          'It reads. media.analyze returns the transcript with every word timed, and a retake looks the same in any language: a pause, then a sentence starting over. There is no jump-cut detector tool; the agent decides where the joins are, and keeps the last attempt at each sentence.',
        ],
      },
      {
        heading: 'What happens at each join?',
        body: [
          'Three small edits. The audio runs six frames past the picture change (an L-cut), so the room tone bridges the join. A four-frame crossfade stops it clicking. Every other passage is punched in to 108%, so the same angle reads as a new shot. Then the agent looks at both sides of each join with render.frames before it exports.',
        ],
      },
      {
        heading: 'What stays the same?',
        body: [
          'The running order and every sentence you said. Nothing is re-shot or generated: the footage was already shot, and this is what happens to it next.',
        ],
      },
    ],
  },
];

export function walkthrough(slug: string): Walkthrough | undefined {
  return WALKTHROUGHS.find((w) => w.slug === slug);
}
