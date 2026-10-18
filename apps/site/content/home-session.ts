import type { SessionData } from '../app/session/types.ts';

// The home page's session (MVP-173): an interview cut to a 60-second vertical teaser.
export const HOME_SESSION: SessionData = {
  agent: 'claude',
  preview: {
    aspect: '9:16',
    length: 60,
    fps: 30,
    captions: [
      ['Nobody', 'watches', 'forty', 'minutes.'],
      ['They', 'watch', 'one', 'line.'],
      ['So', 'cut', 'to', 'it.'],
    ],
  },
  steps: [
    {
      kind: 'user',
      text: 'Cut my 40-minute interview into a 60-second vertical teaser. Captions on, loud enough for phones.',
    },
    { kind: 'agent', text: 'On it. Importing the footage and reading the transcript first.' },
    {
      kind: 'call',
      fn: 'media.import',
      args: '{ source: { url: "…/interview.mp4" } }',
      ret: 'm_7f2c · 40:12 · 1080p · ready',
    },
    {
      kind: 'call',
      fn: 'media.analyze',
      args: '{ kind: "transcript" }',
      ret: '6,412 words, timed',
    },
    {
      kind: 'agent',
      text: 'I have the transcript. Three passages hold the argument, so I’m taking those.',
    },
    {
      kind: 'call',
      fn: 'timeline.create',
      args: '{ 1080x1920, 30fps }',
      ret: 'tl_01 · empty',
      effect: { type: 'timeline' },
    },
    {
      kind: 'call',
      fn: 'clip.add',
      args: '{ words: [812, 861] }',
      ret: 'V1 00:00–00:14',
      effect: { type: 'clip', tracks: ['V1', 'A1'], from: 0, to: 14 },
    },
    {
      kind: 'call',
      fn: 'clip.add',
      args: '{ words: [2209, 2260] }',
      ret: 'V1 00:14–00:31',
      effect: { type: 'clip', tracks: ['V1', 'A1'], from: 14, to: 31 },
    },
    {
      kind: 'call',
      fn: 'clip.add',
      args: '{ words: [5120, 5198] }',
      ret: 'V1 00:31–00:58',
      effect: { type: 'clip', tracks: ['V1', 'A1'], from: 31, to: 58 },
    },
    { kind: 'agent', text: 'Checking my own work before I hand it over.' },
    {
      kind: 'call',
      fn: 'caption.add',
      args: '{ from_transcript: true }',
      ret: '84 captions on V2',
      effect: { type: 'captions', track: 'V2', from: 0, to: 58 },
    },
    {
      kind: 'call',
      fn: 'audio.set_master',
      args: '{ gain_db: 6, limit_db: -1 }',
      ret: 'measured −14.1 LUFS',
      effect: { type: 'loudness', reading: '−14.1 LUFS' },
    },
    {
      kind: 'call',
      fn: 'qa.check',
      args: '{ timeline_id: "tl_06" }',
      ret: 'no gaps, no black frames, sync ok',
      effect: { type: 'qa', checks: ['no gaps', 'no black frames', 'sync ok'] },
    },
    {
      kind: 'call',
      fn: 'export.video',
      args: '{ preset: "social_9x16_h264" }',
      ret: 'teaser.mp4 · 00:00:58:12 · signed link',
      effect: { type: 'export', file: 'teaser.mp4' },
      wait: 1.8,
    },
    {
      kind: 'agent',
      text: 'Done. 58 seconds, captioned, −14 LUFS, and it passes its own checks. Here’s the file.',
    },
  ],
};
