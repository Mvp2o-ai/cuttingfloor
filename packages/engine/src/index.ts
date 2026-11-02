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
  type CutoutRegion,
  type CutoutSource,
  cutout,
  matteSize,
  segmentSize,
} from './cutout.ts';
export { detectScenes, detectSilences } from './detect.ts';
export { excerptPicture, excerptSound, type Span } from './excerpt.ts';
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
export { fontMeasure, loadFace, type Measure } from './fontmetrics.ts';
export { type ClipPlacement, clipPlacements, type PixelBox } from './geometry.ts';
export {
  fingerprint,
  hasAlpha,
  MEDIA_TTL_MS,
  type MediaConfig,
  MediaLibrary,
  type MediaRecord,
  makingJob,
  mayBeTransparent,
  mediaInfo,
  mediaOrigin,
  mediaRef,
  notReady,
  type Progress,
  renderPicture,
  renderSource,
} from './media.ts';
export { compileMlt, lengthFrames, type MltSource, scaledSize } from './mlt.ts';
export {
  type Box,
  type ChannelStats,
  type ColourStats,
  colourStats,
  mediaRgbFrames,
  type PictureSeries,
  parseSignalstats,
  pictureSeries,
  pngsToRgb,
  type RgbFrame,
  renderPictureFile,
} from './picture.ts';
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
  measureVoice,
  VOICE_FRAME_SECONDS,
  VOICE_METHOD,
  type VoiceFrame,
  type VoiceSeries,
  type VoiceSummary,
  voiceSeries,
} from './prosody.ts';
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
  isMade,
  type MatteSource,
  passFrames,
  type SelectionPass,
  type SelectionSource,
  selectedFile,
  selectedPicture,
  selectionPass,
} from './selection.ts';
export {
  detectSounds,
  type FrameScores,
  listenFor,
  listenText,
  peakOf,
  SOUND_MODELS,
  SOUND_RATE,
  type SoundSpan,
  scoreAt,
  scoreSeries,
  seriesStep,
  soundSpans,
  splitStems,
} from './sounds.ts';
export {
  betweenFile,
  betweenFrames,
  betweenPicture,
  betweenStart,
  clipPasses,
  DENOISE_MODELS,
  passedAudio,
  type SourcePass,
  sourceKey,
} from './sourcepass.ts';
export {
  diarize,
  numberSpeakers,
  parseTurns,
  SPEAKER_MODELS,
  type Speakers,
  type SpeakerTurn,
  wordSpeakers,
} from './speakers.ts';
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
export {
  UPSCALE_MODEL,
  UPSCALE_MODELS,
  type UpscaleDenoise,
  type UpscaleOptions,
  upscale,
} from './upscale.ts';
export { detectFaces, type Faces, type TrackPoint, trackRegion } from './vision.ts';
export {
  alignWords,
  ensureVoiceModel,
  KOKORO,
  speak,
  type Voice,
  voiceWords,
} from './voice.ts';
