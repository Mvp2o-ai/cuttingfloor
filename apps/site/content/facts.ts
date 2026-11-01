// Product facts several pages state: what runs where, what needs a key of your own, and how to
// run it yourself. Pricing, features, connect, self-host, llms.txt and the FAQ all read them here,
// so a change lands everywhere at once. Each line is checked against the server and the image.

export const LICENCE = 'AGPL-3.0';
export const REPO_URL = 'https://github.com/mvp2o-ai/cuttingfloor';
export const IMAGE = 'ghcr.io/mvp2o-ai/cuttingfloor';

/** Running it yourself: compose starts the server and the sandbox that renders motion graphics. */
export const SELF_HOST_STEPS = [
  'git clone https://github.com/mvp2o-ai/cuttingfloor && cd cuttingfloor',
  'docker compose up -d',
] as const;
/** The local server's address once compose is up (loopback only). */
export const LOCAL_ADDRESS = 'http://127.0.0.1:8787/mcp';

export type KeyNeed = {
  feature: string;
  /** Tool names, for agents matching a fact to a call. */
  tools: string[];
  hosted: string;
  selfHosted: string;
};

/** What needs a key of your own, hosted and self-hosted. Everything not listed needs none. */
export const KEYS: KeyNeed[] = [
  {
    feature: 'Lip-sync (redraw a speaker’s mouth to new words)',
    tools: ['create.lipsync'],
    hosted:
      'Your own sync. labs key, saved on your account page or sent as a header. sync. labs bills you per second.',
    selfHosted: 'Your own sync. labs key as SYNC_API_KEY.',
  },
  {
    feature:
      'Visual judgment: questions about frames, looking across a video, finding moments in plain words',
    tools: ['judge.ask', 'media.analyze (look)', 'media.seek'],
    hosted: 'Included. No key.',
    selfHosted: 'A TypeSafe key as TYPESAFE_API_KEY (typesafe.ai).',
  },
];

/** Built into the image and run on the server: no key, hosted or self-hosted. */
export const NO_KEY = [
  'Transcripts with word times (whisper.cpp)',
  'Voiceover with timed words (Kokoro)',
  'Background removal for people or any subject (MODNet, BiRefNet)',
  'Voice, drums, bass and music split apart (Demucs)',
  'Stabilizing shaky footage (vid.stab)',
  'Motion graphics and stills from HTML, with transparency',
  'Beats, faces, object tracking, silences and scene changes',
  'Every edit, effect, caption, mix and export (FFmpeg and MLT)',
] as const;
