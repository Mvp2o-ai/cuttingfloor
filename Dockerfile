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
# MODNet (Apache-2.0) for create.cutout, pinned, then fixed to three working sizes for OpenCV DNN.
ARG MODNET_URL=https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx
ARG MODNET_SHA256=07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ pkg-config libopencv-dev libopencv-contrib-dev curl ca-certificates \
      python3-onnx
COPY tools/vision/modnet-static.py /src/modnet-static.py
RUN curl -fsSL -o /modnet.onnx "$MODNET_URL" \
 && echo "$MODNET_SHA256  /modnet.onnx" | sha256sum -c - \
 && mkdir /models && python3 /src/modnet-static.py /modnet.onnx /models
COPY tools/vision/vision.cpp /src/vision.cpp
RUN g++ -O2 -std=c++17 /src/vision.cpp -o /cf-vision $(pkg-config --cflags --libs opencv4) \
 && strip /cf-vision \
 && curl -fsSL -o /yunet.onnx "$YUNET_URL" \
 && echo "$YUNET_SHA256  /yunet.onnx" | sha256sum -c -
# cf-segment (tools/vision/segment.cpp): BiRefNet lite (MIT) for create.cutout of any subject,
# on ONNX Runtime's prebuilt CPU release for the target architecture. All pinned and checked.
ARG TARGETARCH
ARG ORT_VERSION=1.30.0
ARG ORT_AMD64_SHA256=a5ed5a3cac51fbb2e90da632ae43d19212faaa20e76484e62bcb7c23ddb3b3fd
ARG ORT_ARM64_SHA256=e16a27a8ed330bbc698df7330b0cf56e722f354e3bcc92118682c74ef3c3e3da
ARG BIREFNET_URL=https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx
ARG BIREFNET_SHA256=5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333
RUN case "$TARGETARCH" in \
      amd64) asset=x64; sum=$ORT_AMD64_SHA256 ;; \
      arm64) asset=aarch64; sum=$ORT_ARM64_SHA256 ;; \
      *) echo "unsupported $TARGETARCH" && exit 1 ;; \
    esac \
 && curl -fsSL -o /ort.tgz "https://github.com/microsoft/onnxruntime/releases/download/v$ORT_VERSION/onnxruntime-linux-$asset-$ORT_VERSION.tgz" \
 && echo "$sum  /ort.tgz" | sha256sum -c - \
 && mkdir -p /opt/onnxruntime && tar -xzf /ort.tgz -C /opt/onnxruntime --strip-components=1 \
 && curl -fsSL -o /models/birefnet-lite.onnx "$BIREFNET_URL" \
 && echo "$BIREFNET_SHA256  /models/birefnet-lite.onnx" | sha256sum -c -
COPY tools/vision/segment.cpp /src/segment.cpp
RUN g++ -O2 -std=c++17 /src/segment.cpp -o /cf-segment -I/opt/onnxruntime/include \
      $(pkg-config --cflags --libs opencv4) -L/opt/onnxruntime/lib -lonnxruntime \
      -Wl,-rpath,/opt/onnxruntime/lib \
 && strip /cf-segment

# sherpa-onnx's offline TTS for local voiceover (Kokoro voices; Apache-2.0, with espeak-ng
# built in), the prebuilt release for each architecture, checked against pinned SHA-256s. The
# Kokoro model downloads on first use, like the whisper models.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS tts
ARG TARGETARCH
ARG SHERPA_VERSION=v1.13.8
ARG SHERPA_AMD64_SHA256=c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4
ARG SHERPA_ARM64_SHA256=4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 \
 && case "$TARGETARCH" in \
      amd64) asset=linux-x64-shared; sum=$SHERPA_AMD64_SHA256 ;; \
      arm64) asset=linux-aarch64-shared-cpu; sum=$SHERPA_ARM64_SHA256 ;; \
      *) echo "unsupported $TARGETARCH" && exit 1 ;; \
    esac \
 && curl -fsSL -o /sherpa.tar.bz2 "https://github.com/k2-fsa/sherpa-onnx/releases/download/$SHERPA_VERSION/sherpa-onnx-$SHERPA_VERSION-$asset.tar.bz2" \
 && echo "$sum  /sherpa.tar.bz2" | sha256sum -c - \
 && mkdir -p /src /opt/sherpa-onnx/bin /opt/sherpa-onnx/lib \
 && tar -xjf /sherpa.tar.bz2 -C /src --strip-components=1 \
 && cp /src/bin/sherpa-onnx-offline-tts /opt/sherpa-onnx/bin/ \
 && cp -L /src/lib/libonnxruntime.so* /opt/sherpa-onnx/lib/ \
 && /opt/sherpa-onnx/bin/sherpa-onnx-offline-tts --help >/dev/null 2>&1 || /opt/sherpa-onnx/bin/sherpa-onnx-offline-tts 2>&1 | grep -qi usage

# all-MiniLM-L6-v2 (Apache-2.0) for skills.search: sentence embeddings on the CPU, int8 (about
# 23 MB), in the Transformers.js layout. It ships in the image; nothing downloads at run time, and
# without it search is keywords only. Each file's SHA-256 is checked when its sum is given; the
# step prints them, so pinning the revision to a commit means copying four lines.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS skills-model
ARG MINILM_REVISION=main
ARG MINILM_CONFIG_SHA256=
ARG MINILM_TOKENIZER_SHA256=
ARG MINILM_TOKENIZER_CONFIG_SHA256=
ARG MINILM_ONNX_SHA256=
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && dir=/models/Xenova/all-MiniLM-L6-v2 && mkdir -p "$dir/onnx" \
 && fetch() { \
      curl -fsSL -o "$dir/$1" "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/$MINILM_REVISION/$1" \
      && sha256sum "$dir/$1" \
      && { [ -z "$2" ] || echo "$2  $dir/$1" | sha256sum -c -; }; \
    } \
 && fetch config.json "$MINILM_CONFIG_SHA256" \
 && fetch tokenizer.json "$MINILM_TOKENIZER_SHA256" \
 && fetch tokenizer_config.json "$MINILM_TOKENIZER_CONFIG_SHA256" \
 && fetch onnx/model_quantized.onnx "$MINILM_ONNX_SHA256"

FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg melt tini fontconfig \
      fonts-dejavu-core fonts-inter fonts-montserrat fonts-open-sans fonts-lato fonts-bebas-neue \
      fonts-lobster fonts-comic-neue fonts-firacode fonts-noto-core chromium bzip2 \
      python3 python3-numpy python3-pil python3-opencv zip \
 && rm -rf /var/lib/apt/lists/* \
 # Web font copies are useless to libass, and Montserrat ships twice; one TrueType set stays.
 && find /usr/share/fonts -name '*.woff*' -delete && rm -rf /usr/share/fonts/opentype/montserrat \
 && fc-cache -f \
 && fc-list : family | grep -q '^Inter' \
 && ffmpeg -hide_banner -encoders | grep -q prores_ks \
 && melt -query transitions | grep -q qtblend \
 && melt -query filters | grep -q rotoscoping \
 && chromium --version \
 && python3 -c 'import numpy, PIL, cv2' \
 && unshare --version
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=tts /opt/sherpa-onnx /opt/sherpa-onnx
RUN ln -s /opt/sherpa-onnx/bin/sherpa-onnx-offline-tts /usr/local/bin/sherpa-onnx-offline-tts
COPY --from=vision /cf-vision /usr/local/bin/cf-vision
COPY --from=vision /yunet.onnx /usr/share/cuttingfloor/models/face_detection_yunet_2023mar.onnx
COPY --from=vision /models/ /usr/share/cuttingfloor/models/
COPY --from=vision /opt/onnxruntime/lib/ /opt/onnxruntime/lib/
COPY --from=vision /cf-segment /usr/local/bin/cf-segment
COPY --from=skills-model /models/ /usr/share/cuttingfloor/models/
# Chromium for the sandbox (create.motion, create.still, code.run), only ever started by the
# motion-worker role through this wrapper, which keeps its sandbox on and its network off.
# Python (numpy, Pillow, OpenCV) is for code.run scripts.
COPY tools/motion/cf-chromium /usr/local/bin/cf-chromium
RUN cf-vision 2>&1 | grep -q usage && cf-segment 2>&1 | grep -q usage
# MLT's Qt modules (qtblend) need a display variable to load; Qt itself renders offscreen.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true QT_QPA_PLATFORM=offscreen DISPLAY=:0 \
    PUPPETEER_SKIP_DOWNLOAD=1
RUN corepack enable
WORKDIR /app

FROM base AS build
# The pnpm store is a BuildKit cache mount: warm locally, empty on a fresh CI runner even when
# layers come from cache, so installs prefer the store but may download.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prefer-offline --frozen-lockfile

# Test-only: espeak-ng speaks the transcript fixtures, and the tiny whisper model and the Kokoro
# voice model are fetched once here (checksummed) so test runs don't download them.
FROM build AS testenv
USER root
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/models \
 && curl -fsSL -o /opt/models/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin \
 && echo "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21  /opt/models/ggml-tiny.bin" | sha256sum -c - \
 && curl -fsSL -o /tmp/kokoro.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2 \
 && echo "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298  /tmp/kokoro.tar.bz2" | sha256sum -c - \
 && tar -xjf /tmp/kokoro.tar.bz2 -C /opt/models --no-same-owner && rm /tmp/kokoro.tar.bz2
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
