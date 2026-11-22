#!/usr/bin/env bash
# A throwaway MongoDB for the Mongo store's tests: one node as a replica set (change streams
# need one), on 127.0.0.1:27017, with nothing kept after it stops. The tests find it there by
# themselves (or at CUTTINGFLOOR_TEST_MONGODB_URI) and skip when there is none.
#
#   scripts/test-mongo.sh         start it (does nothing when it already runs)
#   scripts/test-mongo.sh stop    stop and remove it
set -euo pipefail

name=cuttingfloor-test-mongo
port=${CUTTINGFLOOR_TEST_MONGODB_PORT:-27017}

if [ "${1:-start}" = stop ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  echo "stopped $name"
  exit 0
fi

if [ -z "$(docker ps -q -f "name=^${name}$")" ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --rm --name "$name" -p "127.0.0.1:${port}:27017" mongo:8 --replSet rs0 >/dev/null
fi
for _ in $(seq 1 60); do
  if docker exec "$name" mongosh --quiet --eval \
    'try { rs.status().ok } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27017" }] }).ok }' \
    >/dev/null 2>&1 &&
    docker exec "$name" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true; then
    echo "MongoDB for tests on mongodb://127.0.0.1:${port}/?directConnection=true"
    exit 0
  fi
  sleep 1
done
echo "MongoDB did not become ready" >&2
exit 1
