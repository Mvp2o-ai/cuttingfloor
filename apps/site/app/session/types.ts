// A scripted agent session, as data. The home page and every walkthrough render one of these
// through the same component, so a new session is a data change only.

export type Track = 'V2' | 'V1' | 'A1';

/** What a tool call's answer does to the preview and the tracks. */
export type Effect =
  | { type: 'timeline' }
  /**
   * Clips land on these tracks, at these seconds of the edit: one, or many at once split at
   * `cuts`. The V1 clips drive the timecode.
   */
  | { type: 'clip'; tracks: Track[]; from: number; to: number; cuts?: number[] }
  /** Captions land on a track; the preview starts showing them. */
  | { type: 'captions'; track: Track; from: number; to: number }
  | { type: 'loudness'; reading: string }
  | { type: 'qa'; checks: string[] }
  | { type: 'export'; file: string };

export type SessionStep =
  | { kind: 'user' | 'agent'; text: string }
  | {
      kind: 'call';
      fn: string;
      /** Compact, for the chat. */
      args: string;
      /** The arguments in full, for the written list of calls. Default: args. */
      full?: string;
      ret: string;
      effect?: Effect;
      /** Seconds the call takes to answer, if longer than a quick one. */
      wait?: number;
    };

export type SessionPreview = {
  aspect: '9:16' | '16:9';
  /** Seconds the track lanes span. */
  length: number;
  fps: number;
  /** Caption lines, a word at a time, shown once the captions land. */
  captions?: string[][];
};

export type SessionData = {
  /** The agent named in the chat header. */
  agent: string;
  steps: SessionStep[];
  preview: SessionPreview;
  tracks?: Track[];
};
