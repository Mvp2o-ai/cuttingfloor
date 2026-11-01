// The site's tool list (apps/site/content/tools.ts) is written from the live registry: tools/list
// over the SDK client, plus the catalogues the tools accept. This test fails when the file is out
// of date, or when a tool has no plain line on /features. To rewrite the file:
//
//   pnpm vitest run packages/server/test/site-tools.test.ts -u
//
// The site imports the file, not the server: a Vercel build never starts a runtime.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BLEND_MODES,
  EFFECTS,
  HIGHLIGHTS,
  IN_OUT_ANIMATIONS,
  LOOP_ANIMATIONS,
  MASK_SHAPES,
  TEXT_REVEALS,
  TRANSITION_KINDS,
} from '@cuttingfloor/schema';
import { describe, expect, it } from 'vitest';
import { connect, testRuntime } from './helpers.ts';

const FILE = fileURLToPath(new URL('../../../apps/site/content/tools.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// Read at run time: the site is outside this package's TypeScript project.
const LINES_URL = new URL('../../../apps/site/app/features/lines.ts', import.meta.url).href;

type Listed = {
  name: string;
  title?: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: string[] }> };
};

const q = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
const list = (xs: readonly string[]) => `[${xs.map(q).join(', ')}]`;

/** always: every call is a job; sometimes: short calls answer at once; never: answers at once. */
function longRunning(description: string): 'always' | 'sometimes' | 'never' {
  if (/\bLong-running\b/.test(description)) return 'always';
  if (/longer ones return a task/.test(description)) return 'sometimes';
  return 'never';
}

function render(tools: Listed[]): string {
  const choices = (tool: string, arg: string) => {
    const values = tools.find((t) => t.name === tool)?.inputSchema.properties?.[arg]?.enum;
    if (!values) throw new Error(`${tool} has no ${arg} choices`);
    return values;
  };
  const effects = (kind: 'video' | 'audio') =>
    Object.entries(EFFECTS)
      .filter(([, e]) => e.kind === kind)
      .map(([name]) => name);
  return [
    '// Generated from the server tool registry (tools/list) and the catalogues its tools accept.',
    '// Do not edit by hand: packages/server/test/site-tools.test.ts fails when this is out of date.',
    '// Rewrite it with: pnpm vitest run packages/server/test/site-tools.test.ts -u',
    '',
    'export type ToolEntry = {',
    '  name: string;',
    '  title: string;',
    '  /** The tool only reads: nothing is changed or made. */',
    '  readOnly: boolean;',
    '  /** always: runs as a job; sometimes: short calls answer at once; never: answers at once. */',
    "  longRunning: 'always' | 'sometimes' | 'never';",
    '};',
    '',
    'export const TOOLS: ToolEntry[] = [',
    ...tools.map((t) =>
      [
        '  {',
        `    name: ${q(t.name)},`,
        `    title: ${q(t.title ?? t.name)},`,
        `    readOnly: ${Boolean(t.annotations?.readOnlyHint)},`,
        `    longRunning: ${q(longRunning(t.description ?? ''))},`,
        '  },',
      ].join('\n'),
    ),
    '];',
    '',
    '/** How many tools the server lists: say this number instead of writing one. */',
    'export const TOOL_COUNT = TOOLS.length;',
    '',
    `export const ANALYSES = ${list(choices('media.analyze', 'kind'))};`,
    `export const EXPORT_PRESETS = ${list(choices('export.video', 'preset'))};`,
    `export const TIMELINE_FORMATS = ${list(choices('export.timeline', 'format'))};`,
    `export const VIDEO_EFFECTS = ${list(effects('video'))};`,
    `export const AUDIO_EFFECTS = ${list(effects('audio'))};`,
    `export const TRANSITIONS = ${list(TRANSITION_KINDS)};`,
    `export const BLEND_MODES = ${list(BLEND_MODES)};`,
    `export const MASK_SHAPES = ${list(MASK_SHAPES)};`,
    `export const ANIMATIONS = ${list(IN_OUT_ANIMATIONS)};`,
    `export const LOOPS = ${list(LOOP_ANIMATIONS)};`,
    `export const TEXT_REVEALS = ${list(TEXT_REVEALS)};`,
    `export const HIGHLIGHTS = ${list(HIGHLIGHTS)};`,
    '',
  ].join('\n');
}

/** The file as Biome formats it, so `pnpm check` and this test agree on every byte. */
function format(source: string): string {
  return execFileSync(
    'pnpm',
    ['exec', 'biome', 'format', '--stdin-file-path=apps/site/content/tools.ts'],
    {
      cwd: ROOT,
      input: source,
      encoding: 'utf8',
    },
  );
}

describe('the site tool list', () => {
  it('matches the live registry', async () => {
    const env = await testRuntime();
    const client = await connect(env.runtime);
    const { tools } = (await client.listTools()) as { tools: Listed[] };
    await expect(format(render(tools))).toMatchFileSnapshot(FILE);

    // Every tool has a plain line and a group on /features, and no line names a tool that's gone.
    const { LINES } = (await import(LINES_URL)) as { LINES: Record<string, unknown> };
    expect(Object.keys(LINES).sort()).toEqual(tools.map((t) => t.name).sort());
  }, 30_000);
});
