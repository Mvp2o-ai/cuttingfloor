import type { TimelineDoc } from '@cuttingfloor/schema';
import { toSrt, toVtt } from './captions.ts';
import type { InterchangeMediaResolver, InterchangeResult } from './common.ts';
import { toEdl } from './edl.ts';
import { toFcpxml } from './fcpxml.ts';
import { toOtio } from './otio.ts';

export { cueTime, toSrt, toVtt } from './captions.ts';
export {
  type InterchangeMedia,
  type InterchangeMediaResolver,
  type InterchangeResult,
  isDropFrame,
  timecode,
} from './common.ts';
export { toEdl } from './edl.ts';
export { fcpTime, toFcpxml, xmlEscape } from './fcpxml.ts';
export { toOtio } from './otio.ts';

export const INTERCHANGE_FORMATS = ['fcpxml', 'otio', 'edl', 'srt', 'vtt'] as const;
export type InterchangeFormat = (typeof INTERCHANGE_FORMATS)[number];

/** File extension and media type of each format. */
export const INTERCHANGE_FILES: Record<InterchangeFormat, { ext: string; type: string }> = {
  fcpxml: { ext: 'fcpxml', type: 'application/xml' },
  otio: { ext: 'otio', type: 'application/json' },
  edl: { ext: 'edl', type: 'text/plain' },
  srt: { ext: 'srt', type: 'application/x-subrip' },
  vtt: { ext: 'vtt', type: 'text/vtt' },
};

/** Writes a timeline in one interchange format. Best effort: `warnings` lists what was dropped. */
export function writeInterchange(
  format: InterchangeFormat,
  doc: TimelineDoc,
  resolve: InterchangeMediaResolver,
): InterchangeResult {
  switch (format) {
    case 'fcpxml':
      return toFcpxml(doc, resolve);
    case 'otio':
      return toOtio(doc, resolve);
    case 'edl':
      return toEdl(doc, resolve);
    case 'srt':
      return toSrt(doc);
    case 'vtt':
      return toVtt(doc);
  }
}
