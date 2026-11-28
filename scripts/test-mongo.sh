#!/usr/bin/env bash
# A throwaway MongoDB for the Mongo store's tests: one node as a replica set (as hosted's cluster
# is, and as change streams will need), on 127.0.0.1:27017, with nothing kept after it stops. The
# tests find it there by themselves (or at CUTTINGFLOOR_TEST_MONGODB_URI) and skip when there is
# none.
#
#   scripts/test-mongo.sh         start it (does nothing when it already runs)
#   scripts/test-mongo.sh stop    stop and remove it (and the Atlas one)
#   scripts/test-mongo.sh atlas   start MongoDB's Atlas image instead, on 127.0.0.1:27018: Atlas
#                                 Search and Vector Search, for the sound library's suite
set -euo pipefail

if [ "${1:-start}" = atlas ]; then
  atlas=cuttingfloor-test-atlas
  if [ -z "$(docker ps -q -f "name=^${atlas}$")" ]; then
    docker rm -f "$atlas" >/dev/null 2>&1 || true
    docker run -d --rm --name "$atlas" -p "127.0.0.1:${CUTTINGFLOOR_TEST_ATLAS_PORT:-27018}:27017" \
      mongodb/mongodb-atlas-local:8.0 >/dev/null
  fi
  for _ in $(seq 1 180); do
    # The image's own health check waits for search (mongot) as well as the database.
    if [ "$(docker inspect -f '{{.State.Health.Status}}' "$atlas" 2>/dev/null)" = healthy ]; then
      echo "MongoDB with Atlas Search for tests on mongodb://127.0.0.1:${CUTTINGFLOOR_TEST_ATLAS_PORT:-27018}/?directConnection=true"
      exit 0
    fi
    sleep 1
  done
  echo "MongoDB's Atlas image did not become ready" >&2
  exit 1
fi

name=cuttingfloor-test-mongo
port=${CUTTINGFLOOR_TEST_MONGODB_PORT:-27017}

if [ "${1:-start}" = stop ]; then
  docker rm -f "$name" cuttingfloor-test-atlas >/dev/null 2>&1 || true
  echo "stopped $name"
  exit 0
fi

if [ -z "$(docker ps -q -f "name=^${name}$")" ]; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  # In memory: the suites make and drop a database per test, which is slow on a disk.
  # No --rm: when it does not come up, its log is what says why (it is removed before each
  # start and by `stop`).
  docker run -d --name "$name" --tmpfs /data/db -p "127.0.0.1:${port}:27017" mongo:8 --replSet rs0 >/dev/null
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
# Say why: twice on 2026-11-28 a CI run stopped here with nothing to go on.
{
  echo "MongoDB did not become ready"
  docker ps -a -f "name=^${name}$" --format 'container: {{.Status}} ({{.Image}})'
  echo "replica set:"
  docker exec "$name" mongosh --quiet --eval \
    'try { JSON.stringify(rs.status().members.map((m) => [m.name, m.stateStr])) } catch (e) { String(e) }' 2>&1 | tail -5
  echo "its log:"
  docker logs --tail 40 "$name" 2>&1 | cut -c1-400
} >&2
exit 1
