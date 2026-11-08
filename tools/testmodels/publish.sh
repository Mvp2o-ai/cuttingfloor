#!/usr/bin/env bash
# Builds tools/testmodels/Dockerfile for amd64 and arm64, pushes it as testmodels-v<N>, and prints
# the digest to pin in the main Dockerfile. Needs `docker login ghcr.io` with write:packages.
set -euo pipefail
version="${1:?usage: publish.sh <N>  (the testmodels version, e.g. 1)}"
ref="ghcr.io/mvp2o-ai/cuttingfloor:testmodels-v${version}"
dir="$(cd "$(dirname "$0")" && pwd)"
docker buildx build --platform linux/amd64,linux/arm64 --push -t "$ref" "$dir"
digest="$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' | tr -d '"')"
echo "Pin this in the Dockerfile:"
echo "  FROM ${ref}@${digest} AS testmodels"
