import { kaziUrl } from '../app/kazi.tsx';
import { API_URL, MCP_URL } from './clients.ts';

// The ways to connect, by who is connecting: people who edit in an AI app they already use, and
// engineers whose own code or agent calls cuttingfloor with a key. /how-to-connect and its
// Markdown twin both read this list.

export type WayIcon = 'kazi' | 'chat' | 'cowork' | 'terminal' | 'plug' | 'braces' | 'key';

export interface Way {
  id: string;
  name: string;
  icon: WayIcon;
  text: string;
  /** A short tag on the card, such as what the way is best for. */
  tag?: string;
  links: Array<{ label: string; href: string; track: string }>;
  snippet?: { label: string; code: string };
}

export const WAYS_UPDATED = '2026-11-09';
export const WAYS_TITLE = 'How to connect cuttingfloor: AI apps, REST and MCP';
export const WAYS_DESCRIPTION =
  'Edit video in the AI app you already use (Kazi, ChatGPT, Claude Cowork, Codex or your own), or call every editing tool from your code with an API key, over REST or MCP.';

export const CREATOR_WAYS: Way[] = [
  {
    id: 'kazi',
    name: 'Kazi',
    icon: 'kazi',
    tag: 'Fastest start',
    text: 'Our own AI agent, on your phone or computer. It opens with a sample clip and edits it while you watch. Nothing to set up.',
    links: [
      { label: 'Try it live, free', href: kaziUrl('home'), track: 'Ways: Kazi live' },
      { label: 'How it works', href: '/agents/kazi', track: 'Ways: Kazi page' },
    ],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    icon: 'chat',
    text: 'Add cuttingfloor to ChatGPT once, then ask for the edit in a chat: “cut the pauses out of this”.',
    links: [{ label: 'Set it up', href: '/connect#chatgpt', track: 'Ways: ChatGPT' }],
  },
  {
    id: 'claude-cowork',
    name: 'Claude Cowork',
    icon: 'cowork',
    text: 'Give Claude your footage and what you want made. It works through the edit as a task while you get on with other things.',
    links: [{ label: 'Set it up', href: '/connect#claude-cowork', track: 'Ways: Cowork' }],
  },
  {
    id: 'codex',
    name: 'Codex',
    icon: 'terminal',
    text: 'In the Codex app, on the command line or in your code editor: one line adds cuttingfloor, and you sign in once.',
    links: [{ label: 'Set it up', href: '/connect#codex', track: 'Ways: Codex' }],
  },
  {
    id: 'your-app',
    name: 'Your own AI app',
    icon: 'plug',
    text: 'Claude, Cursor, VS Code, Goose or any app that takes an MCP server. Paste one address and the app opens the sign-in for you.',
    links: [{ label: 'Pick your app', href: '/connect#apps', track: 'Ways: any app' }],
    snippet: { label: 'The address', code: MCP_URL },
  },
];

export const BUILDER_WAYS: Way[] = [
  {
    id: 'rest',
    name: 'REST API',
    icon: 'braces',
    tag: 'Most efficient for LLMs using code execution',
    text: `Every editing tool is one HTTP call: POST ${API_URL}/v1/<tool> with its arguments as JSON. Code an LLM writes calls the tools directly and chains them in one run, without loading every tool’s schema into its context. The OpenAPI spec feeds code generators and API clients.`,
    links: [
      { label: 'Make an API key', href: '/account#api-keys', track: 'Ways: REST key' },
      { label: 'OpenAPI spec', href: `${API_URL}/openapi.json`, track: 'Ways: OpenAPI' },
    ],
    snippet: {
      label: 'A first call',
      code: `curl ${API_URL}/v1/timeline.create \\
  -H 'Authorization: Bearer cf_…' \\
  -H 'Content-Type: application/json' \\
  -d '{"name": "First edit", "sequence": {"width": 1080, "height": 1920, "fps": {"num": 30, "den": 1}}}'`,
    },
  },
  {
    id: 'mcp-key',
    name: 'MCP with an API key',
    icon: 'key',
    text: 'The full MCP server for your own agent, a back-end job or anything with no browser to sign in: send the key as a header. The same key works for REST, and both act as your account and use its credits.',
    links: [
      { label: 'Make an API key', href: '/account#api-keys', track: 'Ways: MCP key' },
      { label: 'Setup for each app', href: '/connect#any', track: 'Ways: MCP setup' },
    ],
    snippet: {
      label: 'Your app’s MCP settings',
      code: JSON.stringify(
        {
          mcpServers: { cuttingfloor: { url: MCP_URL, headers: { Authorization: 'Bearer cf_…' } } },
        },
        null,
        2,
      ),
    },
  },
];
