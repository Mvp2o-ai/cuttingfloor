// How to connect cuttingfloor from each agent, one entry per app. The /connect page, its
// Markdown twin and the home page's Connect box all read this list, so a change to an app's
// steps lands everywhere at once. Steps were checked on each vendor's own docs on 1 November 2026;
// where a vendor doesn't say which plans can add a server, the entry doesn't either.
//
// Logos: every app shows as a text wordmark in the same logo slot until its owner approves a
// mark. To use an approved SVG, put it in public/logos/ and set `logo` to its path.

/** Where the server answers: MCP at /mcp, the same tools as plain HTTP at /v1/<tool>. */
export const API_URL = 'https://api.cuttingfloor.ai';
export const MCP_URL = `${API_URL}/mcp`;

/** OpenAI's help page on custom MCP servers in ChatGPT, and what it says about plans. */
export const CHATGPT_HELP =
  'https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt';
export const CHATGPT_PLANS =
  'As of 8 November 2026, OpenAI’s help page lists custom MCP servers for ChatGPT Business, Enterprise and Edu, on the web. It doesn’t say whether Free, Plus or Pro can add one: if Add custom MCP server shows under + on your Plugins page, your account can.';

/** When the steps below were last checked against each vendor's docs. */
export const CLIENTS_CHECKED = '2026-11-01';

export type Snippet = {
  /** What it is, in a few words: "Run in a terminal", "~/.cursor/mcp.json". */
  label: string;
  code: string;
};

export type Client = {
  /** The page anchor: /connect#claude-code. */
  slug: string;
  name: string;
  /** An approved logo, e.g. '/logos/cursor.svg'. Unset shows the name as a wordmark. */
  logo?: string;
  /** Ours, so it leads, in the accent. */
  ours?: boolean;
  /** Where it runs, in a few words. */
  where: string;
  /** The steps, in order, as the app labels its own buttons. */
  steps: string[];
  /** Things to paste. The first is the main one. */
  snippets: Snippet[];
  /** Plans, admin settings and limits the vendor documents. */
  notes?: string[];
  /** A one-click install link, where the app has one. */
  install?: { label: string; href: string };
  /** The vendor's own setup page. */
  docs?: string;
  /** The link's words, when it isn't a help page. */
  docsLabel?: string;
  /** Added only on a computer: phone visitors get a way forward instead (Kazi, or send it later). */
  computerOnly?: boolean;
  /** The home page's Connect box: one line of how, and the one thing to copy. */
  home?: { how: string; line: string };
};

const json = (v: unknown) => JSON.stringify(v, null, 2);

const cursorConfig = btoa(JSON.stringify({ url: MCP_URL }));

/** How the video gets in, said at the end of every app's steps. */
export const VIDEO_IN_CHAT = 'Attach your video in the chat. ChatGPT hands it to cuttingfloor.';
export const VIDEO_IN_LINK =
  'Your AI gives you a link to send the video from your phone or computer.';

const APPS: Client[] = [
  {
    slug: 'kazi',
    name: 'Kazi',
    ours: true,
    where: 'Web, phone, text and meetings',
    steps: [
      'Open Kazi at app.apifunnel.ai.',
      'Ask Kazi: “Connect the cuttingfloor MCP server at https://api.cuttingfloor.ai/mcp”.',
      'Sign in when the cuttingfloor page opens. Kazi can now edit.',
      'If Kazi doesn’t connect it, open Servers, add your own server, paste the address and choose Connect.',
    ],
    snippets: [
      { label: 'Say to Kazi', code: `Connect the cuttingfloor MCP server at ${MCP_URL}` },
      { label: 'Server address', code: MCP_URL },
    ],
    docs: 'https://kazi.apifunnel.ai',
    docsLabel: 'About Kazi',
    home: {
      how: 'In Kazi (app.apifunnel.ai), ask it to connect the cuttingfloor MCP server at this address, then sign in.',
      line: MCP_URL,
    },
  },
  {
    slug: 'claude',
    computerOnly: true,
    name: 'Claude',
    where: 'claude.ai on the web and the desktop app',
    steps: [
      'Open Customize → Connectors, click + Add, then Add custom connector.',
      `Name it cuttingfloor and paste ${MCP_URL} as the URL. Click Continue.`,
      'Choose Sign in now (or Sign in when needed). If it asks about the OAuth client (how Claude signs in), keep Use Claude’s published identity.',
      'Click Add, and sign in on the page that opens.',
      'In a chat, open + → Connectors and turn cuttingfloor on.',
    ],
    snippets: [{ label: 'The address to paste', code: MCP_URL }],
    notes: [
      'Works on Free, Pro, Max, Ultra, Team and Enterprise. Free accounts get one custom connector.',
      'On Team and Enterprise, an owner adds it first under Organization settings → Connectors → Add → Custom → Web. Then each person clicks Connect under Customize → Connectors.',
      'The Claude phone apps use connectors you added on the web, but can’t add them.',
    ],
    docs: 'https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp',
    home: {
      how: 'Customize → Connectors → + → Add custom connector. Paste the address, then sign in.',
      line: MCP_URL,
    },
  },
  {
    slug: 'claude-cowork',
    computerOnly: true,
    name: 'Claude Cowork',
    where: 'The Claude desktop app, web and Chrome',
    steps: [
      'Add cuttingfloor as a connector in Claude, as above. Cowork uses the same connectors as your Claude account.',
      'Start a Cowork task and ask for the edit. It calls cuttingfloor’s tools as it works.',
    ],
    snippets: [{ label: 'The address to paste', code: MCP_URL }],
    notes: [
      'Cowork is on Pro, Max, Ultra, Team and Enterprise.',
      'On Team and Enterprise, Cowork asks you to approve each step that changes something, unless an admin turns on “Allow ‘Always allow’ for connector tools”.',
    ],
    docs: 'https://support.claude.com/en/articles/13455879-use-claude-cowork-on-team-and-enterprise-plans',
  },
  {
    slug: 'claude-code',
    name: 'Claude Code',
    where: 'Terminal',
    steps: [
      'Run the command below.',
      'Inside Claude Code, type /mcp and sign in on the page that opens.',
    ],
    snippets: [
      {
        label: 'Run in a terminal',
        code: `claude mcp add --transport http cuttingfloor ${MCP_URL}`,
      },
      {
        label: 'For everyone on a project (.mcp.json)',
        code: json({ mcpServers: { cuttingfloor: { type: 'http', url: MCP_URL } } }),
      },
    ],
    notes: [
      'Add --scope project to share it through the project’s .mcp.json, or --scope user for all your projects.',
    ],
    docs: 'https://code.claude.com/docs/en/mcp',
    home: {
      how: 'Run this, then /mcp to sign in.',
      line: `claude mcp add --transport http cuttingfloor ${MCP_URL}`,
    },
  },
  {
    slug: 'chatgpt',
    computerOnly: true,
    name: 'ChatGPT',
    where: 'chatgpt.com (add it on the web)',
    steps: [
      'Open chatgpt.com/plugins.',
      'Click +, then Add custom MCP server.',
      `Name it cuttingfloor. Under Connection, paste ${MCP_URL} as the Server URL.`,
      'Set Authentication to OAuth: the option that makes ChatGPT open the cuttingfloor sign-in page.',
      'Click I understand and want to continue, then Create as a plugin. Check the tools and click Install, and sign in when asked.',
      'In a chat, type @cuttingfloor and say what you want.',
    ],
    snippets: [{ label: 'The Server URL', code: MCP_URL }],
    notes: [
      CHATGPT_PLANS,
      'On Business, only admins and owners can add a custom MCP server. On Enterprise and Edu, admins and owners can, and an admin can let other members.',
      'Add it on chatgpt.com in a browser: OpenAI’s help page says custom MCP servers are web only.',
    ],
    docs: CHATGPT_HELP,
    home: {
      how: 'chatgpt.com/plugins → + → Add custom MCP server. Paste the address, set Authentication to OAuth (so ChatGPT opens our sign-in).',
      line: MCP_URL,
    },
  },
  {
    slug: 'chatgpt-work',
    computerOnly: true,
    name: 'ChatGPT Work',
    where: 'ChatGPT on the web and the desktop app',
    steps: [
      'Add cuttingfloor as a plugin in ChatGPT, as above.',
      'Start a Work task and type @cuttingfloor with the edit you want.',
    ],
    snippets: [
      {
        label: 'In a Work task',
        code: '@cuttingfloor cut this into a 30-second vertical clip with captions',
      },
    ],
    notes: ['Workspace admins choose which plugins Work can use.'],
    docs: 'https://learn.chatgpt.com/docs/get-started-with-work',
  },
  {
    slug: 'codex',
    name: 'Codex',
    where: 'CLI, IDE extension and the ChatGPT desktop app',
    steps: [
      'Run the first command below to add cuttingfloor.',
      'Run codex mcp login cuttingfloor and sign in in your browser.',
      'In the IDE extension: gear menu → MCP servers → add, then Restart extension.',
      'In the desktop app: Settings → MCP servers → Add server, choose Streamable HTTP, paste the address, Save and Restart, then click Authenticate.',
    ],
    snippets: [
      {
        label: 'Run in a terminal',
        code: `codex mcp add cuttingfloor --url ${MCP_URL}\ncodex mcp login cuttingfloor`,
      },
      {
        label: '~/.codex/config.toml',
        code: `[mcp_servers.cuttingfloor]\nurl = "${MCP_URL}"`,
      },
    ],
    notes: [
      'The CLI, the IDE extension and the desktop app share ~/.codex/config.toml, so adding it once covers all three.',
    ],
    docs: 'https://learn.chatgpt.com/docs/extend/mcp',
    home: {
      how: 'Run this, then codex mcp login cuttingfloor to sign in.',
      line: `codex mcp add cuttingfloor --url ${MCP_URL}`,
    },
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    where: 'Desktop editor',
    steps: [
      'Click Add to Cursor below, or paste the config into ~/.cursor/mcp.json (or .cursor/mcp.json in a project).',
      'Cursor opens the sign-in the first time it uses a tool.',
    ],
    snippets: [
      {
        label: '~/.cursor/mcp.json',
        code: json({ mcpServers: { cuttingfloor: { url: MCP_URL } } }),
      },
    ],
    install: {
      label: 'Add to Cursor',
      href: `cursor://anysphere.cursor-deeplink/mcp/install?name=cuttingfloor&config=${encodeURIComponent(cursorConfig)}`,
    },
    notes: ['Team admins can share it with everyone under Dashboard → Plugins & MCPs.'],
    docs: 'https://cursor.com/docs/context/mcp',
    home: {
      how: 'Add to ~/.cursor/mcp.json. Cursor opens the sign-in when you first use it.',
      line: `{ "mcpServers": { "cuttingfloor": { "url": "${MCP_URL}" } } }`,
    },
  },
  {
    slug: 'vs-code',
    name: 'VS Code / GitHub Copilot',
    where: 'VS Code with Copilot',
    steps: [
      'Open the Command Palette and run MCP: Add Server.',
      'Choose HTTP, paste the address, name it cuttingfloor and pick Global.',
      'Start it and sign in when VS Code asks.',
    ],
    snippets: [
      {
        label: 'Or run in a terminal',
        code: `code --add-mcp '${JSON.stringify({ name: 'cuttingfloor', type: 'http', url: MCP_URL })}'`,
      },
      {
        label: '.vscode/mcp.json',
        code: json({ servers: { cuttingfloor: { type: 'http', url: MCP_URL } } }),
      },
    ],
    notes: [
      'On Copilot Business and Enterprise, an admin has to turn on MCP servers in Copilot first (Settings → Copilot → Policies).',
    ],
    docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
  },
  {
    slug: 'antigravity',
    name: 'Antigravity CLI (Gemini)',
    where: 'Terminal and the Antigravity editor',
    steps: [
      'Add cuttingfloor to ~/.gemini/config/mcp_config.json (or .agents/mcp_config.json in a project).',
      'Run /mcp to check it’s there, and sign in when asked.',
      'In the Antigravity editor: … → MCP Servers → Manage MCP Servers → View raw config, and add the same lines.',
    ],
    snippets: [
      {
        label: '~/.gemini/config/mcp_config.json',
        code: json({ mcpServers: { cuttingfloor: { serverUrl: MCP_URL } } }),
      },
    ],
    notes: ['Antigravity CLI replaced Gemini CLI in June 2026. It uses serverUrl, not httpUrl.'],
    docs: 'https://antigravity.google/docs/mcp?tab=cli',
  },
  {
    slug: 'zed',
    name: 'Zed',
    where: 'Desktop editor',
    steps: [
      'Open Settings → AI → MCP Servers → Add Server → Add Remote Server, and paste the address.',
      'Or add the lines below to your settings.json.',
      'Zed opens the sign-in for you.',
    ],
    snippets: [
      {
        label: 'settings.json',
        code: json({ context_servers: { cuttingfloor: { url: MCP_URL } } }),
      },
    ],
    docs: 'https://zed.dev/docs/ai/mcp',
  },
  {
    slug: 'goose',
    name: 'Goose',
    where: 'Desktop app and CLI',
    steps: [
      'Click Add to Goose below, or in the desktop app open Extensions → Add custom extension.',
      'In the CLI, run goose configure → Add Extension → Remote Extension (Streamable HTTP), and paste the address.',
      'Goose opens the sign-in for you.',
    ],
    snippets: [
      {
        label: '~/.config/goose/config.yaml',
        code: [
          'extensions:',
          '  cuttingfloor:',
          '    name: cuttingfloor',
          '    type: streamable_http',
          `    uri: ${MCP_URL}`,
          '    enabled: true',
          '    timeout: 300',
        ].join('\n'),
      },
    ],
    install: {
      label: 'Add to Goose',
      href: `goose://extension?url=${encodeURIComponent(MCP_URL)}&type=streamable_http&id=cuttingfloor&name=cuttingfloor&description=${encodeURIComponent('Headless video editor')}`,
    },
    docs: 'https://goose-docs.ai/docs/getting-started/using-extensions',
  },
  {
    slug: 'any',
    name: 'Any MCP client',
    where: 'Anything that takes a remote MCP server',
    steps: [
      `Add a remote server at ${MCP_URL}. It speaks Streamable HTTP.`,
      'Your app opens the cuttingfloor sign-in page (OAuth). Sign in, and it’s connected.',
      'For a script with no browser, make a key on your account page (it starts with cf_) and send it as a header instead.',
      `Code that doesn’t speak MCP calls the same tools as plain HTTP with the same key: POST ${API_URL}/v1/<tool>, every tool described at ${API_URL}/openapi.json.`,
    ],
    snippets: [
      {
        label: 'Most apps (mcpServers)',
        code: json({ mcpServers: { cuttingfloor: { url: MCP_URL } } }),
      },
      {
        label: 'A script, with a key from your account page',
        code: json({
          mcpServers: {
            cuttingfloor: { url: MCP_URL, headers: { Authorization: 'Bearer cf_…' } },
          },
        }),
      },
      {
        label: 'Plain HTTP, with the same key',
        code: `curl ${API_URL}/v1/timeline.create \\
  -H 'Authorization: Bearer cf_…' -H 'Content-Type: application/json' \\
  -d '{"name": "First edit", "sequence": {"width": 1080, "height": 1920, "fps": {"num": 30, "den": 1}}}'`,
      },
    ],
  },
];

/** Every app, its steps ending with how the video gets in. */
export const CLIENTS: Client[] = APPS.map((c) => ({
  ...c,
  steps: [...c.steps, c.slug.startsWith('chatgpt') ? VIDEO_IN_CHAT : VIDEO_IN_LINK],
}));

/** The ones on the home page's Connect box, in order. */
export const HOME_CLIENTS = CLIENTS.filter(
  (c): c is Client & { home: NonNullable<Client['home']> } => c.home !== undefined,
);
