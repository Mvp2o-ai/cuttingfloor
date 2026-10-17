#!/usr/bin/env bash
# Creates (or updates) one hosted cuttingfloor server on Hetzner Cloud and starts it.
#   hcloud context create cuttingfloor     (once; or export HCLOUD_TOKEN)
#   cp cuttingfloor.env.example cuttingfloor.env && edit it
#   ./up.sh                                (again later to deploy again)
# CUTTINGFLOOR_BUILD=1 builds the image on the server from this checkout's HEAD instead of
# pulling it. CUTTINGFLOOR_ZONE (a Hetzner DNS zone, e.g. example.com) points the domain at the
# server; otherwise add the A record yourself. CUTTINGFLOOR_DNS_TOKEN is the token for the project
# that holds the zone, when that isn't the server's project.
set -euo pipefail
cd "$(dirname "$0")"

NAME=${CUTTINGFLOOR_SERVER:-cuttingfloor-1}
TYPE=${CUTTINGFLOOR_SERVER_TYPE:-ccx33}   # 8 dedicated vCPU, 32 GB
LOCATION=${CUTTINGFLOOR_LOCATION:-ash}
SSH_KEY=${CUTTINGFLOOR_SSH_KEY:-$(hcloud ssh-key list -o noheader -o columns=name | head -1)}

[ -f cuttingfloor.env ] || { echo "Make cuttingfloor.env from cuttingfloor.env.example first" >&2; exit 1; }
[ -n "$SSH_KEY" ] || { echo "Add an SSH key to the project: hcloud ssh-key create --name me --public-key-from-file ~/.ssh/id_ed25519.pub" >&2; exit 1; }
DOMAIN=$(grep ^CUTTINGFLOOR_DOMAIN= cuttingfloor.env | cut -d= -f2)

if ! hcloud server describe "$NAME" >/dev/null 2>&1; then
  # A named IPv4 and no IPv6: the address outlives a rebuilt server, so DNS stays put, and it
  # costs one primary IP (limits count them across every project of the account).
  hcloud primary-ip describe "$NAME" >/dev/null 2>&1 \
    || hcloud primary-ip create --type ipv4 --name "$NAME" --location "$LOCATION" --label app=cuttingfloor
  hcloud server create --name "$NAME" --type "$TYPE" --image debian-13 --location "$LOCATION" \
    --ssh-key "$SSH_KEY" --user-data-from-file cloud-init.yaml --label app=cuttingfloor \
    --primary-ipv4 "$NAME" --without-ipv6
fi
IP=$(hcloud server ip "$NAME")
SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$IP")

if [ -n "${CUTTINGFLOOR_ZONE:-}" ]; then
  RECORD=${DOMAIN%."$CUTTINGFLOOR_ZONE"}
  dns() { if [ -n "${CUTTINGFLOOR_DNS_TOKEN:-}" ]; then HCLOUD_TOKEN=$CUTTINGFLOOR_DNS_TOKEN hcloud "$@"; else hcloud "$@"; fi; }
  if dns zone rrset describe "$CUTTINGFLOOR_ZONE" "$RECORD" A >/dev/null 2>&1; then
    dns zone rrset set-records "$CUTTINGFLOOR_ZONE" "$RECORD" A --record "$IP"
  else
    dns zone rrset create "$CUTTINGFLOOR_ZONE" --name "$RECORD" --type A --record "$IP" --ttl 300
  fi
fi

echo "Waiting for $NAME ($IP) to finish setting up…"
until "${SSH[@]}" test -f /var/lib/cloud/cuttingfloor-ready 2>/dev/null; do sleep 10; done

scp -q compose.yaml Caddyfile ../../tools/motion/seccomp.json "root@$IP:/opt/cuttingfloor/"
scp -q cuttingfloor.env "root@$IP:/opt/cuttingfloor/cuttingfloor.env"
"${SSH[@]}" "chmod 600 /opt/cuttingfloor/cuttingfloor.env \
  && echo CUTTINGFLOOR_NODE=$NAME >> /opt/cuttingfloor/cuttingfloor.env \
  && mkdir -p /var/lib/cuttingfloor && chown 1000:1000 /var/lib/cuttingfloor"

if [ "${CUTTINGFLOOR_BUILD:-}" = 1 ]; then
  REV=$(git rev-parse --short HEAD)
  echo "Building cuttingfloor:$REV on the server…"
  git -C ../.. archive --format=tar HEAD | "${SSH[@]}" "rm -rf /opt/cuttingfloor/src && mkdir -p /opt/cuttingfloor/src && tar -x -C /opt/cuttingfloor/src"
  "${SSH[@]}" "cd /opt/cuttingfloor/src && docker build --target runtime -t cuttingfloor:$REV ."
  IMAGE="cuttingfloor:$REV"
else
  # A private image needs a pull token: GHCR_USER and GHCR_TOKEN (read:packages) in your shell.
  if [ -n "${GHCR_TOKEN:-}" ]; then
    echo "$GHCR_TOKEN" | "${SSH[@]}" docker login ghcr.io -u "${GHCR_USER:?set GHCR_USER}" --password-stdin
  fi
  IMAGE=${CUTTINGFLOOR_IMAGE:-ghcr.io/mvp2o-ai/cuttingfloor:latest}
  "${SSH[@]}" "cd /opt/cuttingfloor && CUTTINGFLOOR_IMAGE=$IMAGE docker compose pull cuttingfloor motion"
fi
"${SSH[@]}" "cd /opt/cuttingfloor && CUTTINGFLOOR_IMAGE=$IMAGE docker compose up -d"
echo "Up: https://$DOMAIN/mcp on $IP ($IMAGE)"
