# syntax=docker/dockerfile:1
# One image for every role: hosted edit nodes, the render pool, and local mode.
# Everything the server needs (Node, and later FFmpeg, MLT, the frame worker,
# whisper.cpp, Chromium for HyperFrames) is pinned here, so the only thing a user
# installs is Docker. Builds for linux/amd64 (Hetzner) and linux/arm64 (Apple silicon).

FROM node:24-trixie-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile

# `docker build --target test .` runs lint, typecheck and tests inside the image.
FROM build AS test
RUN pnpm check

FROM build AS prod
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    rm -rf node_modules packages/*/node_modules apps/*/node_modules \
 && pnpm install --offline --frozen-lockfile --prod

# Native engines get their own builder stages (pinned sources, built once, copied in):
#   FROM ... AS ffmpeg        self-built FFmpeg (x264, SVT-AV1, libvpx, prores_ks, zimg)
#   FROM ... AS mlt           MLT 7.42 with Qt6 and rubberband, against that FFmpeg
#   FROM ... AS frame-worker  native/frame-worker (C++, mlt++)
#   FROM ... AS whisper       whisper.cpp release binary
# HyperFrames' pinned Chromium lands in the runtime stage with the motion worker.

FROM node:24-trixie-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 CUTTINGFLOOR_DATA=/data
WORKDIR /app
COPY --from=prod --chown=node:node /app /app
RUN chmod +x apps/cli/src/main.ts \
 && ln -s /app/apps/cli/src/main.ts /usr/local/bin/cuttingfloor \
 && mkdir -p /data /media /projects && chown node:node /data /media /projects
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["cuttingfloor", "serve"]
