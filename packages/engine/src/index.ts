/**
 * Engines, each run as a subprocess so a crash or hang never takes the server down:
 * FFmpeg for probe, conform, proxies and analysis; MLT's `melt` for timeline frames and exports.
 * See plans/spec.md §7–§8.
 */

export { type Loudness, measureMix, renderMix, renderWaveform } from './audio.ts';
export { analyseBeats, type Beats, estimateTempo, onsetEnvelope, trackBeats } from './beats.ts';
export { compositeFor, rotoFilters } from './composite.ts';
export { crossCorrelate, fft, type Offset } from './correlate.ts';
export { gradientPosition, type MatteSpec, renderMatte } from './create.ts';
export { alignGroups, forcedAlign, logSoftmax, W2V_LABELS, wordTokens } from './ctc.ts';
export {
  CUTOUT_MODELS,
  type CutoutModel,
  type CutoutSource,
  cutout,
  matteSize,
  segmentSize,
} from './cutout.ts';
export { detectScenes, detectSilences } from './detect.ts';
export {
  BIN,
  engineVersions,
  installedFonts,
  renderLoad,
  run,
  setRenderLimit,
  watchRenderQueue,
} from './exec.ts';
export { directDownloadUrl, download, isBlockedAddress } from './fetch.ts';
export {
  fingerprint,
  hasAlpha,
  MEDIA_TTL_MS,
  type MediaConfig,
  MediaLibrary,
  type MediaRecord,
  mayBeTransparent,
  mediaInfo,
  mediaOrigin,
  mediaRef,
  type Progress,
  renderPicture,
  renderSource,
} from './media.ts';
export { compileMlt, lengthFrames, type MltSource, scaledSize } from './mlt.ts';
export {
  fitBox,
  type Overrides,
  PRESET_NAMES,
  PRESETS,
  type PresetName,
  presetCatalog,
  resolvePreset,
} from './presets.ts';
export { conformReasons, type Probe, probe, standardRate } from './probe.ts';
export {
  type CutFact,
  type CutWord,
  cutFacts,
  type QaOptions,
  type QaReport,
  qaCheck,
} from './qa.ts';
export {
  exportTimeline,
  type ImageFormat,
  imageExtension,
  mediaStills,
  renderMediaFrames,
  renderTimelineFrames,
} from './render.ts';
export {
  clipPasses,
  DENOISE_MODELS,
  passedAudio,
  type SourcePass,
  sourceKey,
} from './sourcepass.ts';
export {
  ALIGN_LANGUAGES,
  type AlignedWord,
  alignTranscriptWords,
  extractSound,
  fitWords,
  type LoudnessFacts,
  measureLoudness,
  noAudio,
  parseLoudness,
  SPEECH_MODELS,
  type SpeechProbabilities,
  soundOffset,
  speechProbabilities,
  speechSpans,
} from './speech.ts';
export { type StabilizeOptions, stabilize } from './stabilize.ts';
export {
  ensureModel,
  type Transcript,
  transcribe,
  WHISPER_MODELS,
  type WhisperModel,
} from './transcribe.ts';
export { detectFaces, type Faces, type TrackPoint, trackRegion } from './vision.ts';
export {
  alignWords,
  ensureVoiceModel,
  KOKORO,
  speak,
  type Voice,
  voiceWords,
} from './voice.ts';
