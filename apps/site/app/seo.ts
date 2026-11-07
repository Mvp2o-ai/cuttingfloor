// Words the page is found by: the title, the FAQ and the comparison, shared by the page, its
// structured data and llms.txt so the three never disagree. Volumes behind the phrasing: MVP-172.
import { DESKTOP_TOOLS } from '../content/toolkit.ts';
import { TOOL_COUNT } from '../content/tools.ts';
import { PLANS } from './pricing.ts';

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://cuttingfloor.ai';
export const MCP_ADDRESS = 'https://api.cuttingfloor.ai/mcp';
export const DOCS_URL = 'https://github.com/mvp2o-ai/cuttingfloor';

// The name leads: "cutting floor" is also an editing phrase, and people search for us in two words.
export const TITLE =
  'cuttingfloor (Cutting Floor): Video Editing MCP Server for ChatGPT, Claude, Kazi & Codex';

// Every way the name is written, and the other pages that are us, so search engines join them.
export const BRAND_NAMES = ['Cutting Floor', 'cuttingfloor.ai'];
export const PROFILES = [
  DOCS_URL,
  'https://glama.ai/mcp/connectors/io.github.Mvp2o-ai/cuttingfloor',
  'https://lobehub.com/mcp/mvp2o-ai-cuttingfloor',
];
export const DESCRIPTION = `The video editing MCP server for ChatGPT, Claude, Codex, Cursor and Kazi. The most complete video and motion graphics toolkit for your agent: paste one MCP address and your AI agent gets ${TOOL_COUNT} editing tools. It cuts by transcript, captions, mixes, makes graphics and exports real video, checking its work as it goes. Watch a free live demo, no sign-up. Open source: run it yourself free, or hosted.`;

// Questions in the words people search them with.
export const FAQS = [
  {
    q: 'What is a video editing MCP server?',
    a: `MCP (Model Context Protocol) is how AI apps such as ChatGPT and Claude connect to outside tools. cuttingfloor is an MCP server: add its address (${MCP_ADDRESS}) to your AI app as a connector, sign in, and the AI can cut, caption, mix and export your video with ${TOOL_COUNT} editing tools.`,
  },
  {
    q: 'Can I try AI video editing without signing up?',
    a: 'Yes. The live demo on the Demos page opens Kazi in your browser, free, with no sign-up and nothing to install. Kazi gives Big Buck Bunny a happy ending on cuttingfloor and plays you the finished video, each step showing as it runs. It takes a few minutes.',
  },
  {
    q: 'Can Claude edit videos?',
    a: 'Yes, with cuttingfloor connected. Claude (web, desktop and Claude Code) calls its tools to import your footage, transcribe it, cut on words, add captions, mix the sound and export an MP4. In Claude, add it under Settings → Connectors; in Claude Code, run claude mcp add.',
  },
  {
    q: 'Can ChatGPT edit videos?',
    a: 'Yes. In ChatGPT, open Plugins, choose Add custom MCP server, paste the cuttingfloor address and sign in. Then ask for the cut you want, in a chat or a ChatGPT Work task.',
  },
  {
    q: 'Is there a video editor app for ChatGPT?',
    a: `Yes: cuttingfloor connects to ChatGPT as an MCP app. Open Plugins, choose Add custom MCP server, paste ${MCP_ADDRESS} and sign in. Then ask ChatGPT to cut, caption or mix your video, and it hands back a real MP4.`,
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
    a: `cuttingfloor is one: ${TOOL_COUNT} tools over MCP, from clip.add and caption.add to audio.set_master and export.video. Every edit returns a new timeline and a preview, so the agent sees what it did and can step back. The full list is on the features page.`,
  },
  {
    q: 'Can AI edit video like CapCut or Premiere?',
    a: `Yes, with cuttingfloor connected. Your agent gets the tools a desktop editor has: ripple, roll, slip and slide trims, speed ramps, keyframes, masks, blend modes, adjustment layers, nested sequences, colour and LUTs, green screen, captions, motion graphics and a full mix, ${TOOL_COUNT} tools in all. ChatGPT, Claude or Kazi decides the edit and makes it, one tool call at a time, and can hand the timeline to Premiere, Final Cut or Resolve.`,
  },
  {
    q: 'Is there an MCP for motion graphics?',
    a: 'Yes. cuttingfloor’s create.motion renders any animated HTML your agent writes into video, frame-exact and with transparency, so titles, lower thirds, charts and explainer slides sit over footage on the same timeline. Titles, captions, keyframes and blend modes are tools too.',
  },
  {
    q: 'How is cuttingfloor different from other video MCPs?',
    a: 'The other hosted video editing MCPs are editor apps with their own AI inside (invideo, Vidova, CutClip, Tella, OpusClip, Descript): their MCP is a way into their app. cuttingfloor has no AI of its own and no app to open. It is the editing tools, for the agent you already use, and it is open source, so you can run the same server yourself. The compare page has the details.',
  },
  {
    q: 'Is cuttingfloor an editor with an AI inside?',
    a: 'No. It is the editing tools, without an editor around them. Your own agent (Claude, ChatGPT, Codex, Cursor, Kazi) makes every cut with them, so the intelligence is the agent you already chose, and the edit stays a timeline you can change, not a finished render.',
  },
  {
    q: 'Can Codex edit videos?',
    a: `Yes. Run codex mcp add cuttingfloor --url ${MCP_ADDRESS}, then codex mcp login cuttingfloor. The same setup works in the Codex CLI, its IDE extension and the desktop app.`,
  },
  {
    q: 'Does it work in Claude Cowork and ChatGPT Work?',
    a: 'Yes. Add cuttingfloor as a custom connector in Claude (Cowork uses the same connectors) or as a custom MCP plugin in ChatGPT, then ask for the edit in a Cowork or Work task.',
  },
  {
    q: 'Which agents work with it?',
    a: 'Any MCP client that takes remote servers: Kazi, Claude (web, desktop, Cowork and Code), ChatGPT and ChatGPT Work, Codex, Cursor, VS Code with Copilot, Zed, Goose, and anything built on the MCP SDKs.',
  },
  {
    q: 'Where does my footage go?',
    a: 'To our servers, for as long as you work on it. Media and renders expire after seven days, timelines after a day without use. No one else can see them.',
  },
  {
    q: 'What happens when my credits run out?',
    a: 'Editing and previews keep working; new jobs such as exports and imports wait until your credits renew, or until you move to a bigger plan. You are never charged more than the plan price. We email you at 80% and at 100%.',
  },
  {
    q: 'Can I run it myself for free?',
    a: 'Yes. cuttingfloor is open source (AGPL-3.0) and runs in one Docker image on your own machine: clone the repository and run docker compose up -d. The hosted version is the same image, run for you, with nothing to install.',
  },
  {
    q: 'Do I need my own AI keys?',
    a: 'Only for lip-sync, which uses your own sync. labs key. Transcripts, voiceover, background removal, stems, stabilizing and graphics run inside cuttingfloor with no key. Self-hosted, the visual judgment tools (judge.ask, look and media.seek) also need a TypeSafe key; hosted plans include them.',
  },
];

// The tools people search an alternative to, said fairly.
export const ALTERNATIVES = [
  {
    name: 'cuttingfloor',
    is: `An open-source MCP server of ${TOOL_COUNT} editing tools. Your agent imports footage, reads the transcript, cuts, captions, mixes and checks every step with a preview.`,
    when: 'the agent decides the edit, on footage it has not seen before.',
    ours: true,
  },
  {
    name: 'Remotion',
    is: 'A React framework: videos written as components and rendered from code.',
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

export function structuredData() {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: 'cuttingfloor',
      alternateName: BRAND_NAMES,
      url: SITE_URL,
      logo: `${SITE_URL}/apple-icon.png`,
      sameAs: PROFILES,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      name: 'cuttingfloor',
      alternateName: BRAND_NAMES,
      url: SITE_URL,
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'cuttingfloor',
      alternateName: BRAND_NAMES,
      url: SITE_URL,
      publisher: { '@id': `${SITE_URL}/#organization` },
      sameAs: PROFILES,
      description: DESCRIPTION,
      applicationCategory: 'MultimediaApplication',
      applicationSubCategory: 'Video editing MCP server',
      featureList: DESKTOP_TOOLS.map((r) => `${r.does} (${r.tools.join(', ')})`),
      operatingSystem: 'Any MCP client; self-hosted with Docker',
      softwareHelp: DOCS_URL,
      offers: PLANS.filter((p) => p.amount !== undefined).map((p) => ({
        '@type': 'Offer',
        name: p.name,
        price: String(p.amount),
        priceCurrency: 'USD',
        description: `${p.included}. ${p.limits}. ${p.note}`,
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
