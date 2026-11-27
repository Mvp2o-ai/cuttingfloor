// What the upload page's Record needs outside React: whether this browser can record here, and
// what to call what it recorded. The recording is the browser's own (WebM/Opus in Chrome,
// Ogg/Opus in Firefox, MP4/AAC in Safari); nothing here changes it.

/** The file's extension, from what the browser says it recorded. */
export function recordingExtension(type: string): string {
  if (/mp4|aac|m4a/i.test(type)) return '.m4a';
  if (/ogg/i.test(type)) return '.ogg';
  if (/mpeg/i.test(type)) return '.mp3';
  return '.webm';
}

/** A recording's file name: when it was made, in the person's own time. */
export function recordingName(type: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `recording-${day}-${p(at.getHours())}${p(at.getMinutes())}${recordingExtension(type)}`;
}

/** m:ss */
export const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** Why a refused or missing microphone stopped the recording, in the person's words. */
export function refusal(name: string): string {
  if (name === 'missing') return 'This browser can’t record. Try Chrome, Safari or Firefox.';
  if (name === 'NotFoundError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError')
    return 'The microphone is busy in another app. Close it there and try again.';
  return 'The microphone was not allowed. Allow it for this page in your browser’s settings, then try again.';
}

/** Whether this page can record: a recorder, and a microphone not already refused. */
export async function canRecord(): Promise<'ok' | string> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder !== 'function')
    return 'missing';
  try {
    const state = (await navigator.permissions?.query({ name: 'microphone' as PermissionName }))
      ?.state;
    if (state === 'denied') return 'NotAllowedError';
  } catch {}
  return 'ok';
}

/** The microphone as it sounds: the browser's voice processing off, where it can be. */
export async function openMicrophone(): Promise<MediaStream> {
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: raw });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'OverconstrainedError' || name === 'TypeError') {
      return navigator.mediaDevices.getUserMedia({ audio: true });
    }
    throw error;
  }
}
