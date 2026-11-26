import {
  SKILL_MATCH_MIN,
  SkillsGetInput,
  SkillsGetResult,
  SkillsSearchInput,
  SkillsSearchResult,
} from '@cuttingfloor/schema';
import { findSkill, skills } from '@cuttingfloor/skills';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard, ok } from '../result.ts';

// skills.search and skills.get: how to compose the tools for a common job, written down once
// (skills/*.md). Not editing primitives; discovery of how to use them (AGENTS.md).

/** The skill for checking an edit against the user's request; results met before delivery name it. */
export const QA_SKILL = 'how-to-qa-a-video-or-image-edit-before-delivery';

export const QA_SKILL_NOTE = `Before it goes to the user, check it against their request with the QA skill: skills.get {slug: "${QA_SKILL}"}.`;

/**
 * The skills that fit a request in the user's words, best first: at or above `min` (skills.search's
 * own floor unless a caller asks for a looser one).
 */
export async function matchingSkills(
  query: string,
  min = SKILL_MATCH_MIN,
): Promise<Array<{ slug: string; name: string; description: string }>> {
  const { index } = await skills();
  return (await index.search(query, index.list().length))
    .filter((m) => m.score >= min)
    .map((m) => ({ slug: m.slug, name: m.name, description: m.description }));
}

export function registerSkillTools(server: McpServer): void {
  // Start loading now, so the first search does not wait for the model. A broken library
  // surfaces as the tools' error, not as an unhandled rejection.
  skills().catch(() => undefined);

  server.registerTool(
    'skills.search',
    {
      title: 'Find a skill',
      description:
        "Find step-by-step instructions for a common job, written for you to follow with these tools: cutting the pauses, ums and restarts out of a talking video, for one. Search in the user's words: the skills that fit come back, best first. When none fits, or with no query, the answer is the list of every skill, a page at a time, to choose from by description. Read one with skills.get, then follow its Steps.",
      inputSchema: SkillsSearchInput,
      outputSchema: SkillsSearchResult,
      annotations: {
        title: 'Find a skill',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args) => {
      const { index } = await skills();
      const all = index.list();
      const hits = args.query ? await matchingSkills(args.query) : [];
      const answer = hits.length ? hits : all;
      const next = args.offset + args.limit;
      return ok({
        matched: hits.length > 0,
        skills: answer.slice(args.offset, next),
        total: answer.length,
        next_offset: next < answer.length ? next : null,
      });
    }),
  );

  server.registerTool(
    'skills.get',
    {
      title: 'Read a skill',
      description:
        'The whole skill as Markdown: when to use it, what it needs, numbered Steps naming the tools to call, a decision table and the rules to keep. Follow the Steps in order.',
      inputSchema: SkillsGetInput,
      outputSchema: SkillsGetResult,
      annotations: {
        title: 'Read a skill',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args) => {
      const { library } = await skills();
      const s = findSkill(library.skills, args.slug);
      return ok({
        slug: s.slug,
        name: s.name,
        description: s.description,
        version: s.version,
        author: s.author,
        author_url: s.authorUrl,
        related: s.related,
        markdown: s.markdown,
      });
    }),
  );
}
