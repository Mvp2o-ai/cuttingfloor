import { describe, expect, it } from 'vitest';
import { clock, recordingExtension, recordingName } from '../app/account/recording.ts';

describe('a recording from the upload page', () => {
  it('is named for when it was made and for what the browser recorded', () => {
    const at = new Date(2026, 10, 27, 9, 5);
    // Chrome, Safari and iOS, Firefox: the container each records, kept as it is.
    expect(recordingName('audio/webm;codecs=opus', at)).toBe('recording-2026-11-27-0905.webm');
    expect(recordingName('audio/mp4;codecs=mp4a.40.2', at)).toBe('recording-2026-11-27-0905.m4a');
    expect(recordingName('audio/ogg;codecs=opus', at)).toBe('recording-2026-11-27-0905.ogg');
    expect(recordingExtension('')).toBe('.webm');
    expect(clock(65.9)).toBe('1:05');
  });
});
