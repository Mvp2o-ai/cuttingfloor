import { randomUUID } from 'node:crypto';
import { type MediaRecord, mediaStills, renderSource } from '@cuttingfloor/engine';
import {
  CfError,
  JUDGE_LIMITS,
  JudgeAskInput,
  JudgeAskResult,
  JudgePicture,
  type JudgeQuestion,
} from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { askJev, JEV_URL, type JevImage } from '../jev.ts';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';
import { addUsage, checkQuota } from '../usage.ts';

// judge.ask: one Jev call about a state you give, entry by entry: text, JSON and pictures (an
// image, or a video frame). media.analyze look uses the same questions, key and limits per frame.

/** Daily usage on the server's own TypeSafe key: one shared budget for judge.ask and look. */
export const JUDGMENTS = 'judgments';

/** How pictures are sent: the same size for a look frame and a judge.ask picture. */
export const PICTURE = { longEdge: 512, minEdge: 280 } as const;

export function jevKeyRequired(tool: string): CfError {
  return new CfError('credential_required', `${tool} needs a TypeSafe API key on this server`, {
    detail: { provider: 'typesafe', env: 'TYPESAFE_API_KEY' },
    hint: 'Add TYPESAFE_API_KEY=<key> (from typesafe.ai) to the .env next to compose.yaml, then docker compose up -d',
  });
}

/** Refuses a question count outside 1 to the limit, with an example to copy. */
export function checkQuestions(
  tool: string,
  questions: Record<string, unknown> | undefined,
  max: number = JUDGE_LIMITS.questions,
) {
  const n = Object.keys(questions ?? {}).length;
  if (n && n <= max) return;
  throw new CfError('bad_request', `${tool} needs 1 to ${max} questions; got ${n}`, {
    hint:
      n > max
        ? 'Split the questions across calls with the same state'
        : 'questions: {is_filler: {type: "noul", instructions: "Is the word marked [[like this]] in `passage` a filler word?"}}',
  });
}

/** Refuses text state too long to fit Jev's context with questions beside it. */
export function checkText(state: Record<string, unknown>): void {
  const chars = JSON.stringify(state).length;
  if (chars <= JUDGE_LIMITS.textChars) return;
  throw new CfError(
    'limit_exceeded',
    `The text in state is ${chars} characters; a call takes up to ${JUDGE_LIMITS.textChars}`,
    { hint: 'Split the state across calls: a passage or a few sentences at a time' },
  );
}

/** The picture's upright size, which stills are scaled from. */
export function pictureSize(record: MediaRecord): { width: number; height: number } {
  const v = record.probe?.video;
  if (!v) return { width: 0, height: 0 };
  return v.rotation % 180
    ? { width: v.height, height: v.width }
    : { width: v.width, height: v.height };
}

/**
 * Units of the shared budget a judge.ask call takes, on look's scale (a frame with up to 32
 * questions is one): one per 32 questions, plus one for each picture past the first.
 */
export const judgeUnits = (questions: number, pictures: number) =>
  Math.ceil(questions / JUDGE_LIMITS.lookQuestions) + Math.max(0, pictures - 1);

export function registerJudgeTools(server: McpServer, deps: ServerDeps): void {
  const rt = deps.runtime;

  /** A ready media's picture: the image itself, or a video's frame at a time. */
  const picture = async (
    owner: string,
    name: string,
    ref: { media_id: string; at_seconds?: number | undefined },
  ): Promise<{ record: MediaRecord; time: number }> => {
    const record = await rt.media.get(owner, ref.media_id);
    if (record.status !== 'ready') {
      throw new CfError('media_not_ready', `Media ${ref.media_id} is still importing`, {
        hint: 'Wait for its media.import job to finish',
      });
    }
    const p = record.probe;
    if (!p?.video) {
      throw new CfError('bad_request', `${name}: media ${ref.media_id} has no picture`, {
        hint: 'A picture entry is an image, or a video with at_seconds',
      });
    }
    if (p.kind === 'image') return { record, time: 0 };
    const duration = p.duration ?? 0;
    if (ref.at_seconds === undefined) {
      throw new CfError('bad_request', `${name}: media ${ref.media_id} is a video`, {
        hint: `Name the frame: {media_id: "${ref.media_id}", at_seconds: <0 to ${duration}>}`,
      });
    }
    if (duration && ref.at_seconds >= duration) {
      throw new CfError(
        'bad_request',
        `${name}: ${ref.at_seconds} s is past the end of the media (${duration} s)`,
        { hint: `Pick a time from 0 up to ${duration} s` },
      );
    }
    return { record, time: ref.at_seconds };
  };

  server.registerTool(
    'judge.ask',
    {
      title: 'Ask Jev',
      description: [
        'Ask TypeSafe Jev, a fast judgment model (preview), your questions about a state you give, and get typed answers back in about a second.',
        'Jev sees exactly the state: each entry under its name, and your questions refer to entries by name in backticks ("in `passage`"). An entry is text (a string, or a JSON object or array of related facts) or a picture: {media_id} for an imported image, {media_id, at_seconds} for the frame of a video at that time. Mix them freely. Each call stands alone, so put everything a judgment needs into its state.',
        'Choose the type by the answer you need. noul: yes or no, answered as noul, the probability of yes from 0 to 1 (0.5 or more reads as yes). choice: one of options you name, answered as choice plus probabilities and confidence. score: a degree on levels you order, answered as score (0 is the first level) plus confidence. box: where one thing is in a picture, answered as box {x, y, w, h} in fractions of that picture plus confidence.',
        'Write each question as one thing, worded so yes means it is there. Open with what the state is ("`passage` is a transcript of someone speaking off the cuff"), and give a noul criteria {true, false} with an example of each: Jev answers most accurately from examples. To locate, name the one thing so only it fits ("the yellow headline \'Get started\' at the top of `shot`") and ask a noul whether it is there; trust a box with high confidence.',
        'One call answers many questions about one state at once, so judge many items together: put the shared text in state once, and give each item its own question carrying its own marked copy. Filler words: state {passage: "So basically the way this works is"}, and per word a noul "`passage` is a transcript of someone speaking off the cuff. With one word marked: "So [[basically]] the way this works is". Is the marked word filler, so the sentence says the same without it?" with criteria {true: "the [[the]] report is late", false: "the report is [[late]]"}. A shot: state {shot: {media_id, at_seconds: 12.5}}, choice "What fills `shot`?" with options {speaker: "A person talking to camera", screen: "A screen recording", none: "Anything else"}. Both: state {line: "Click Get started", screen: {media_id, at_seconds: 4}}, noul "Does `screen` show the button `line` talks about?".',
        `Up to ${JUDGE_LIMITS.questions} questions, ${JUDGE_LIMITS.images} pictures and ${JUDGE_LIMITS.textChars / 1000}k characters of text a call. In code.run, cf.judge.ask(...) in a loop judges a transcript passage by passage. To judge a video over time, media.analyze look asks your questions of frames it samples. Guide to writing questions: https://docs.typesafe.ai/primitives and https://docs.typesafe.ai/images.`,
      ].join('\n'),
      inputSchema: JudgeAskInput,
      outputSchema: JudgeAskResult,
      annotations: {
        title: 'Ask Jev',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (args, ctx) => {
      const owner = deps.owner();
      const key = await deps.credentials.resolve(owner, 'typesafe');
      if (!key) throw jevKeyRequired('judge.ask');
      checkQuestions('judge.ask', args.questions);
      const text: Record<string, unknown> = {};
      const refs: Array<[string, { media_id: string; at_seconds?: number | undefined }]> = [];
      for (const [name, entry] of Object.entries(args.state)) {
        const pic = JudgePicture.safeParse(entry);
        if (pic.success) refs.push([name, pic.data]);
        else text[name] = entry;
      }
      if (refs.length > JUDGE_LIMITS.images) {
        throw new CfError(
          'limit_exceeded',
          `state holds ${refs.length} pictures; a call takes up to ${JUDGE_LIMITS.images}`,
          { hint: 'Split the pictures across calls, asking the same questions of each' },
        );
      }
      checkText(text);
      const units = judgeUnits(Object.keys(args.questions).length, refs.length);
      await checkQuota(rt.ws, owner, JUDGMENTS, units, rt.config.judgmentsPerDay, {
        unit: 'judgments (one per 32 questions a call, plus one for each picture past the first)',
        hint: 'Ask fewer pictures a call, or keep all your questions about one state in one call',
      });
      const signal =
        (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal ??
        new AbortController().signal;
      const found = await Promise.all(refs.map(([name, ref]) => picture(owner, name, ref)));
      const images: JevImage[] = await Promise.all(
        found.map(async ({ record, time }, i) => {
          const [jpeg] = await mediaStills(
            renderSource(record, 'export'),
            pictureSize(record),
            [time],
            { ...PICTURE, signal },
          );
          return { name: (refs[i] as [string, unknown])[0], jpeg: jpeg as Buffer };
        }),
      );
      const reply = await askJev({
        base: rt.config.typesafeUrl ?? JEV_URL,
        key,
        images,
        state: text,
        questions: args.questions as Record<string, JudgeQuestion>,
        signal,
      });
      await addUsage(rt.ws, owner, JUDGMENTS, `ja_${randomUUID()}`, units);
      return ok(reply);
    }),
  );
}
