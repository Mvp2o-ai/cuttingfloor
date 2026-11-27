import { RECORD_LIMITS, ScoreRecordInput, ScoreRecordResult, span } from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { openRecordSession } from '../record.ts';
import { RECORD_TOOL_META } from '../record-view.ts';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

// score.record: a performance from the user over a loop of a score (record.ts holds the session,
// the two calls the view or the phone app plays it through, and the placing of the take).

const L = RECORD_LIMITS;
const n = (x: number) => x.toLocaleString('en-US');

export const SCORE_RECORD_DESCRIPTION = `Take a performance from the user into a score: pads they tap, or their microphone, while a range of the score plays in a loop under them. click adds a click on each beat; count_in_beats plays that many clicks before the take starts. A chat app that displays this server's views shows it in the chat: a pad for each pitch in pads, or a record button, and a slider that slows or speeds what they hear while they play (the score's tempo is not changed); anywhere else the url in the result opens the same in a browser. Returns at once a url and a job_id; the take arrives through job.get once they send it: a new score_id and the region_id of a new region on the part over the loop's range, where it sits in beats, seconds and frames, and the delay the device took off each position. Taps come back as that region's notes, each at the exact beat it was played on, nothing moved to a grid: a tap on a later pass of the loop lands that many loop lengths on, one in the count-in before the loop; those are stored outside the region, silent until it is widened, and listed. pads names the pitches that get a pad; velocity is what a tap is stored with where the device measures none (most phones), length_beats each note's length; pads need all three. A microphone take comes back as an audio region and its media_id: the recording as made, its first sample on the beat that was heard; recorded over a speaker it holds the loop too, and the result gives where cross-correlation finds the loop in it beside the device's own placing. One take a session; a session waits ${span(L.sessionMs)}. Limits of the platform: a loop up to ${L.loopSeconds} s at the speed played, ${n(L.taps)} taps, ${L.passes} passes, ${L.pads} pads, a microphone take up to ${L.microphoneSeconds} s, ${L.sessionsOpen} sessions waiting at once, speed ${L.speed.min} to ${L.speed.max}.`;

export function registerScoreRecordTool(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'score.record',
    {
      title: 'Record a take',
      description: SCORE_RECORD_DESCRIPTION,
      inputSchema: ScoreRecordInput,
      outputSchema: ScoreRecordResult,
      _meta: RECORD_TOOL_META,
      annotations: {
        title: 'Record a take',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guard(async (args) =>
      ok(
        await openRecordSession(
          { runtime: deps.runtime, renderScoreDoc: deps.renderScoreDoc, limits: deps.limits },
          deps.owner(),
          args,
        ),
      ),
    ),
  );
}
