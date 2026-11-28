import { kaziUrl } from '../app/kazi.tsx';
import { KEPT, KEPT_DAYS } from '../app/pricing.ts';
import { API_URL, MCP_URL } from './clients.ts';

// The ways to connect, by who is connecting: people who edit in an AI app they already use, and
// engineers who call the REST API with a key, from their app's backend or from code an LLM runs.
// /how-to-connect and its Markdown twin both read this list.

export type WayIcon = 'kazi' | 'chat' | 'cowork' | 'terminal' | 'plug' | 'braces';

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

export const WAYS_UPDATED = '2026-11-28';
export const WAYS_TITLE = 'How to connect cuttingfloor: AI apps, REST API and code execution';
export const WAYS_DESCRIPTION =
  'Edit video in the AI app you already use (Kazi, ChatGPT, Claude Cowork, Codex or your own), or build on the API: REST calls from your app’s backend, or code an LLM runs in a sandbox.';

export const CREATOR_WAYS: Way[] = [
  {
    id: 'kazi',
    name: 'Kazi',
    icon: 'kazi',
    tag: 'Fastest start',
    text: 'Our own AI agent, on your phone or computer. It opens with a sample clip and edits it on cuttingfloor. Nothing to set up.',
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
    name: 'REST API in your app',
    icon: 'braces',
    tag: 'For your app’s backend',
    text: `Call cuttingfloor from your own product like any other web service: your backend sends POST ${API_URL}/v1/<tool> with the arguments as JSON and gets the result back as JSON, with real HTTP status codes when a call is refused. Long work (imports, renders, exports) answers at once with a job_id that job.get waits on. The OpenAPI spec feeds code generators and API clients.`,
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
    id: 'code-execution',
    name: 'Code execution',
    icon: 'terminal',
    tag: 'Most efficient for LLMs',
    text: `An LLM writes code that calls the same API from a sandbox, and chains many edits in one run instead of spending a turn on each tool call. It reads only the tools it needs rather than loading every tool’s schema, and keeps big results in variables instead of its context. The sandbox only has to reach ${API_URL} with your key.`,
    links: [
      { label: 'Make an API key', href: '/account#api-keys', track: 'Ways: code key' },
      { label: 'OpenAPI spec', href: `${API_URL}/openapi.json`, track: 'Ways: code OpenAPI' },
    ],
    snippet: {
      label: 'In the sandbox (Python)',
      code: `import os, requests

API = "${API_URL}/v1"
KEY = os.environ["CUTTINGFLOOR_KEY"]

def cf(tool, **args):
    r = requests.post(f"{API}/{tool}", json=args,
        headers={"Authorization": f"Bearer {KEY}"})
    body = r.json()
    if not r.ok:
        raise RuntimeError(body.get("hint") or body["message"])
    return body

t = cf("timeline.create", name="First edit",
    sequence={"width": 1080, "height": 1920,
              "fps": {"num": 30, "den": 1}})
print(t["timeline_id"])`,
    },
  },
];

/** Engineers' guides, linked under the ways to build. */
export const BUILDER_GUIDES = [
  { label: 'Add video editing to your app', href: '/guides/add-video-editing-to-your-app' },
  { label: 'Build your own video editor', href: '/guides/build-your-own-video-editor' },
  { label: 'Vibe code a video editor', href: '/guides/vibe-code-a-video-editor' },
] as const;

/** Questions engineers ask, on /how-to-connect, in its FAQPage data and in its Markdown twin. */
export const BUILDER_FAQS = [
  {
    q: 'Is there a REST API and an OpenAPI spec?',
    a: `Yes. Every editing tool is one REST call, one to one with the MCP tools: POST ${API_URL}/v1/<tool> with its arguments as JSON and a key from your account page as Authorization: Bearer cf_…. It runs the same tool code as MCP, with the same checks, credits and results. The OpenAPI 3.1 spec at ${API_URL}/openapi.json describes every tool, and new tools appear there the day they ship.`,
  },
  {
    q: 'Can I build my own app on cuttingfloor?',
    a: 'Yes. Your backend calls the REST API with a key from your account page, so your users never need a cuttingfloor account. Every call acts as your account and uses its credits. Editing is free; a finished export comes as a watermarked review copy and a clean copy that spends credits once, when it is first opened or released with export.release.',
  },
  {
    q: 'Can an LLM call it from code execution?',
    a: `Yes. Code running in any sandbox that can reach ${API_URL} calls POST /v1/<tool> with your key. The model chains many edits in one run, reads only the tools it needs from the OpenAPI spec, and keeps large results in variables instead of its context, which costs far fewer tokens and turns than calling tools one at a time.`,
  },
  {
    q: 'How do long jobs and errors work?',
    a: 'Imports, analysis, renders and exports answer at once with a job_id. POST /v1/job.get with {"job_id": "…", "wait_seconds": 30} waits up to 30 seconds for it to finish, and a finished job gives its result and signed download links. A refused call answers with an HTTP error status and {code, message, hint}; the hint says what to do instead. Every edit returns a new timeline_id, and older ones stay valid.',
  },
  {
    q: 'How long are files kept?',
    a: `${KEPT} Download links last ${KEPT_DAYS} days, so store the finished files you want to keep on your side.`,
  },
  {
    q: 'Can I run it on my own servers?',
    a: 'Yes. cuttingfloor is open source and ships as one Docker image, the same server as the hosted one, REST API and OpenAPI spec included. See Run it yourself (/self-host).',
  },
] as const;
