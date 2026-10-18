import { createHash } from 'node:crypto';
import { copyFile, link, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { mediaInfo } from '@cuttingfloor/engine';
import {
  CfError,
  CODE_DENIED_TOOLS,
  CodeRunInput,
  CodeRunResult,
  type ToolError,
  withJob,
} from '@cuttingfloor/schema';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import { runCodeInSandbox } from '../code.ts';
import { DATA_EXTENSIONS, outputMime } from '../mime.ts';
import { guard, jobReply, ok } from '../result.ts';
import { createServer, type ServerDeps } from '../server.ts';

// code.run: a script in the sandbox, sharing the workspace with the tools. Its tool calls run
// here, through the same server as every other call (same validation, ids and errors), as the
// owner who started the job. Files it writes to out/ come back as media, or as timelines when
// named *.timeline.json.

const deny = new Set<string>(CODE_DENIED_TOOLS);
/** The names motion() and still() write when the script gives no out. */
const PLACEHOLDER = /^(motion|still)-\d+\.(mov|mp4|png)$/;

/** An MCP client to a fresh server instance acting as `owner`, for the script's tool calls. */
async function ownerClient(deps: ServerDeps, owner: string): Promise<Client> {
  const server = createServer({ ...deps, owner: () => owner });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'code.run', version: '1' });
  await client.connect(clientSide);
  return client;
}

export function registerCodeTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;
  server.registerTool(
    'code.run',
    {
      title: 'Run code',
      description: [
        'Run a script (node, python or bash) in the sandbox for anything the tools do not cover: generated graphics, procedural or data-driven edits, custom FFmpeg or MLT work, batch jobs.',
        "Inside, `import { cf } from 'cuttingfloor'` (python `from cuttingfloor import cf`; bash `cf domain.verb '{json}'`) calls every tool except code.run, create.motion and create.still as cf.domain.verb(args), on the same media and timelines, following long jobs to their result: each call returns that tool's output schema (for a long-running tool, its finished result), so a script can chain calls on those fields. In node, motion({html, duration, width, height, fps, transparent, out}) and still({html, width, height, out}) from the same module render pages right there and return the file's path; out names it (e.g. 'out/title.mov').",
        'inputs are fetched into in/; files written to out/ come back as media (video, audio, images, fonts, LUTs), out/*.timeline.json as timelines (the timeline.get JSON), and text or data (vtt, srt, json, txt, csv, …) as files. Every output has a signed download url; one that cannot be kept is marked failed with the reason, and the others and stdout are still returned.',
        'Preinstalled: Node 24, Python 3 (numpy, Pillow, OpenCV), FFmpeg, melt, Chromium. No network.',
        'Long-running: a task, or {job_id} for job.get. A non-zero exit fails with code_failed and the logs.',
      ].join(' '),
      inputSchema: CodeRunInput,
      outputSchema: withJob(CodeRunResult),
      annotations: {
        title: 'Run code',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const store = rt.jobs.store;
      if (args.idempotency_key) {
        const existing = await store.findIdempotent(owner, 'code.run', args.idempotency_key);
        if (existing) return jobReply(existing, ctx);
      }
      const scriptHash = createHash('sha256').update(args.script).digest('hex').slice(0, 16);
      const job = await store.create({
        owner,
        tool: 'code.run',
        meta: { script: scriptHash },
        statusMessage: 'starting',
        ...(args.idempotency_key ? { idempotencyKey: args.idempotency_key } : {}),
      });
      rt.jobs.start(
        job,
        async ({ signal, progress }) => {
          const client = await ownerClient(deps, owner);
          const scratch = rt.ws.ownerDir(owner, 'code', job.id);
          await mkdir(scratch, { recursive: true });
          // out/ files land with the job's outputs, where their download links point.
          const outDir = rt.ws.ownerDir(owner, 'outputs', job.id);
          await mkdir(outDir, { recursive: true });
          try {
            const run = await runCodeInSandbox(
              rt.config.motionUrl,
              {
                language: args.language,
                script: args.script,
                timeout_seconds: args.timeout_seconds,
                inputs: [
                  ...args.inputs.media_ids.map((media_id) => ({ media_id })),
                  ...args.inputs.timeline_ids.map((timeline_id) => ({ timeline_id })),
                ],
              },
              {
                call: async (tool, callArgs) => {
                  if (deny.has(tool)) {
                    throw new CfError('bad_request', `${tool} can't be called from code.run`);
                  }
                  return client.callTool({ name: tool, arguments: callArgs });
                },
                file: async (ref) => {
                  if (ref.media_id) {
                    const record = await rt.media.get(owner, ref.media_id);
                    if (record.status !== 'ready' || !record.file) {
                      throw new CfError(
                        'media_not_ready',
                        `Media ${ref.media_id} is still importing`,
                      );
                    }
                    return {
                      name: `${record.media_id}${extname(record.file).slice(0, 8)}`,
                      path: record.file,
                    };
                  }
                  const id = ref.timeline_id ?? '';
                  const got = (await client.callTool({
                    name: 'timeline.get',
                    arguments: { timeline_id: id },
                  })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
                  if (got.isError) {
                    const e = got.structuredContent as { code: never; message: string };
                    throw new CfError(e?.code ?? 'not_found', e?.message ?? `No timeline ${id}`);
                  }
                  return {
                    name: `${id}.timeline.json`,
                    data: Buffer.from(JSON.stringify(got.structuredContent, null, 2)),
                  };
                },
                output: async (name) => join(outDir, name),
                scratch: async (name) => join(scratch, name),
                upload: async (name, path) =>
                  mediaInfo(
                    await importFile(
                      name,
                      path,
                      `${scriptHash}\0${job.id}\0up:${name}`,
                      signal,
                      'move',
                    ),
                  ),
              },
              (f, m) => progress(0.05 + 0.85 * f, m),
              signal,
            );
            const logs = { stdout: run.stdout, stderr: run.stderr };
            if (run.exit_code !== 0) {
              throw new CfError(
                'code_failed',
                run.signal
                  ? `The script was killed (${run.signal})`
                  : `The script exited with ${run.exit_code}`,
                {
                  hint: 'Read stderr, fix the script and run it again; nothing in out/ was kept',
                  detail: { exit_code: run.exit_code, ...logs },
                },
              );
            }
            const outputs: z.infer<typeof CodeRunResult>['outputs'] = [];
            for (const [i, f] of run.files.entries()) {
              progress(0.9 + (0.1 * i) / run.files.length, `importing out/${f.name}`);
              outputs.push(await keep(f, scriptHash, job.id, signal));
            }
            const unnamed = outputs.map((o) => o.name).filter((n) => PLACEHOLDER.test(n));
            const warnings = unnamed.length
              ? [
                  `${unnamed.join(', ')} kept the placeholder name motion() and still() give when no out is passed. To name what a page renders, pass out: motion({html, duration, out: 'out/<name>.mov'}) (.mp4 with transparent: false), still({html, out: 'out/<name>.png'}).`,
                ]
              : [];
            return ok({
              exit_code: run.exit_code,
              outputs,
              ...logs,
              seconds: run.seconds,
              ...(warnings.length ? { warnings } : {}),
            }) as never;
          } finally {
            await client.close().catch(() => undefined);
            await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
          }
        },
        { lane: 'sandbox' },
      );

      /**
       * A file the script made, as new media through the normal import. An out/ file stays where
       * its download link points (a hard link, so no second copy); an upload moves.
       */
      async function importFile(
        name: string,
        path: string,
        key: string,
        signal: AbortSignal,
        how: 'move' | 'link',
      ) {
        const recipe = createHash('sha256').update(key).digest('hex');
        const record = await rt.media.create(owner, { created: 'code.run', recipe }, name);
        const dest = join(
          rt.media.dir(owner, record.media_id),
          `source${extname(name).slice(0, 8)}`,
        );
        if (how === 'move') await rename(path, dest);
        else await link(path, dest).catch(() => copyFile(path, dest));
        record.file = dest;
        return rt.media.ingest(owner, record, () => undefined, signal);
      }

      /**
       * One out/ file: a timeline, new media through the normal import, or (text and data) a
       * file. Each comes with a signed download link to the file as the script wrote it. One that
       * fails is marked failed with its cause; the rest are kept either way.
       */
      async function keep(
        f: { name: string; path: string } | { name: string; error: ToolError },
        script: string,
        jobId: string,
        signal: AbortSignal,
      ): Promise<z.infer<typeof CodeRunResult>['outputs'][number]> {
        if ('error' in f) return { name: f.name, type: 'failed', error: f.error };
        const link = async () => {
          const { url, expiresAt } = await rt.signOutput(owner, jobId, f.name);
          return {
            url,
            expires_at: expiresAt,
            bytes: (await stat(f.path)).size,
            mime_type: outputMime(f.name),
          };
        };
        try {
          if (f.name.endsWith('.timeline.json')) {
            let timeline: unknown;
            try {
              timeline = JSON.parse(await readFile(f.path, 'utf8'));
            } catch {
              throw new CfError('bad_request', `out/${f.name} is not JSON`);
            }
            const client = await ownerClient(deps, owner);
            try {
              const loaded = (await client.callTool({
                name: 'timeline.load',
                arguments: { timeline },
              })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
              if (loaded.isError) {
                const e = loaded.structuredContent as {
                  code: never;
                  message: string;
                  hint?: string;
                };
                throw new CfError(
                  e.code,
                  `out/${f.name}: ${e.message}`,
                  e.hint ? { hint: e.hint } : {},
                );
              }
              return {
                name: f.name,
                type: 'timeline',
                timeline_id: loaded.structuredContent?.timeline_id as string,
                ...(await link()),
              };
            } finally {
              await client.close().catch(() => undefined);
            }
          }
          if (DATA_EXTENSIONS.has(extname(f.name).toLowerCase())) {
            return { name: f.name, type: 'file', ...(await link()) };
          }
          const done = await importFile(
            f.name,
            f.path,
            `${script}\0${jobId}\0${f.name}`,
            signal,
            'link',
          );
          const info = mediaInfo(done);
          return {
            name: f.name,
            type: 'media',
            media_id: done.media_id,
            ...(info.kind ? { kind: info.kind } : {}),
            ...(await link()),
          };
        } catch (error) {
          const e =
            error instanceof CfError
              ? error
              : new CfError('engine_error', (error as Error).message ?? String(error));
          // The file itself is still there to download, whatever went wrong with it.
          const kept = await link().catch(() => undefined);
          return { name: f.name, type: 'failed', error: e.toJSON(), ...(kept ?? {}) };
        }
      }
      return jobReply(job, ctx);
    }),
  );
}
