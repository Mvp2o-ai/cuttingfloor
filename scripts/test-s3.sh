#!/usr/bin/env bash
# A throwaway S3 store (MinIO) for the S3 blob store's tests, on 127.0.0.1:9100, with nothing
# kept after it stops. The tests find it there by themselves (or at CUTTINGFLOOR_TEST_S3_ENDPOINT),
# make a bucket of their own each, and skip when there is none.
#
#   scripts/test-s3.sh         start it (does nothing when it already runs)
#   scripts/test-s3.sh stop    stop and remove it
#
# The image: MinIO no longer publishes minio/minio on Docker Hub, so this is Chainguard's build
# of it. CUTTINGFLOOR_TEST_S3_IMAGE names another.
set -euo pipefail

name=cuttingfloor-test-s3
port=${CUTTINGFLOOR_TEST_S3_PORT:-9100}
image=${CUTTINGFLOOR_TEST_S3_IMAGE:-cgr.dev/chainguard/minio:latest}

if [ "${1:-start}" = stop ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "stopped $name"
  exit 0
fi

if [ -z "$(docker ps -q -f "name=^${name}$")" ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  # Test-only sign-in, the same the tests use. Data stays in the container and goes with it.
  docker run -d --rm --name "$name" -p "127.0.0.1:${port}:9000" \
    -e MINIO_ROOT_USER=cuttingfloor -e MINIO_ROOT_PASSWORD=cuttingfloor-test-secret \
    "$image" server /tmp/data >/dev/null
fi
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:${port}/minio/health/ready"; then
    echo "S3 for tests on http://127.0.0.1:${port}"
    exit 0
  fi
  sleep 1
done
echo "MinIO did not become ready" >&2
exit 1
