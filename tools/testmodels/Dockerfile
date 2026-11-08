# The engine tests' fixtures, as an image of our own: the tiny whisper model, the Kokoro voice
# model and a laughter-and-applause recording. They used to be fetched from Hugging Face, GitHub
# releases and Wikimedia on every image build, and a dropped 350 MB download failed the build.
# Now they are fetched once, here, checksummed, and published as
#   ghcr.io/mvp2o-ai/cuttingfloor:testmodels-v<N>
# which the main Dockerfile copies from, pinned by digest. To change a fixture: edit this file,
# bump N, and run tools/testmodels/publish.sh (it prints the new digest to put in the Dockerfile).
# The files don't depend on the CPU, so the fetch runs once on the build machine and the image is
# published for both amd64 and arm64.
FROM --platform=$BUILDPLATFORM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/models \
 && curl -fsSL --retry 5 -o /opt/models/ggml-tiny.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin \
 && echo "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21  /opt/models/ggml-tiny.bin" | sha256sum -c - \
 && curl -fsSL --retry 5 -o /tmp/kokoro.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2 \
 && echo "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4  /tmp/kokoro.tar.bz2" | sha256sum -c - \
 && tar -xjf /tmp/kokoro.tar.bz2 -C /opt/models --no-same-owner && rm /tmp/kokoro.tar.bz2 \
 # An audience laughing then clapping for the sounds tests: "approx 800 laughter and clapter" by
 # lonemonk (freesound.org/s/72844), CC BY 3.0, from Wikimedia Commons.
 && mkdir -p /opt/models/fixtures \
 && curl -fsSL --retry 5 -A cuttingfloor-tests -o /opt/models/fixtures/laughter.wav https://upload.wikimedia.org/wikipedia/commons/e/e5/72844_lonemonk_approx-800-laughter-and-clapter-1.wav \
 && echo "8b928e6307f7db0ce5542ae827075f24ada80f007f3a4fdb415559ec9c4e4055  /opt/models/fixtures/laughter.wav" | sha256sum -c -

FROM scratch
COPY --from=fetch /opt/models /opt/models
LABEL org.opencontainers.image.source=https://github.com/mvp2o-ai/cuttingfloor \
      org.opencontainers.image.description="cuttingfloor engine test fixtures (whisper tiny, Kokoro, a CC BY 3.0 laughter recording)"
