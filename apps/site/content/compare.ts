// The comparison on /compare and /compare.md: agent-facing video MCP servers and APIs, and creator
// editing apps, side by side. Every cell comes from the products' public docs as of COMPARED_ON;
// "?" means we could not confirm it there, and a missing claim is one we could not check.

/** The day the public docs were read. */
export const COMPARED_ON = '2026-11-01';
export const AS_OF = 'As of November 2026, from public docs';

// ---------- agent-facing servers and APIs ----------

export const SERVER_COLUMNS = [
  { key: 'where', label: 'Hosted or local' },
  { key: 'source', label: 'Open source' },
  { key: 'tools', label: 'Editing tools or a prompt' },
  { key: 'sees', label: 'Agent sees its result' },
  { key: 'words', label: 'Cut by words' },
  { key: 'audio', label: 'Audio and voice' },
  { key: 'keys', label: 'Keys or accounts you bring' },
  { key: 'export', label: 'Export to an editing app' },
  { key: 'price', label: 'You pay per' },
] as const;

export type ServerKey = (typeof SERVER_COLUMNS)[number]['key'];

export type ServerRow = {
  name: string;
  /** One line: what it is. */
  is: string;
  ours?: true;
  cells: Record<ServerKey, string>;
  /** Finishes "Pick it when …". */
  pick: string;
};

export const SERVERS: ServerRow[] = [
  {
    name: 'cuttingfloor',
    is: 'An open-source MCP server of video editing tools for the agent you already use.',
    ours: true,
    cells: {
      where: 'Both: hosted, or the same Docker image on your own machine',
      source: 'Yes, AGPL-3.0',
      tools:
        'Editing tools: cut, trim, move, caption, mix, effects, export. Every edit is a new timeline you can go back to',
      sees: 'Yes: a preview comes back with every edit (frames, or a waveform with loudness measured), plus qa.check for exact checks and media.seek to find a moment in plain words',
      words: 'Yes, cut by word timings',
      audio:
        'Gain and pan keyframes, fades, EQ, compressor, voice denoise, master limiter, stems, voiceover with timed words, lip-sync',
      keys: 'Only for lip-sync (your sync. labs key). Self-hosted, the visual-judgment tools also need a TypeSafe key',
      export: 'FCPXML, OTIO and EDL, plus SRT and VTT captions',
      price: 'Render minute. Editing the timeline is free. Self-hosting is free',
    },
    pick: 'you want your agent to do the whole edit on your own footage, check its own work, and leave you an edit you can still change or open in your editing app.',
  },
  {
    name: 'Descript MCP',
    is: 'Hosted access to Descript; editing goes to its built-in AI, Underlord.',
    cells: {
      where: 'Hosted (Descript sign-in)',
      source: 'No',
      tools:
        'A prompt: editing is a written request to Underlord. Import, search, publish and transcript export are direct calls',
      sees: 'Not documented. Publishing returns MP4 links',
      words: 'Transcript export, yes. Cuts go through an Underlord prompt',
      audio: 'Studio Sound, filler removal and voice translation, through Underlord',
      keys: 'None',
      export: '?',
      price: 'Media hours and AI credits, two meters',
    },
    pick: 'you or your team already edit in Descript and want to hand Underlord a request from your agent, then finish by hand in Descript.',
  },
  {
    name: 'invideo MCP',
    is: 'Hosted access to the invideo timeline you see live, with generation models.',
    cells: {
      where: 'Hosted (sign-in)',
      source: 'No',
      tools:
        'Editing tools on a multitrack timeline, says invideo. The full tool list is not published',
      sees: '?',
      words: '?',
      audio: 'Mixing with buses and faders, and generation models (vendor claim)',
      keys: 'None',
      export: '?',
      price: 'Credits',
    },
    pick: 'you want generated footage from many models and want to watch the agent work in the same timeline you edit.',
  },
  {
    name: 'OpusClip MCP',
    is: 'Hosted clip jobs: long video in, short clips out.',
    cells: {
      where: 'Hosted',
      source: 'No',
      tools:
        'Jobs: submit a project to clip, caption and reframe, then edit one clip with a JSON edit script',
      sees: '?',
      words: 'Word timings in the transcript. Edits stay inside one clip of one video',
      audio: 'Bleeping (censor jobs)',
      keys: 'None',
      export: 'Premiere XML',
      price: 'Credits (processing minutes); renders through the MCP per minute',
    },
    pick: 'you want many short clips cut from a long video and scheduled to your socials, with the least effort.',
  },
  {
    name: 'Kapwing MCP',
    is: 'Hosted subtitles, translation and dubbing for one video in Kapwing.',
    cells: {
      where: 'Hosted (Kapwing sign-in)',
      source: 'No',
      tools:
        'A few direct tools: add subtitles, translate subtitles, dubbing, upload and download. A call to its AI, Kai, is planned',
      sees: 'No',
      words: 'No. Subtitles and transcripts only',
      audio: 'Dubbing with voice cloning',
      keys: 'None (Pro plan or higher)',
      export: '?',
      price: 'Seats, with AI features on workspace credits',
    },
    pick: 'you need subtitles, translations or dubbing on a single video and already pay for Kapwing.',
  },
  {
    name: 'Submagic MCP',
    is: 'Hosted captions and short-form templates.',
    cells: {
      where: 'Hosted, with an API key (no sign-in flow)',
      source: 'No',
      tools:
        'Project settings: templates, presets, media insertions and transcript fixes before a render. Not timeline edits',
      sees: '?',
      words: 'Transcript fixes before render',
      audio: '?',
      keys: 'A Submagic API key',
      export: '?',
      price: 'Credits (about three a video) and API minutes',
    },
    pick: 'you want styled captions on Shorts from a preset, fast.',
  },
  {
    name: 'Frapea',
    is: 'A browser editor your agent pairs with over MCP.',
    cells: {
      where: 'Runs in your browser tab; the agent pairs with it through a code',
      source: '?',
      tools:
        'Editing tools: add, split, trim, move, ripple, effects, transitions, keyframes, multicam',
      sees: 'Yes, on request: contact sheets of the timeline and media, a timeline check, loudness',
      words: 'Yes, word-level transcript and word removal',
      audio:
        'Volume keyframes, loudness, voiceover (in-browser voices or your ElevenLabs key), sound effects',
      keys: 'Optional: ElevenLabs, Pexels, Freesound',
      export: 'Not documented',
      price: 'No credits, says Frapea',
    },
    pick: 'you want an editor you can also work in by hand while your agent edits in the same tab.',
  },
  {
    name: 'DaVinci Resolve MCP bridges',
    is: 'Community servers that drive Resolve on your computer.',
    cells: {
      where: 'Local: Resolve open on the same machine (most need Resolve Studio)',
      source: 'The bridges, mostly MIT. Resolve itself is closed',
      tools: 'Editing tools that mirror Resolve’s scripting API, hundreds in the largest',
      sees: 'Partly: frame exports to a file, marker thumbnails',
      words: 'Yes in the largest bridge, with optional Whisper',
      audio: 'Fairlight, voice isolation',
      keys: 'None, but a Resolve Studio licence ($295, one time)',
      export: 'Edits your Resolve project directly',
      price: 'Free bridge, plus the Resolve Studio licence',
    },
    pick: 'you already edit in Resolve Studio and want your agent working in your real project, next to the best colour tools there are.',
  },
  {
    name: 'Premiere and After Effects bridges',
    is: 'Community servers that drive Adobe’s desktop apps.',
    cells: {
      where: 'Local: the Adobe app open on the same machine',
      source: 'The bridges, MIT. The Adobe apps are closed',
      tools: 'Editing tools for Premiere (hundreds) or After Effects comps, layers and keyframes',
      sees: 'Partly: still-frame exports in Premiere. None documented for After Effects',
      words: 'Partly: transcript cleanup and caption tracks in Premiere',
      audio: 'Premiere audio keyframes and ducking',
      keys: 'None, but an Adobe licence',
      export: 'Edits your Premiere or After Effects project directly',
      price: 'Free bridge, plus Adobe Creative Cloud',
    },
    pick: 'your projects live in Premiere or After Effects and stay there.',
  },
  {
    name: 'FFmpeg MCP servers',
    is: 'Community servers that run FFmpeg commands on files.',
    cells: {
      where: 'Mostly local, a few hosted',
      source: 'Mostly MIT; Kinocut is Apache-2.0',
      tools: 'File operations: each one writes a new file. No timeline',
      sees: 'Partly: some extract frames or storyboards',
      words: 'Mostly no; Kinocut makes Whisper subtitles',
      audio: 'Extract and convert audio; Kinocut adds loudness, mastering and local text to speech',
      keys: 'None locally; hosted ones need their own key',
      export: '?',
      price: 'Free locally',
    },
    pick: 'you need one-off conversions, trims or audio extracts on your own computer, for free.',
  },
  {
    name: 'Shotstack',
    is: 'A cloud render API with an MCP server in beta.',
    cells: {
      where: 'Hosted',
      source: 'No',
      tools:
        'Render: the agent writes the whole edit as JSON and gets a video back. Templates and generated assets',
      sees: 'Not documented for the agent. A preview canvas is shown to you',
      words: 'Not documented',
      audio: 'Generated audio assets',
      keys: 'Your Shotstack account',
      export: '?',
      price: 'Render minute ($0.20 pay as you go, or $39 to $499 a month)',
    },
    pick: 'you already know the edit and need it rendered at volume from data.',
  },
  {
    name: 'Creatomate',
    is: 'Templates designed in its editor, filled in and rendered through an API.',
    cells: {
      where: 'Hosted',
      source: 'No',
      tools: 'Render: templates and render jobs',
      sees: 'No (a free dry-run check only)',
      words: 'Not documented',
      audio: 'Not documented in the MCP',
      keys: 'Your Creatomate account',
      export: '?',
      price: 'Render credits',
    },
    pick: 'one branded template needs many variations.',
  },
  {
    name: 'JSON2Video',
    is: 'A JSON-to-video API with a local command-line MCP.',
    cells: {
      where: 'Local command-line server that calls its cloud',
      source: '?',
      tools: 'Render: send a JSON movie, check it, use templates',
      sees: 'No',
      words: '?',
      audio: '?',
      keys: 'Your JSON2Video key',
      export: '?',
      price: 'Credits (600 free, about 10 minutes with a watermark)',
    },
    pick: 'simple videos are assembled from data.',
  },
  {
    name: 'HyperFrames (HeyGen)',
    is: 'An open-source framework that turns HTML into video, with agent skills.',
    cells: {
      where: 'Local command line and skills; a hosted MCP in beta',
      source: 'Yes, Apache-2.0 (the framework)',
      tools: 'Code: the agent writes the video as HTML, previews it and renders it',
      sees: 'Partly: a local preview loop',
      words: '?',
      audio: '?',
      keys: 'A HeyGen account for the hosted server',
      export: '?',
      price: 'Free framework; HeyGen credits when hosted',
    },
    pick: 'you want motion graphics as HTML in an open-source framework you run yourself.',
  },
];

/** Others people ask about, said in a line. */
export const ALSO = [
  {
    name: 'Tella',
    is: 'A screen recorder with a hosted MCP of editing tools that checks frames of the edited video.',
    pick: 'your videos are screen recordings.',
  },
  {
    name: 'Palmier Pro',
    is: 'An open-source (GPL-3.0) macOS editor with a local MCP that renders frames to check. Generation is paid and closed.',
    pick: 'you edit on a Mac and want a local app your agent and you share.',
  },
  {
    name: 'Remotion',
    is: 'A React framework for making videos in code, with agent skills. Companies pay for a licence.',
    pick: 'you want the video to be a codebase you keep and maintain.',
  },
];

// ---------- creator editing apps ----------

/** Y yes · N no · P partly · $ only on a higher plan or metered · ? not confirmed in 2026 docs. */
export type Mark = 'Y' | 'N' | 'P' | '$' | '?';
export const MARKS: Record<Mark, string> = {
  Y: 'Yes',
  N: 'No',
  P: 'Partly',
  $: 'Higher plan or metered',
  '?': 'Not confirmed',
};

export const APP_COLUMNS = [
  { key: 'filler', label: 'Filler-word removal' },
  { key: 'captions', label: 'Captions with word highlight' },
  { key: 'reframe', label: 'Reframe' },
  { key: 'cutout', label: 'Background removal' },
  { key: 'voice', label: 'Voice cleanup' },
  { key: 'stems', label: 'Voice and music split' },
  { key: 'voiceover', label: 'AI voiceover' },
  { key: 'lipsync', label: 'Lip-sync' },
  { key: 'beats', label: 'Beat sync' },
  { key: 'broll', label: 'B-roll' },
] as const;

export type AppKey = (typeof APP_COLUMNS)[number]['key'];

export type AppRow = {
  name: string;
  ours?: true;
  marks: Record<AppKey, Mark>;
  /** How an agent can reach it, in a line. */
  agent: string;
  selfHost: string;
};

// Columns in APP_COLUMNS order: filler, captions, reframe, cutout, voice, stems, voiceover,
// lipsync, beats, broll.
function marks(s: string): Record<AppKey, Mark> {
  const m = s.split(' ') as Mark[];
  return Object.fromEntries(APP_COLUMNS.map((c, i) => [c.key, m[i] ?? '?'])) as Record<
    AppKey,
    Mark
  >;
}

export const APPS: AppRow[] = [
  {
    name: 'cuttingfloor',
    ours: true,
    marks: marks('Y Y Y Y Y Y Y Y Y P'),
    agent: 'The whole product is tools for your agent, over MCP',
    selfHost: 'Yes, one Docker image',
  },
  {
    name: 'Descript',
    marks: marks('Y Y ? Y Y ? Y ? ? Y'),
    agent: 'MCP and API: a prompt to Underlord',
    selfHost: 'No',
  },
  {
    name: 'CapCut',
    marks: marks('? Y ? $ ? ? Y ? Y ?'),
    agent: 'No official MCP or editing API; community servers write draft files',
    selfHost: 'No',
  },
  {
    name: 'VEED',
    marks: marks('Y Y ? Y Y ? Y Y ? ?'),
    agent: 'An API of AI models (dubbing, lip-sync, clean audio); no editing tools',
    selfHost: 'No',
  },
  {
    name: 'Kapwing',
    marks: marks('? Y ? Y Y ? Y Y ? Y'),
    agent: 'MCP: subtitles, translation and dubbing',
    selfHost: 'No',
  },
  {
    name: 'OpusClip',
    marks: marks('$ Y Y ? $ N Y ? N Y'),
    agent: 'MCP: clip jobs and an edit script for one clip',
    selfHost: 'No',
  },
  {
    name: 'Submagic',
    marks: marks('$ Y ? ? Y N ? N ? Y'),
    agent: 'MCP with an API key: project settings and templates',
    selfHost: 'No',
  },
  {
    name: 'Captions',
    marks: marks('? Y ? ? Y ? Y Y ? Y'),
    agent: 'API for captions and avatars; no MCP found',
    selfHost: 'No',
  },
  {
    name: 'Runway',
    marks: marks('N N N ? ? ? Y ? N Y'),
    agent: 'MCP for generating and restyling; no timeline edits',
    selfHost: 'No',
  },
  {
    name: 'Riverside',
    marks: marks('$ ? ? ? Y N ? ? N Y'),
    agent: 'MCP in beta on higher plans: plain-language edits',
    selfHost: 'No',
  },
  {
    name: 'Adobe Premiere',
    marks: marks('Y P Y P Y ? ? ? N P'),
    agent: 'Adobe’s Claude connector (whole jobs, no timeline); community desktop bridges',
    selfHost: 'No (a desktop app)',
  },
  {
    name: 'DaVinci Resolve',
    marks: marks('? $ $ $ $ $ $ N $ N'),
    agent: 'No official MCP; community bridges (outside scripting needs Studio)',
    selfHost: 'No (a desktop app)',
  },
  {
    name: 'Canva',
    marks: marks('? ? P ? ? N ? N ? ?'),
    agent: 'MCP for designs; no video timeline tools found',
    selfHost: 'No',
  },
  {
    name: 'Pictory',
    marks: marks('? Y P N ? N Y N N Y'),
    agent: 'Video API; an MCP announced in 2025, status not confirmed',
    selfHost: 'No',
  },
  {
    name: 'invideo',
    marks: marks('? ? ? ? ? ? Y ? ? Y'),
    agent: 'MCP on the live multitrack timeline',
    selfHost: 'No',
  },
];

/** What cuttingfloor's marks mean, so "Yes" is not read as a button. */
export const OUR_NOTES: Record<AppKey, string> = {
  filler: 'Your agent cuts the ums and restarts by their word timings.',
  captions: 'caption.add takes word timings and highlights each word as it is said.',
  reframe: 'Your agent reframes from face boxes it measures.',
  cutout: 'create.cutout, built in, no key.',
  voice: 'Voice denoise, EQ and compressor filters, with loudness measured.',
  stems: 'create.stems splits voice, drums, bass and music (Demucs).',
  voiceover: 'create.voiceover, with timed words (Kokoro), no key.',
  lipsync: 'create.lipsync, on your own sync. labs key.',
  beats: 'media.analyze finds the beats; your agent cuts on them.',
  broll: 'Partly: no stock library. Your agent places your footage or graphics it makes.',
};
