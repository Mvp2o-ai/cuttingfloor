# syntax=docker/dockerfile:1
# One image for every role: hosted nodes, render workers and local mode. Everything the
# server needs (Node, FFmpeg, MLT's melt) is in here, so the only thing a user installs is
# Docker. Builds for linux/amd64 and linux/arm64.
#
# Engines come from Debian trixie (FFmpeg 7.1, MLT 7.30) on a base image pinned by digest;
# Dependabot moves the digest. video://server/health reports the exact engine versions.

# whisper.cpp for local transcripts, built from a pinned commit (v1.9.5) for any CPU of the
# target architecture. Its models download on first use, checked against pinned SHA-256s.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS whisper
ARG WHISPER_COMMIT=d2a764c648779feb36d44363f212a29b00aad1af
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && git clone --filter=blob:none https://github.com/ggml-org/whisper.cpp /src \
 && git -C /src checkout "$WHISPER_COMMIT" \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DGGML_OPENMP=OFF \
 && cmake --build /src/build -j"$(nproc)" --target whisper-cli \
 && strip /src/build/bin/whisper-cli && /src/build/bin/whisper-cli --help >/dev/null

# cf-vision (tools/vision): face detection and region tracking for media.analyze, built
# against the OpenCV the MLT packages already bring, plus the YuNet face model (MIT), pinned.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS vision
ARG YUNET_URL=https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
ARG YUNET_SHA256=8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ pkg-config libopencv-dev libopencv-contrib-dev curl ca-certificates
COPY tools/vision/vision.cpp /src/vision.cpp
RUN g++ -O2 -std=c++17 /src/vision.cpp -o /cf-vision $(pkg-config --cflags --libs opencv4) \
 && strip /cf-vision \
 && curl -fsSL -o /yunet.onnx "$YUNET_URL" \
 && echo "$YUNET_SHA256  /yunet.onnx" | sha256sum -c -

FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg melt tini fontconfig \
      fonts-dejavu-core fonts-inter fonts-montserrat fonts-open-sans fonts-lato fonts-bebas-neue \
      fonts-lobster fonts-comic-neue fonts-firacode fonts-noto-core \
 && rm -rf /var/lib/apt/lists/* \
 # Web font copies are useless to libass, and Montserrat ships twice; one TrueType set stays.
 && find /usr/share/fonts -name '*.woff*' -delete && rm -rf /usr/share/fonts/opentype/montserrat \
 && fc-cache -f \
 && fc-list : family | grep -q '^Inter' \
 && ffmpeg -hide_banner -encoders | grep -q prores_ks \
 && melt -query transitions | grep -q qtblend \
 && melt -query filters | grep -q rotoscoping
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=vision /cf-vision /usr/local/bin/cf-vision
COPY --from=vision /yunet.onnx /usr/share/cuttingfloor/models/face_detection_yunet_2023mar.onnx
RUN cf-vision 2>&1 | grep -q usage
# MLT's Qt modules (qtblend) need a display variable to load; Qt itself renders offscreen.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true QT_QPA_PLATFORM=offscreen DISPLAY=:0
RUN corepack enable
WORKDIR /app

FROM base AS build
# The pnpm store is a BuildKit cache mount: warm locally, empty on a fresh CI runner even when
# layers come from cache, so installs prefer the store but may download.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prefer-offline --frozen-lockfile

# Test-only: espeak-ng speaks the transcript fixtures, and the tiny whisper model is fetched
# once here (checksummed) so test runs don't download it.
FROM build AS testenv
USER root
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/models \
 && curl -fsSL -o /opt/models/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin \
 && echo "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21  /opt/models/ggml-tiny.bin" | sha256sum -c -
ENV CUTTINGFLOOR_MODELS=/opt/models

# `docker build --target test .` runs lint, typecheck and every test, engine tests included.
FROM testenv AS test
# Slower CI hosts may relax the preview latency budget by this factor.
ARG CUTTINGFLOOR_BENCH_SCALE=1
ENV CUTTINGFLOOR_REQUIRE_ENGINES=1 CUTTINGFLOOR_BENCH_SCALE=$CUTTINGFLOOR_BENCH_SCALE
RUN pnpm check

FROM build AS prod
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    rm -rf node_modules packages/*/node_modules apps/*/node_modules \
 && pnpm install --prefer-offline --frozen-lockfile --prod

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 CUTTINGFLOOR_DATA=/data CUTTINGFLOOR_MEDIA_ROOTS=/media,/samples
COPY --from=prod --chown=node:node /app /app
# Sample media so a first run can import, edit and export with nothing mounted.
RUN mkdir -p /samples \
 && ffmpeg -v error -f lavfi -i testsrc2=size=1920x1080:rate=25 -f lavfi -i sine=frequency=440:beep_factor=4 \
      -t 10 -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -shortest /samples/sample.mp4 \
 && ffmpeg -v error -f lavfi -i "color=c=0x1d3557:size=1920x1080,drawbox=x=160:y=440:w=1600:h=200:color=0xe63946:t=fill" \
      -frames:v 1 /samples/card.png
RUN chmod +x apps/cli/src/main.ts \
 && ln -s /app/apps/cli/src/main.ts /usr/local/bin/cuttingfloor \
 && mkdir -p /data /media /exports && chown node:node /data /media /exports
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["cuttingfloor", "serve"]
