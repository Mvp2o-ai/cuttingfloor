/**
 * Engines, each run as a subprocess so a crash or hang never takes the server down:
 * FFmpeg for probe, conform, proxies and analysis; MLT's `melt` for timeline frames and exports.
 * See plans/spec.md §7–§8.
 */

export { compositeFor, rotoFilters } from './composite.ts';
export { BIN, engineVersions, installedFonts, run } from './exec.ts';
export { download, isBlockedAddress } from './fetch.ts';
export {
  fingerprint,
  hasAlpha,
  MEDIA_TTL_MS,
  type MediaConfig,
  MediaLibrary,
  type MediaRecord,
  mediaInfo,
  mediaRef,
  type Progress,
  renderPicture,
  renderSource,
} from './media.ts';
export { compileMlt, lengthFrames, type MltSource, scaledSize } from './mlt.ts';
export { conformReasons, type Probe, probe, standardRate } from './probe.ts';
export { type QaReport, qaCheck } from './qa.ts';
export { exportTimeline, PRESETS, renderMediaFrames, renderTimelineFrames } from './render.ts';
