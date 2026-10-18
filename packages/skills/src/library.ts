import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SKILL_LIMITS,
  type SkillRelated,
  SkillRelationship,
  SkillSlug,
} from '@cuttingfloor/schema';

// The skills library: skills/<slug>.md, parsed and checked against one-mcp's playbook contract
// (packages/shared/src/playbooks/frontmatter.ts there). Every file is checked when the library
// loads, so a broken skill fails the test that loads them, not a user's agent.

/** skills/ at the repo root; in the image, /app/skills. Bundlers (the site) pass their own. */
export const skillsDir = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills');

/** The body's sections, in this order. */
export const SKILL_SECTIONS = [
  'When to use',
  'Prerequisites',
  'Steps',
  'Decision table',
  'Required behavior',
] as const;

/** Narrative sections a skill must not have: a skill is facts and steps only. */
export const REJECTED_HEADINGS = [
  'history',
  'background',
  'why we built',
  'lessons learned',
  'journey',
] as const;

export interface Skill {
  slug: string;
  name: string;
  description: string;
  version: number;
  type: 'playbook';
  source: 'system';
  /** Only relations to skills in the library; see `dangling` for the rest. */
  related: SkillRelated[];
  hidden: boolean;
  /** The H1, without the `# `. */
  title: string;
  /** Everything after the frontmatter. */
  body: string;
  /** The whole file, frontmatter included, as an agent should read it. */
  markdown: string;
}

export interface Library {
  /** Every skill, hidden ones included, sorted by slug. */
  skills: Skill[];
  /**
   * Relations that name a skill not written yet. Allowed, so a skill can point at one that is
   * coming; they appear in `related` once that file lands.
   */
  dangling: Array<{ from: string; to: string }>;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** `slug:relationship, …`; a bare slug is `related`. */
export function parseRelated(raw: string | undefined): SkillRelated[] {
  const out: SkillRelated[] = [];
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const colon = entry.lastIndexOf(':');
    const slug = colon > 0 ? entry.slice(0, colon).trim() : entry;
    const relationship = colon > 0 ? entry.slice(colon + 1).trim() : 'related';
    if (!SkillSlug.safeParse(slug).success) throw new Error(`related: "${slug}" is not a slug`);
    const rel = SkillRelationship.safeParse(relationship);
    if (!rel.success) {
      throw new Error(
        `related: "${relationship}" for ${slug} must be one of ${SkillRelationship.options.join(', ')}`,
      );
    }
    out.push({ slug, relationship: rel.data });
  }
  return out;
}

function frontmatterFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    const key = trimmed.slice(0, colon);
    if (colon < 1 || !/^[a-zA-Z0-9_-]+$/.test(key)) continue;
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

/**
 * Parses one skill file and checks it against the contract. Throws an Error listing every
 * problem, so one run shows the author all of them.
 */
export function parseSkill(raw: string, slug: string): Skill {
  const errors: string[] = [];
  const text = raw.replace(/^﻿/, '');
  const match = FRONTMATTER_RE.exec(text.trim());
  if (!match) throw new Error(`${slug}: must start with frontmatter (--- name, description ---)`);
  const fields = frontmatterFields(match[1] as string);
  const body = (match[2] as string).trim();

  if (!SkillSlug.safeParse(slug).success) {
    errors.push('the file name must be lowercase letters, digits and hyphens');
  }
  const name = fields.name ?? '';
  if (!name) errors.push('frontmatter requires name');
  else if (name !== slug) errors.push(`name "${name}" must match the file name "${slug}"`);
  const description = fields.description ?? '';
  if (!description) errors.push('frontmatter requires description');
  if (description.length > SKILL_LIMITS.descriptionChars) {
    errors.push(`description must be at most ${SKILL_LIMITS.descriptionChars} characters`);
  }
  const version = Number(fields.version);
  if (!fields.version || !Number.isFinite(version) || version < 1) {
    errors.push('version must be a positive number (bump it on every change)');
  }
  if (fields.type !== 'playbook') errors.push('type must be "playbook"');
  if (fields.source !== 'system') errors.push('source must be "system"');
  if (fields.hidden !== undefined && fields.hidden !== 'true' && fields.hidden !== 'false') {
    errors.push('hidden must be true or false');
  }
  let related: SkillRelated[] = [];
  try {
    related = parseRelated(fields.related);
  } catch (error) {
    errors.push((error as Error).message);
  }
  if (related.some((r) => r.slug === slug)) errors.push('related must not name the skill itself');

  if (Buffer.byteLength(text, 'utf8') > SKILL_LIMITS.bytes) {
    errors.push(`the file must be at most ${SKILL_LIMITS.bytes / 1024} KB`);
  }
  const lines = body.split(/\r?\n/);
  if (lines.length >= SKILL_LIMITS.bodyLines) {
    errors.push(`the body must be under ${SKILL_LIMITS.bodyLines} lines`);
  }
  const title = /^#(?!#)\s+(\S.*)$/.exec((lines[0] ?? '').trim())?.[1]?.trim() ?? '';
  if (!title) errors.push('the body must begin with a title (# <title>)');
  errors.push(...checkSections(lines));

  if (errors.length) throw new Error(`${slug}: ${errors.join('; ')}`);
  return {
    slug,
    name,
    description,
    version,
    type: 'playbook',
    source: 'system',
    related,
    hidden: fields.hidden === 'true',
    title,
    body,
    markdown: `${text.trim()}\n`,
  };
}

/** The ## sections: all present, in order, none narrative; Steps numbered, Decision a table. */
function checkSections(lines: string[]): string[] {
  const errors: string[] = [];
  const found: Array<{ heading: string; content: string[] }> = [];
  for (const line of lines) {
    const heading = /^##\s/.test(line) ? line.slice(2).trim() : '';
    if (heading) found.push({ heading, content: [] });
    else found.at(-1)?.content.push(line);
  }
  for (const { heading } of found) {
    const lower = heading.toLowerCase();
    if (REJECTED_HEADINGS.some((r) => lower.startsWith(r))) {
      errors.push(`no narrative sections ("## ${heading}"): a skill is facts and steps only`);
    }
  }
  const order = found.map((f) => SKILL_SECTIONS.indexOf(f.heading as never)).filter((i) => i >= 0);
  for (const [i, section] of SKILL_SECTIONS.entries()) {
    if (!order.includes(i)) errors.push(`missing section "## ${section}"`);
  }
  if (order.some((v, i) => i > 0 && v < (order[i - 1] as number))) {
    errors.push(`sections must come in this order: ${SKILL_SECTIONS.join(', ')}`);
  }
  const content = (heading: string) =>
    found.find((f) => f.heading === heading)?.content.filter((l) => l.trim()) ?? [];
  const steps = content('Steps').filter((l) => /^\d+\.\s/.test(l));
  if (!steps.length) errors.push('Steps must be a numbered list');
  for (const step of steps) {
    if (!/^\d+\.\s+The assistant should\b/.test(step)) {
      errors.push(`each step starts "The assistant should": "${step.slice(0, 60)}"`);
    }
  }
  if (!content('Decision table').some((l) => l.trim().startsWith('|'))) {
    errors.push('Decision table must hold a table (| Situation | Do |)');
  }
  return errors;
}

/** Reads and checks every skill in `dir`. Throws on the first broken file. */
export function loadLibrary(dir: string = skillsDir()): Library {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const parsed = files.map((f) => parseSkill(readFileSync(join(dir, f), 'utf8'), f.slice(0, -3)));
  const slugs = new Set(parsed.map((s) => s.slug));
  const dangling: Library['dangling'] = [];
  const skills = parsed.map((s) => {
    for (const r of s.related) if (!slugs.has(r.slug)) dangling.push({ from: s.slug, to: r.slug });
    return { ...s, related: s.related.filter((r) => slugs.has(r.slug)) };
  });
  return { skills, dangling };
}
