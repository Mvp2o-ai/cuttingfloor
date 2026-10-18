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

// Cut out pauses, ums and restarts: 22:14 of talking head with 28 restarts left in. The agent keeps the last take of
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
    slug: 'cut-pauses-and-restarts',
    title: 'Cut out pauses, ums and restarts',
    metaTitle:
      'Cut the pauses, ums and restarts out of a long video with your AI agent | cuttingfloor',
    metaDescription:
      'A 22-minute video full of long pauses, ums and lines started over. The prompt, and every tool call an agent made, to cut them out without losing a word.',
    oneLiner:
      'Cut the long pauses, the ums and the lines you started over out of a talking video, so it flows, without losing anything you meant to say.',
    answer:
      'Your agent can clean up a talking video for you: the long pauses, the ums, and the lines you started over. Here Claude Code, with the cuttingfloor MCP server connected, reads every word of a 22-minute video, cuts 28 restarts, smooths each cut so nothing jumps, checks its work and exports the finished file.',
    updated: '2026-10-18',
    prompt: `Here's my 22-minute video: ./footage/ep12-raw.mp4.
Cut out the long pauses, the ums, and the bits where I messed up and
started a line again. Keep everything else in order, and don't lose
anything I actually meant to say.`,
    session: {
      agent: 'claude code',
      preview: { aspect: '16:9', length: EP12_LENGTH, fps: 30 },
      tracks: ['V1', 'A1'],
      steps: [
        {
          kind: 'user',
          text: 'Here’s my 22-minute video. Cut out the long pauses, the ums, and the bits where I started a line again. Keep everything else in order.',
        },
        {
          kind: 'agent',
          text: 'On it. I’ll read through everything you said first, so I can find the pauses and the restarts.',
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
          text: 'Found 28 places where you started a line over, plus the long pauses. I’m keeping your best take each time, in the same order.',
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
          text: 'Now I’m smoothing every cut so the sound doesn’t jump, and zooming in a little on every other part so the cuts don’t jar.',
        },
        {
          kind: 'call',
          fn: 'edit.batch',
          args: '{ ops: 28 × clip.trim { side: "audio" } }',
          full: '{ timeline_id: "tl_02", ops: [ { tool: "clip.trim", args: { clip_id: "c_a01", edge: "end", side: "audio", to_frame: 1145 } }, … 27 more, each 6 frames past its cut ] }',
          ret: 'tl_03 · sound carries over 28 cuts',
        },
        {
          kind: 'call',
          fn: 'edit.batch',
          args: '{ ops: 28 × transition.add { kind: "crossfade" } }',
          full: '{ timeline_id: "tl_03", ops: [ { tool: "transition.add", args: { clip_id: "c_a01", kind: "crossfade", duration_frames: 4 } }, … 27 more ] }',
          ret: 'tl_04 · 28 soft cuts',
        },
        {
          kind: 'call',
          fn: 'edit.batch',
          args: '{ ops: 14 × clip.set_transform { scale: 1.08 } }',
          full: '{ timeline_id: "tl_04", ops: [ { tool: "clip.set_transform", args: { clip_id: "c_v02", scale: 1.08, y: 0.46 } }, … every other passage, 14 in all ] }',
          ret: 'tl_05 · zoomed in on every other part',
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
          text: 'I looked at both sides of the cuts: nothing jumps. Running the checks, then the export.',
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
          text: 'Done. ep12-clean.mp4 is 21:33, 41 seconds shorter, and everything you meant to say is still in it.',
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
        { swatch: 'cut', text: 'what stays: your best take of each line' },
        { swatch: 'alt', text: 'zoomed in a little, so cuts don’t jar' },
        { swatch: 'mark', text: 'a cut, smoothed so the sound doesn’t jump' },
      ],
      stats: [
        { label: 'Restarts cut', value: '28' },
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
        heading: 'How do I cut the ums and pauses out of a video?',
        body: [
          'Ask your agent, in your own words. With cuttingfloor connected, it reads everything you said with the time of every word, so it can see each long pause, each um, and each line you started over. It keeps your best take of each line and cuts the rest, in order.',
        ],
      },
      {
        heading: 'Won’t all those cuts look choppy?',
        body: [
          'Not if each one is smoothed. The agent lets the sound run a moment past each cut so it never stops dead, softens it so it doesn’t click, and zooms in a little on every other part so the picture change feels on purpose. Then it looks at both sides of the cuts before it exports.',
        ],
      },
      {
        heading: 'Will I lose anything I said?',
        body: [
          'No. The order stays the same, and every line you meant to say is still there. Nothing is re-recorded or generated: the video was already shot, and this is just the edit.',
        ],
      },
    ],
  },
];

export function walkthrough(slug: string): Walkthrough | undefined {
  return WALKTHROUGHS.find((w) => w.slug === slug);
}
