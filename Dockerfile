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

# Sound models for media.analyze sounds, media.listen and create.stems, exported to ONNX from
# their PyTorch checkpoints (tools/sounds/export-*.py) and checked against the originals there.
# ONNX files are the same on every architecture, so this stage runs on the build machine's own.
#   PretrainedSED frame_mn10 (MIT; arXiv 2409.09546): 447 AudioSet-strong sounds per 40 ms.
#   FlexSED (MIT; arXiv 2509.18606): sounds described in words, per 40 ms.
#   Demucs v4 htdemucs (MIT): drums, bass, other and vocals.
# Code at pinned commits, checkpoints checked against pinned SHA-256s.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS sound-models
ARG PRETRAINEDSED_COMMIT=1aa47e482f7e89904cba2338999345025d8b4e36
ARG SED_MN10_SHA256=4a0fe320d5369987b772394c51881fb20a602967e6842f72f3e5c8181065ece7
ARG FLEXSED_COMMIT=89aac3351e807de57c4fe3148d982922a3318e46
ARG FLEXSED_REVISION=eefe52b7ad686a9bc9f1f5dd0803e2c52171e128
ARG FLEXSED_SHA256=5ec9a9b67ae3e612810ce150de06cd517ff7c8b1c640ba39a1422aa1e9040c32
ARG DEMUCS_VERSION=4.0.1
ARG HTDEMUCS_SHA256=8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY tools/sounds/requirements.txt /src/requirements.txt
RUN python3 -m venv /venv \
 && /venv/bin/pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
      torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 \
 && /venv/bin/pip install --no-cache-dir -r /src/requirements.txt \
 && /venv/bin/pip install --no-cache-dir --no-deps "demucs==$DEMUCS_VERSION" openunmix==1.3.0
RUN git clone --filter=blob:none https://github.com/fschmid56/PretrainedSED /src/sed \
 && git -C /src/sed checkout "$PRETRAINEDSED_COMMIT" \
 && git clone --filter=blob:none https://github.com/JHU-LCAP/FlexSED /src/flexsed \
 && git -C /src/flexsed checkout "$FLEXSED_COMMIT" \
 && mkdir -p /ckpt /models/sounds \
 && curl -fsSL -o /ckpt/frame_mn10.pt https://github.com/fschmid56/PretrainedSED/releases/download/v0.0.1/frame_mn10_strong_1.pt \
 && echo "$SED_MN10_SHA256  /ckpt/frame_mn10.pt" | sha256sum -c - \
 && curl -fsSL -o /ckpt/flexsed.pt "https://huggingface.co/Higobeatz/FlexSED/resolve/$FLEXSED_REVISION/ckpts/flexsed_as.pt" \
 && echo "$FLEXSED_SHA256  /ckpt/flexsed.pt" | sha256sum -c - \
 && curl -fsSL -o /ckpt/htdemucs.th https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th \
 && echo "$HTDEMUCS_SHA256  /ckpt/htdemucs.th" | sha256sum -c -
COPY tools/sounds/export-sed.py tools/sounds/export-flexsed.py tools/sounds/export-demucs.py /src/
RUN cd /tmp && /venv/bin/python -I /src/export-sed.py /src/sed /ckpt/frame_mn10.pt frame_mn10 /models/sounds/sed-mn10.onnx \
 && /venv/bin/python -I /src/export-flexsed.py /src/flexsed /ckpt/flexsed.pt /models/sounds/flexsed.onnx \
 && /venv/bin/python -I /src/export-demucs.py /ckpt/htdemucs.th /models/sounds/htdemucs.onnx
# The CLAP text encoder FlexSED was trained with (laion/clap-htsat-unfused, Apache-2.0) in the
# Transformers.js layout, to turn the words of a media.listen query into its embedding.
ARG CLAP_REVISION=c28f2883575e590e04d3146ff0713c2448d691ba
ARG CLAP_CONFIG_SHA256=39c6d90fe29cf2cce650dd5c92c38a1e35b130d9ce0bb98585222ad687ad979b
ARG CLAP_TOKENIZER_SHA256=dc239041d98de27ffc3975473a1a23e3db4c937b23c138c38bbc66588bd247e5
ARG CLAP_TOKENIZER_CONFIG_SHA256=2c964a338683aec3695ea37687271e75b40905233f5d2a5bbb9be8cb40c4d0a0
ARG CLAP_SPECIAL_TOKENS_SHA256=06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f
ARG CLAP_TEXT_ONNX_SHA256=6df7c51f2d78e236a03f2b816e613d538c815639d13644fe7c2124f439da9648
RUN dir=/models/Xenova/clap-htsat-unfused && mkdir -p "$dir/onnx" \
 && fetch() { \
      curl -fsSL -o "$dir/$1" "https://huggingface.co/Xenova/clap-htsat-unfused/resolve/$CLAP_REVISION/$1" \
      && echo "$2  $dir/$1" | sha256sum -c -; \
    } \
 && fetch config.json "$CLAP_CONFIG_SHA256" \
 && fetch tokenizer.json "$CLAP_TOKENIZER_SHA256" \
 && fetch tokenizer_config.json "$CLAP_TOKENIZER_CONFIG_SHA256" \
 && fetch special_tokens_map.json "$CLAP_SPECIAL_TOKENS_SHA256" \
 && fetch onnx/text_model.onnx "$CLAP_TEXT_ONNX_SHA256"

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
# without it search is keywords only. Pinned to a commit, every file checked against its SHA-256.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS skills-model
ARG MINILM_REVISION=751bff37182d3f1213fa05d7196b954e230abad9
ARG MINILM_CONFIG_SHA256=7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7
ARG MINILM_TOKENIZER_SHA256=da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0
ARG MINILM_TOKENIZER_CONFIG_SHA256=9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3
ARG MINILM_ONNX_SHA256=afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && dir=/models/Xenova/all-MiniLM-L6-v2 && mkdir -p "$dir/onnx" \
 && fetch() { \
      curl -fsSL -o "$dir/$1" "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/$MINILM_REVISION/$1" \
      && echo "$2  $dir/$1" | sha256sum -c -; \
    } \
 && fetch config.json "$MINILM_CONFIG_SHA256" \
 && fetch tokenizer.json "$MINILM_TOKENIZER_SHA256" \
 && fetch tokenizer_config.json "$MINILM_TOKENIZER_CONFIG_SHA256" \
 && fetch onnx/model_quantized.onnx "$MINILM_ONNX_SHA256"

# RNNoise models for the voice_denoise effect (FFmpeg arnndn), pinned by commit and SHA-256:
# beguiling-drafter keeps voice (laughs, breaths), somnolent-hogwash keeps speech only.
# GregorR/rnnoise-models: the models are not subject to copyright; RNNoise itself is BSD.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS denoise-models
ARG RNNOISE_MODELS=https://raw.githubusercontent.com/GregorR/rnnoise-models/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /models/rnnoise \
 && curl -fsSL -o /models/rnnoise/bd.rnnn "$RNNOISE_MODELS/beguiling-drafter-2018-08-30/bd.rnnn" \
 && curl -fsSL -o /models/rnnoise/sh.rnnn "$RNNOISE_MODELS/somnolent-hogwash-2018-09-01/sh.rnnn" \
 && printf '%s  %s\n' \
      ae3f7411e1e6a884f839a4a145c394408398f09854dbc1216ee02faafc98a17b /models/rnnoise/bd.rnnn \
      70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0 /models/rnnoise/sh.rnnn \
    | sha256sum -c -

# Speech facts on the CPU, run by packages/engine/src/sound-worker.ts on ONNX Runtime: Silero
# VAD v6.2.3 (MIT, snakers4/silero-vad) for speech probability, and wav2vec2-base-960h
# (Apache-2.0, facebook/wav2vec2-base-960h, as the Transformers.js ONNX export) for aligning
# transcript words to the sound. They ship in the image; each file pinned and checked.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS speech-models
ARG SILERO_COMMIT=5cd7945676eb32225748052e2e6a0580e4686a08
ARG SILERO_SHA256=1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3
ARG W2V_REVISION=a19f851b3d42865797e410752b4c570c871e4825
ARG W2V_SHA256=e46614273f03ff4b87923a965e417fa72004825522cb007c9c25633b8475490d
ARG W2V_VOCAB_SHA256=4178db26b3c7570f6a47f14ac6a1c7b32950b8c2800fb097287e53776934f1c5
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && mkdir -p /models/wav2vec2-base-960h \
 && curl -fsSL -o /models/silero-vad-v6.2.3.onnx "https://raw.githubusercontent.com/snakers4/silero-vad/$SILERO_COMMIT/src/silero_vad/data/silero_vad.onnx" \
 && echo "$SILERO_SHA256  /models/silero-vad-v6.2.3.onnx" | sha256sum -c - \
 && curl -fsSL -o /models/wav2vec2-base-960h/model.onnx "https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/$W2V_REVISION/onnx/model.onnx" \
 && echo "$W2V_SHA256  /models/wav2vec2-base-960h/model.onnx" | sha256sum -c - \
 && curl -fsSL -o /models/wav2vec2-base-960h/vocab.json "https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/$W2V_REVISION/vocab.json" \
 && echo "$W2V_VOCAB_SHA256  /models/wav2vec2-base-960h/vocab.json" | sha256sum -c -

FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg melt tini fontconfig \
      fonts-dejavu-core fonts-inter fonts-montserrat fonts-open-sans fonts-lato fonts-bebas-neue \
      fonts-lobster fonts-comic-neue fonts-firacode fonts-noto-core chromium bzip2 zip \
 && rm -rf /var/lib/apt/lists/* \
 # Web font copies are useless to libass, and Montserrat ships twice; one TrueType set stays.
 && find /usr/share/fonts -name '*.woff*' -delete && rm -rf /usr/share/fonts/opentype/montserrat \
 && fc-cache -f \
 && fc-list : family | grep -q '^Inter' \
 && ffmpeg -hide_banner -encoders | grep -q prores_ks \
 && melt -query transitions | grep -q qtblend \
 && melt -query filters | grep -q rotoscoping \
 && ffmpeg -hide_banner -filters | grep -q vidstabtransform \
 && ffmpeg -hide_banner -filters | grep -q arnndn \
 && chromium --version
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=tts /opt/sherpa-onnx /opt/sherpa-onnx
RUN ln -s /opt/sherpa-onnx/bin/sherpa-onnx-offline-tts /usr/local/bin/sherpa-onnx-offline-tts
COPY --from=vision /cf-vision /usr/local/bin/cf-vision
COPY --from=vision /yunet.onnx /usr/share/cuttingfloor/models/face_detection_yunet_2023mar.onnx
COPY --from=vision /models/ /usr/share/cuttingfloor/models/
COPY --from=vision /opt/onnxruntime/lib/ /opt/onnxruntime/lib/
COPY --from=vision /cf-segment /usr/local/bin/cf-segment
COPY --from=skills-model /models/ /usr/share/cuttingfloor/models/
COPY --from=denoise-models /models/ /usr/share/cuttingfloor/models/
COPY --from=speech-models /models/ /usr/share/cuttingfloor/models/
COPY --from=sound-models /models/ /usr/share/cuttingfloor/models/
# Chromium for the sandbox (create.motion, create.still), only ever started by the
# motion-worker role through this wrapper, which keeps its sandbox on and its network off.
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
# Every skill's vector, from the model above, so the server embeds only the query. Fails without
# the model; the server re-embeds any skill whose text no longer matches its stored hash.
RUN node packages/skills/scripts/write-vectors.ts

# Test-only: the tiny whisper model and the Kokoro voice model, fetched once (checksummed) so test
# runs don't download them. A stage of its own so a source change doesn't fetch them again.
FROM base AS testmodels
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/models \
 && curl -fsSL -o /opt/models/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin \
 && echo "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21  /opt/models/ggml-tiny.bin" | sha256sum -c - \
 && curl -fsSL -o /tmp/kokoro.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2 \
 && echo "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298  /tmp/kokoro.tar.bz2" | sha256sum -c - \
 && tar -xjf /tmp/kokoro.tar.bz2 -C /opt/models --no-same-owner && rm /tmp/kokoro.tar.bz2 \
 # An audience laughing then clapping for the sounds tests: "approx 800 laughter and clapter" by
 # lonemonk (freesound.org/s/72844), CC BY 3.0, from Wikimedia Commons.
 && mkdir -p /opt/models/fixtures \
 && curl -fsSL -A cuttingfloor-tests -o /opt/models/fixtures/laughter.wav https://upload.wikimedia.org/wikipedia/commons/e/e5/72844_lonemonk_approx-800-laughter-and-clapter-1.wav \
 && echo "8b928e6307f7db0ce5542ae827075f24ada80f007f3a4fdb415559ec9c4e4055  /opt/models/fixtures/laughter.wav" | sha256sum -c -

# Test-only: espeak-ng speaks the transcript fixtures.
FROM build AS testenv
USER root
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng \
 && rm -rf /var/lib/apt/lists/*
COPY --from=testmodels /opt/models /opt/models
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
