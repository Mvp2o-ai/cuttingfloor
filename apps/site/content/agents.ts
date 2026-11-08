import { FREE_CREDITS } from '@cuttingfloor/plans';
import { CLIENTS, type Client } from './clients.ts';
import { DEMOS, type Demo } from './demos.ts';

// One page per agent people edit from: /agents/<slug>. Kazi, Claude and ChatGPT stand side by side
// (Kazi is ours, so it leads). Claude and ChatGPT are searched by name ("can chatgpt edit videos",
// "claude video editing"); Kazi isn't, and has its page all the same. Connect steps come from
// clients.ts and the demos from demos.ts, so each page shows real sessions in its own agent.
// Every other app is on /connect.

export const AGENTS_UPDATED = '2026-11-04';

export type Agent = {
  /** /agents/<slug>, and the client in clients.ts whose steps come first. */
  slug: 'kazi' | 'claude' | 'chatgpt';
  /** The name demos use for sessions in this agent. */
  name: Demo['agent'];
  /** The question it answers, as people ask it. */
  title: string;
  metaTitle: string;
  metaDescription: string;
  /** The answer under the H1, 40 to 60 words. */
  answer: string;
  /** More of this vendor's apps on /connect, each with its own steps. */
  related: Client['slug'][];
  /** Something to say once it's connected. */
  prompt: string;
  /** Each heading is a question people ask. */
  faqs: { q: string; a: string }[];
};

const TRIAL = `Start free with ${FREE_CREDITS} credits: no card, no time limit, every tool.`;

export const AGENTS: Agent[] = [
  {
    slug: 'kazi',
    name: 'Kazi',
    title: 'Edit videos with Kazi',
    metaTitle: 'Edit videos with Kazi: cut, caption and export by asking | cuttingfloor',
    metaDescription:
      'Connect cuttingfloor to Kazi and ask for the edit on the web, on your phone or by text. Kazi cuts your footage, adds captions and music, checks a preview and sends back the finished video.',
    answer:
      'Kazi is an assistant that works on the web, on your phone, by text and in meetings. Connect cuttingfloor once and Kazi can edit your videos: it cuts your footage, adds captions and music, looks at a preview to check its work, and sends you back a finished MP4.',
    related: [],
    prompt:
      'Cut my video to the beat of the song and add big captions. Make it vertical for Reels.',
    faqs: [
      {
        q: 'How do I connect cuttingfloor to Kazi?',
        a: 'Ask Kazi to connect the cuttingfloor MCP server at https://api.cuttingfloor.ai/mcp, or add it under Servers in Kazi. Sign in when the cuttingfloor page opens, and Kazi can edit.',
      },
      {
        q: 'Can I edit from my phone?',
        a: 'Yes. Kazi runs on your phone and by text, so you can send the footage and ask for the edit from wherever you are. The finished video comes back as a link that plays in any browser.',
      },
      {
        q: 'What can Kazi do to my video?',
        a: 'The same as any agent on cuttingfloor: cut by what you said, remove pauses and restarts, cut to the beat, add captions and titles, music and voiceover, remove a background, steady shaky footage, and export for Reels, TikTok, Shorts or YouTube.',
      },
      {
        q: 'What does it cost?',
        a: `${TRIAL} After that, pay as you go: credit packs are on the pricing page.`,
      },
    ],
  },
  {
    slug: 'claude',
    name: 'Claude',
    title: 'Can Claude edit videos? Yes, with cuttingfloor.',
    metaTitle: 'Can Claude edit videos? Video editing with Claude and Claude Code | cuttingfloor',
    metaDescription:
      'On its own, Claude can’t cut a video. Add cuttingfloor as a connector and Claude edits for you: it cuts your footage, adds captions and music, checks a preview and gives you the finished video. Works in Claude, Cowork and Claude Code.',
    answer:
      'On its own, Claude can plan an edit but can’t cut your video. Add cuttingfloor as a connector and it can: Claude imports your footage, cuts it by what you said, adds captions and music, looks at a preview to check its work, and gives you back a finished MP4. The same works in Cowork and Claude Code.',
    related: ['claude-cowork', 'claude-code'],
    prompt:
      'Cut the long pauses, ums and restarts out of my video, then add big captions that highlight each word.',
    faqs: [
      {
        q: 'Can Claude edit videos?',
        a: 'Not by itself: Claude reads and writes, it doesn’t cut video. With cuttingfloor connected it can, because it gets the editing tools: import, cut, caption, mix, preview and export.',
      },
      {
        q: 'Does it work in Claude Code?',
        a: 'Yes. Run claude mcp add --transport http cuttingfloor https://api.cuttingfloor.ai/mcp, then type /mcp and sign in. Claude Code edits the same way, and can script long or repeated jobs.',
      },
      {
        q: 'Which Claude plans can use it?',
        a: 'Custom connectors work on Free, Pro, Max, Ultra, Team and Enterprise. Free accounts get one custom connector. On Team and Enterprise, an owner adds it for the organization first.',
      },
      {
        q: 'Can Claude add captions to a video?',
        a: 'Yes. It transcribes your video with the time of every word, then adds captions that can highlight each word as you say it. It can also hand you the captions as an SRT or VTT file.',
      },
      {
        q: 'What does it cost?',
        a: `${TRIAL} After that, pay as you go: credit packs are on the pricing page.`,
      },
    ],
  },
  {
    slug: 'chatgpt',
    name: 'ChatGPT',
    title: 'Can ChatGPT edit videos? Yes, with cuttingfloor.',
    metaTitle: 'Can ChatGPT edit videos? Edit video with ChatGPT | cuttingfloor',
    metaDescription:
      'On its own, ChatGPT can’t cut a video. Add cuttingfloor as a plugin and ChatGPT edits for you: it cuts your footage, adds captions and music, checks a preview and gives you the finished video.',
    answer:
      'On its own, ChatGPT can write a script or describe an edit, but it can’t cut your video. Add cuttingfloor as a plugin and it can: ChatGPT imports the video you attach, cuts it, adds captions and music, looks at a preview to check its work, and gives you back a finished MP4.',
    related: ['chatgpt-work', 'codex'],
    prompt:
      '@cuttingfloor Turn this into a 15-second vertical Short with big captions and a hook title.',
    faqs: [
      {
        q: 'Can ChatGPT edit videos?',
        a: 'Not by itself: ChatGPT can plan an edit and write the script, but it doesn’t cut video. With cuttingfloor added as a plugin it can, because it gets the editing tools: import, cut, caption, mix, preview and export.',
      },
      {
        q: 'Can I attach my video in the chat?',
        a: 'Yes. Attach it and type @cuttingfloor with what you want. ChatGPT passes the file to cuttingfloor, and the finished video comes back as a link that plays in any browser.',
      },
      {
        q: 'Which ChatGPT plans can add it?',
        a: 'Adding a custom MCP server is up to OpenAI and your plan. On Business, only admins and owners can create plugins with MCP servers; on Enterprise and Edu, an admin has to allow them first.',
      },
      {
        q: 'Does it work in the ChatGPT app on my phone?',
        a: 'Yes, once it’s added. You add plugins on the web or the desktop app, and they work on your phone too.',
      },
      {
        q: 'What does it cost?',
        a: `${TRIAL} After that, pay as you go: credit packs are on the pricing page.`,
      },
    ],
  },
];

export function agent(slug: string): Agent | undefined {
  return AGENTS.find((a) => a.slug === slug);
}

/** The agent's own client entry, then its related apps, as clients.ts has them. */
export function agentClients(a: Agent): Client[] {
  return [a.slug, ...a.related].flatMap((s) => CLIENTS.filter((c) => c.slug === s));
}

/** Real sessions in this agent, from demos.ts. */
export function agentDemos(a: Agent): Demo[] {
  return DEMOS.filter((d) => d.agent === a.name);
}
