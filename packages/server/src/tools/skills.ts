import {
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

export function registerSkillTools(server: McpServer): void {
  // Start loading now, so the first search does not wait for the model. A broken library
  // surfaces as the tools' error, not as an unhandled rejection.
  skills().catch(() => undefined);

  server.registerTool(
    'skills.search',
    {
      title: 'Find a skill',
      description:
        "Find step-by-step instructions for a common job, written for you to follow with these tools: cutting the pauses, ums and restarts out of a talking video, for one. Search in the user's words; matches come best first, scored 0 to 1, and none means no skill fits. Read one with skills.get, then follow its Steps.",
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
      const found = await index.search(args.query, args.limit);
      return ok({
        skills: found.map((m) => ({
          slug: m.slug,
          name: m.name,
          description: m.description,
          score: Math.round(m.score * 1000) / 1000,
        })),
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
        related: s.related,
        markdown: s.markdown,
      });
    }),
  );
}
