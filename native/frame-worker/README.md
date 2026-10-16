# Frame worker (native)

C++ against a self-built, pinned MLT (mlt++) and FFmpeg. One MLT pipeline per worker process, a producer pool keyed by media fingerprint, graphs rebuilt from a revision. It talks to `packages/engine` over a framed IPC protocol on stdio.

Not started. See `plans/spec.md` §3 and §8.
