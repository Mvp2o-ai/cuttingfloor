import { API_URL, MCP_URL } from '../../content/clients.ts';
import { KEEP_FILES } from '../pricing.ts';

// The words on /connect that aren't one app's steps, shared by the page, its FAQPage data and
// its Markdown twin so the three never disagree.

export const CONNECT_TITLE = 'Connect cuttingfloor to Claude, ChatGPT, Codex, Cursor and more';
export const CONNECT_DESCRIPTION =
  'cuttingfloor gives the AI agent you already use real video editing tools. Stay in Claude, ChatGPT, Codex, Cursor, Kazi or any MCP app, add one server address and sign in. Steps for each app.';
export const CONNECT_LEAD =
  'cuttingfloor isn’t another editor with AI inside. It gives the agent you already use the tools to edit video. Stay where you are, add one server address and sign in.';

export const HOW = [
  {
    title: 'You ask your agent.',
    text: 'In the app you already use, say what you want: “Cut the pauses, add big captions, make it vertical.”',
  },
  {
    title: 'It calls the tools.',
    text: 'Your agent imports the footage, reads the transcript and makes each cut, caption and mix with cuttingfloor’s editing tools.',
  },
  {
    title: 'Every edit comes back with a preview.',
    text: 'Each edit returns a new version of the timeline and a picture of it, so your agent sees what it made and fixes what’s off. Earlier versions stay. When it’s right, it exports an MP4 and gives you the link.',
  },
  {
    title: 'You keep what you want.',
    text: KEEP_FILES,
  },
] as const;

export const CONNECT_FAQS = [
  {
    q: 'How do I use Claude to edit video?',
    a: `Add cuttingfloor as a custom connector: in Claude, open Customize → Connectors, click + Add, choose Add custom connector, paste ${MCP_URL} and sign in. Then ask for the edit in a chat or a Cowork task. In Claude Code, run claude mcp add --transport http cuttingfloor ${MCP_URL}, then /mcp to sign in.`,
  },
  {
    q: 'Can ChatGPT edit video?',
    a: `Yes, with cuttingfloor added as a plugin. Open chatgpt.com/plugins, click +, choose Add custom MCP server, paste ${MCP_URL} and set Authentication to OAuth, so ChatGPT opens the cuttingfloor sign-in page. Then type @cuttingfloor in a chat or a ChatGPT Work task.`,
  },
  {
    q: 'Is there a video editing MCP server for Codex?',
    a: `cuttingfloor is one. Run codex mcp add cuttingfloor --url ${MCP_URL}, then codex mcp login cuttingfloor to sign in. The Codex CLI, the IDE extension and the ChatGPT desktop app share the same settings, so adding it once covers all three.`,
  },
  {
    q: 'Do I have to install anything?',
    a: 'No. The editing and rendering run on our servers, and your agent connects to one address. If you’d rather run it on your own computer, it’s free and open source: see Run it yourself.',
  },
  {
    q: 'Can a script use it without a browser sign-in?',
    a: 'Yes. Make a key on your account page (it starts with cf_) and have the script send it as Authorization: Bearer cf_… to the same address.',
  },
  {
    q: 'Is there a REST API and an OpenAPI spec?',
    a: `Yes. Every tool is also plain HTTP: POST ${API_URL}/v1/<tool> with its arguments as JSON and a key from your account page as Authorization: Bearer cf_…. The OpenAPI spec at ${API_URL}/openapi.json describes every tool, so code generators and API clients can read it.`,
  },
] as const;
