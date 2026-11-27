import { join } from 'node:path';
import { barsBetween, positionAt, scoreEnd, secondsToBeats } from '@cuttingfloor/core';
import { type MediaRecord, MUSIC_LIMITS, mediaInfo } from '@cuttingfloor/engine';
import {
  CfError,
  SCORE_RENDER_BARS,
  ScoreRenderFacts,
  ScoreRenderInput,
  ScoreRenderResult,
  withJob,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard } from '../result.ts';
import { renderScoreSound } from '../score-render.ts';
import type { ServerDeps } from '../server.ts';
import { mediaCreator } from './create.ts';

/** Where a render's facts are kept with the media it made, so a repeat of the same render has them. */
const FACTS = 'score-render.json';

export function registerScoreRenderTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;
  const create = mediaCreator(deps);

  server.registerTool(
    'score.render',
    {
      title: 'Render score',
      description: `Hear a score: render it, or a range of it, to audio media. parts renders only those (the rest silent), to hear one layer or a few on their own. Returns a media_id (usable once complete: for clip.add, media.analyze and media.listen; media.get has its download url) and render: the loudness (integrated LUFS and true peak dBTP), clipped_samples (over full scale: above 0 the mix is too loud), the part_ids that sounded (after mute, solo and parts), and bars: where each bar starts in beats, seconds and frames. The render stops at until_beats; with tail_db it runs on until the sound falls under that level (notes and reverb ring on after the last beat; up to ${MUSIC_LIMITS.tailSeconds} s more) and returns ends_seconds, when it did. Rendered at the score's sample_rate, stereo, as 24-bit WAV (default) or MP3; never watermarked. The same score and range give the same audio. Long-running: a task, or {job_id, media_id} for job.get.`,
      inputSchema: ScoreRenderInput,
      outputSchema: withJob(ScoreRenderResult),
      annotations: {
        title: 'Render score',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const doc = await rt.scores.get(owner, args.score_id);
      const from =
        args.from_seconds !== undefined
          ? secondsToBeats(doc.tempo, args.from_seconds)
          : (args.from_beats ?? 0);
      const end = scoreEnd(doc);
      const until =
        args.until_seconds !== undefined
          ? secondsToBeats(doc.tempo, args.until_seconds)
          : (args.until_beats ?? end);
      if (args.until_beats === undefined && args.until_seconds === undefined && end <= 0) {
        throw new CfError(
          'bad_request',
          'This score has no regions, so it has no end to render to',
          {
            hint: 'Give until_beats, or place a region with score.add_region first',
          },
        );
      }
      if (!(until > from)) {
        throw new CfError(
          'bad_request',
          `The range ends (beat ${until}) at or before it starts (beat ${from})`,
        );
      }
      const recipe = {
        score_id: args.score_id,
        from_beats: from,
        until_beats: until,
        parts: args.parts ? [...args.parts].sort() : null,
        format: args.format,
        tail_db: args.tail_db ?? null,
      };
      let facts: ScoreRenderFacts | undefined;
      const read = async (record: MediaRecord): Promise<ScoreRenderFacts> => {
        const text = await rt.media.readDerived(owner, record.media_id, FACTS);
        if (!text) {
          throw new CfError(
            'not_found',
            `Media ${record.media_id} has no render facts kept with it`,
          );
        }
        return ScoreRenderFacts.parse(JSON.parse(text));
      };
      return create(
        ctx,
        'score.render',
        { name: args.name ?? doc.name, idempotency_key: args.idempotency_key },
        recipe,
        async (dir, progress, signal) => {
          progress(0.1, 'rendering');
          const sound = await renderScoreSound(rt, owner, doc, {
            from_beats: from,
            until_beats: until,
            ...(args.parts ? { parts: args.parts } : {}),
            ...(args.tail_db !== undefined ? { tail_db: args.tail_db } : {}),
            format: args.format,
            dest: join(dir, `source.${args.format}`),
            signal,
          });
          const bars = barsBetween(doc, from, until, SCORE_RENDER_BARS + 1);
          facts = {
            score_id: args.score_id,
            from: positionAt(doc, from),
            until: positionAt(doc, until),
            length_seconds: sound.render.length_seconds,
            loudness: {
              integrated_lufs: sound.render.loudness.integrated_lufs,
              true_peak_dbtp: sound.render.loudness.true_peak_dbtp,
            },
            clipped_samples: sound.render.clipped_samples,
            parts_sounded: sound.parts_sounded,
            ...(sound.render.ends_seconds !== undefined
              ? { ends_seconds: sound.render.ends_seconds }
              : {}),
            ...(sound.render.tail_capped !== undefined
              ? { tail_capped: sound.render.tail_capped }
              : {}),
            bars: bars.slice(0, SCORE_RENDER_BARS),
            ...(bars.length > SCORE_RENDER_BARS ? { bars_truncated: true } : {}),
          };
          return sound.file;
        },
        async (record) => {
          if (facts) {
            await rt.media.writeDerived(owner, record.media_id, JSON.stringify(facts), FACTS);
          }
          return record;
        },
        'engine',
        Object.keys(doc.media),
        positionAt(doc, until).seconds,
        async (record) => ({ ...mediaInfo(record), render: await read(record) }),
      );
    }),
  );
}
