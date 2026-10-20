// Words the page is found by: the title, the FAQ and the comparison, shared by the page, its
// structured data and llms.txt so the three never disagree. Volumes behind the phrasing: MVP-172.
import { PLANS } from './pricing.ts';

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cuttingfloor.ai';
export const MCP_ADDRESS = 'https://api.cuttingfloor.ai/mcp';
export const DOCS_URL = 'https://github.com/mvp2o-ai/cuttingfloor';

export const TITLE = 'Video Editing MCP Server for Claude, Cursor & ChatGPT | cuttingfloor';
export const DESCRIPTION =
  'Turn Claude, Cursor or ChatGPT into a video editing agent. One MCP server, 62 tools: cut by transcript, caption, mix and export real video. Open source.';

// Questions in the words people search them with.
export const FAQS = [
  {
    q: 'Can Claude edit videos?',
    a: 'Yes, with cuttingfloor connected. Claude (web, desktop and Claude Code) calls its tools to import your footage, transcribe it, cut on words, add captions, mix the sound and export an MP4. In Claude, add it under Settings → Connectors; in Claude Code, run claude mcp add.',
  },
  {
    q: 'Can ChatGPT edit videos?',
    a: 'Yes, in developer mode, which lets ChatGPT use remote MCP servers. Add the cuttingfloor address under Settings → Apps → Create, sign in, and ask for the cut you want.',
  },
  {
    q: 'How do I add a video editing MCP server to Cursor?',
    a: `Add cuttingfloor to ~/.cursor/mcp.json with the address ${MCP_ADDRESS}. Cursor opens the sign-in the first time a tool runs. The same address works in Claude, VS Code, Kazi and any client that takes remote MCP servers.`,
  },
  {
    q: 'What is agentic video editing?',
    a: 'An AI agent edits the footage itself: it reads the material, decides the cuts, makes them with real editing tools and checks the result before it hands it over. cuttingfloor gives the agent those tools; you say what you want.',
  },
  {
    q: 'Is there a video editing API for AI agents?',
    a: 'cuttingfloor is one: 62 tools over MCP, from clip.add and caption.add to audio.set_master and export.video. Every edit returns a new timeline and a preview, so the agent sees what it did and can step back. When an edit needs a loop, code.run runs a script that calls the same tools.',
  },
  {
    q: 'Which agents work with it?',
    a: 'Any MCP client with remote servers: Kazi, Claude (web, desktop and Code), Cursor, ChatGPT in developer mode, VS Code, and anything built on the MCP SDKs.',
  },
  {
    q: 'Where does my footage go?',
    a: 'To our servers, for as long as you work on it. Media and renders expire after seven days, timelines after a day without use. No one else can see them.',
  },
  {
    q: 'Can I run it myself?',
    a: 'Yes. cuttingfloor is open source and runs in one Docker image on your own machine. The hosted version is the same image, run for you.',
  },
  {
    q: 'Do I need my own AI keys?',
    a: 'No. Transcription, voiceover, cutouts and graphics run on our servers. Your agent is whatever you already use.',
  },
];

// The tools people search an alternative to, said fairly.
export const ALTERNATIVES = [
  {
    name: 'cuttingfloor',
    is: 'An MCP server of 62 editing tools. The agent imports footage, reads the transcript, cuts, captions, mixes and checks every step with a preview.',
    when: 'the agent decides the edit, on footage it has not seen before.',
    ours: true,
  },
  {
    name: 'Remotion',
    is: 'Videos written as React components and rendered from code.',
    when: 'you want the video to be a codebase you keep and maintain.',
  },
  {
    name: 'Shotstack',
    is: 'A cloud render API: send a JSON timeline, get a file back.',
    when: 'you already know the edit and need it rendered at volume.',
  },
  {
    name: 'Creatomate',
    is: 'Templates designed in its editor, filled in through an API.',
    when: 'one branded template needs many variations.',
  },
  {
    name: 'JSON2Video',
    is: 'A JSON-to-video API with built-in text-to-speech.',
    when: 'simple videos are assembled from data.',
  },
];

function amount(price: string): string {
  return price.replace(/[^0-9.]/g, '') || '0';
}

export function structuredData() {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'cuttingfloor',
      url: SITE_URL,
      description: DESCRIPTION,
      applicationCategory: 'MultimediaApplication',
      applicationSubCategory: 'Video editing MCP server',
      operatingSystem: 'Any MCP client; self-hosted with Docker',
      softwareHelp: DOCS_URL,
      offers: PLANS.map((p) => ({
        '@type': 'Offer',
        name: p.name,
        price: amount(p.price),
        priceCurrency: 'USD',
        description: `${p.included}. ${p.note}`,
      })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: FAQS.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ];
}
