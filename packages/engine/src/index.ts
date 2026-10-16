/**
 * Engine adapter. MLT runs in a native frame worker (native/frame-worker); FFmpeg and
 * HyperFrames run as sandboxed subprocess job workers. Each is its own process.
 * See plans/spec.md §3 and §8.
 */
export interface EngineAdapter {
  frame(input: {
    projectId: string;
    revision: number;
    frame: number;
    longEdge: number;
  }): Promise<Uint8Array>;
}
