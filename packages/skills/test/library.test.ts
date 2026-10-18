import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_LIMITS } from '@cuttingfloor/schema';
import { loadLibrary, parseRelated, parseSkill } from '@cuttingfloor/skills';
import { describe, expect, it } from 'vitest';

// The skills contract (one-mcp's playbook format), and every skill in skills/ against it.

const front = (fields: Record<string, string>) =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n`;

const FIELDS = {
  name: 'add-captions',
  description: 'Add captions to a talking video. Use when someone asks for subtitles or captions.',
  version: '1',
  type: 'playbook',
  source: 'system',
};

const BODY = `# Add captions

## When to use
- Someone wants captions.

## Prerequisites
- The cuttingfloor MCP server is connected.

## Steps
1. The assistant should transcribe the video with \`media.analyze {kind: "transcript"}\`.
2. The assistant should add captions with \`caption.add {in_clip}\`.

## Decision table
| Situation | Do |
|---|---|
| No speech | Say so |

## Required behavior
- Never invent words.
`;

const skill = (fields: Record<string, string> = {}, body = BODY) =>
  front({ ...FIELDS, ...fields }) + body;

const problems = (raw: string, slug = 'add-captions') => {
  try {
    parseSkill(raw, slug);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('skill files', () => {
  it('parses the frontmatter, the title and the whole markdown', () => {
    const s = parseSkill(
      skill({ related: 'cut-pauses-ums-and-restarts:prerequisite' }),
      'add-captions',
    );
    expect(s).toMatchObject({
      slug: 'add-captions',
      name: 'add-captions',
      version: 1,
      type: 'playbook',
      source: 'system',
      hidden: false,
      title: 'Add captions',
      related: [{ slug: 'cut-pauses-ums-and-restarts', relationship: 'prerequisite' }],
    });
    expect(s.body.startsWith('# Add captions')).toBe(true);
    expect(s.markdown.startsWith('---\nname: add-captions')).toBe(true);
  });

  it('takes quoted values and hidden', () => {
    const s = parseSkill(
      skill({ description: '"Quoted: with a colon"', hidden: 'true' }),
      'add-captions',
    );
    expect(s.description).toBe('Quoted: with a colon');
    expect(s.hidden).toBe(true);
  });

  it('reads related as comma-separated slug:relationship, a bare slug as related', () => {
    expect(parseRelated('a-b:alternative, c:extends ,d')).toEqual([
      { slug: 'a-b', relationship: 'alternative' },
      { slug: 'c', relationship: 'extends' },
      { slug: 'd', relationship: 'related' },
    ]);
    expect(parseRelated(undefined)).toEqual([]);
    expect(() => parseRelated('a:cousin')).toThrow(/prerequisite, alternative, extends, related/);
    expect(() => parseRelated('Not A Slug:related')).toThrow(/not a slug/);
  });

  it('needs frontmatter', () => {
    expect(problems(BODY)).toMatch(/must start with frontmatter/);
  });

  it('checks every frontmatter field, and lists every problem at once', () => {
    const msg = problems(
      front({
        name: 'other',
        description: 'x'.repeat(SKILL_LIMITS.descriptionChars + 1),
        version: '0',
        type: 'skill',
        source: 'user',
      }) + BODY,
    );
    expect(msg).toMatch(/name "other" must match the file name "add-captions"/);
    expect(msg).toMatch(/description must be at most 1024/);
    expect(msg).toMatch(/version must be a positive number/);
    expect(msg).toMatch(/type must be "playbook"/);
    expect(msg).toMatch(/source must be "system"/);
    expect(problems(skill({ description: '' }))).toMatch(/requires description/);
    expect(problems(skill({ related: 'add-captions:related' }))).toMatch(
      /must not name the skill itself/,
    );
    expect(problems(skill({}), 'Add_Captions')).toMatch(/file name must be lowercase/);
  });

  it('needs a title and the five sections, in order', () => {
    expect(problems(skill({}, BODY.replace('# Add captions', 'Add captions')))).toMatch(
      /begin with a title/,
    );
    expect(problems(skill({}, BODY.replace('## Prerequisites', '## Before you start')))).toMatch(
      /missing section "## Prerequisites"/,
    );
    const swapped = BODY.replace('## When to use', '## TMP')
      .replace('## Required behavior', '## When to use')
      .replace('## TMP', '## Required behavior');
    expect(problems(skill({}, swapped))).toMatch(/must come in this order/);
  });

  it('rejects narrative sections', () => {
    expect(problems(skill({}, `${BODY}\n## Lessons learned\n- It was hard.\n`))).toMatch(
      /no narrative sections \("## Lessons learned"\)/,
    );
    expect(problems(skill({}, `${BODY}\n## Background\nOnce.\n`))).toMatch(/narrative/);
  });

  it('needs numbered steps in the assistant voice, and a decision table', () => {
    expect(
      problems(
        skill(
          {},
          BODY.replace('1. The assistant should', '- The assistant should').replace(
            '2. The assistant should',
            '- The assistant should',
          ),
        ),
      ),
    ).toMatch(/Steps must be a numbered list/);
    expect(problems(skill({}, BODY.replace('2. The assistant should add', '2. Add')))).toMatch(
      /each step starts "The assistant should"/,
    );
    expect(problems(skill({}, BODY.replace(/^\|.*\n/gm, '')))).toMatch(
      /Decision table must hold a table/,
    );
  });

  it('keeps a skill under 500 body lines and 64 KB', () => {
    const long = BODY.replace(
      '- Never invent words.',
      '- Never invent words.\n'.repeat(SKILL_LIMITS.bodyLines),
    );
    expect(problems(skill({}, long))).toMatch(/under 500 lines/);
    const big = BODY.replace('- Never invent words.', `- ${'x'.repeat(SKILL_LIMITS.bytes)}`);
    expect(problems(skill({}, big))).toMatch(/at most 64 KB/);
  });
});

describe('a library folder', () => {
  it('loads every file, keeping relations to skills not written yet out of related', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-skills-'));
    await writeFile(
      join(dir, 'add-captions.md'),
      skill({ related: 'reframe-to-vertical:related, trim-it:alternative' }),
    );
    await writeFile(
      join(dir, 'trim-it.md'),
      skill({ name: 'trim-it', description: 'Trim a video.' }).replace(
        '# Add captions',
        '# Trim it',
      ),
    );
    await writeFile(join(dir, 'notes.txt'), 'not a skill');
    const lib = loadLibrary(dir);
    expect(lib.skills.map((s) => s.slug)).toEqual(['add-captions', 'trim-it']);
    expect(lib.skills[0]?.related).toEqual([{ slug: 'trim-it', relationship: 'alternative' }]);
    expect(lib.dangling).toEqual([{ from: 'add-captions', to: 'reframe-to-vertical' }]);
  });

  it('fails on a broken file, naming it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-skills-'));
    await writeFile(join(dir, 'add-captions.md'), skill({ version: 'two' }));
    expect(() => loadLibrary(dir)).toThrow(/^add-captions: version must be a positive number/);
  });
});

describe('the skills in this repo', () => {
  const lib = loadLibrary();

  it('all meet the contract', () => {
    expect(lib.skills.length).toBeGreaterThan(0);
    expect(lib.skills.map((s) => s.slug)).toContain('cut-pauses-ums-and-restarts');
  });

  it('only point at skills that exist or are planned', () => {
    // The seed list in plans/skills-endpoint.md. A relation to anything else is a typo.
    const planned = new Set([
      'add-captions',
      'make-a-short-from-a-long-video',
      'reframe-to-vertical',
      'even-out-the-sound',
      'listing-clip-with-price-card',
      'tighten-a-long-interview',
      'code-authored-motion-graphics',
      'build-a-deck-as-video',
    ]);
    for (const d of lib.dangling) expect(planned, `${d.from} → ${d.to}`).toContain(d.to);
  });
});
