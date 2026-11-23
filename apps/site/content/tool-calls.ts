// The MCP tool calls a guide or fix uses, for the "MCP tool calls" section: which tools an agent
// calls for the job and what each does in it. Names are the server's (content/tools.ts); a test
// fails on a name the server doesn't list.

export type ToolCall = {
  /** The tool's name, e.g. `clip.trim`, with the mode in brackets where it matters. */
  tool: string;
  /** What it does in this job. */
  does: string;
};

/** The section's words, in each language a page comes in. */
export const TOOL_CALLS_TEXT = {
  en: {
    label: 'MCP tool calls',
    heading: 'What your agent calls.',
    note: 'The cuttingfloor tools this job uses, in order. Your agent picks them; you just ask.',
    all: 'Every tool',
  },
  es: {
    label: 'Llamadas MCP',
    heading: 'Lo que llama tu agente.',
    note: 'Las herramientas de cuttingfloor que usa este trabajo, en orden. Tu agente las elige; tú solo pides.',
    all: 'Todas las herramientas',
  },
} as const;

/** The section as Markdown, for a page's twin. */
export const toolCallsMarkdown = (tools: ToolCall[], lang: 'en' | 'es') =>
  `## ${TOOL_CALLS_TEXT[lang].label}\n\n${TOOL_CALLS_TEXT[lang].note}\n\n${tools.map((c, i) => `${i + 1}. \`${c.tool}\`: ${c.does}`).join('\n')}`;

/** The bare tool name in a call: `media.analyze (colour)` is `media.analyze`. */
export const toolName = (call: ToolCall) => call.tool.split(' ')[0] as string;

/** AI video generators whose clips (ordinary MP4 or MOV files) any page here works with. */
export const GENERATORS = [
  'Kling',
  'Veo',
  'Sora',
  'Runway',
  'Hailuo (MiniMax)',
  'Pika',
  'Luma Dream Machine',
  'Seedance',
  'Wan',
  'Midjourney video',
  'Higgsfield',
  'PixVerse',
  'Vidu',
  'Grok Imagine',
] as const;

export const GENERATORS_LINE = `${GENERATORS.slice(0, -1).join(', ')} or ${GENERATORS.at(-1)}`;
