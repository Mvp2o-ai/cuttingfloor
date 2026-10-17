#!/usr/bin/env bash
# Creates (or updates) one hosted cuttingfloor server on Hetzner Cloud and starts it.
#   hcloud context create cuttingfloor     (once; paste a project API token)
#   cp cuttingfloor.env.example cuttingfloor.env && edit it
#   ./up.sh                                (again later to deploy a new image)
# Then point an A record for CUTTINGFLOOR_DOMAIN at the address it prints.
set -euo pipefail
cd "$(dirname "$0")"

NAME=${CUTTINGFLOOR_SERVER:-cuttingfloor-1}
TYPE=${CUTTINGFLOOR_SERVER_TYPE:-ccx23}   # 4 dedicated vCPU, 16 GB
LOCATION=${CUTTINGFLOOR_LOCATION:-fsn1}
SSH_KEY=${CUTTINGFLOOR_SSH_KEY:-$(hcloud ssh-key list -o noheader -o columns=name | head -1)}

[ -f cuttingfloor.env ] || { echo "Make cuttingfloor.env from cuttingfloor.env.example first" >&2; exit 1; }
[ -n "$SSH_KEY" ] || { echo "Add an SSH key to the project: hcloud ssh-key create --name me --public-key-from-file ~/.ssh/id_ed25519.pub" >&2; exit 1; }

if ! hcloud server describe "$NAME" >/dev/null 2>&1; then
  hcloud server create --name "$NAME" --type "$TYPE" --image debian-13 --location "$LOCATION" \
    --ssh-key "$SSH_KEY" --user-data-from-file cloud-init.yaml --label app=cuttingfloor
fi
IP=$(hcloud server ip "$NAME")
SSH=(ssh -o StrictHostKeyChecking=accept-new "root@$IP")

echo "Waiting for $NAME ($IP) to finish setting up…"
until "${SSH[@]}" test -f /var/lib/cloud/cuttingfloor-ready 2>/dev/null; do sleep 10; done

scp -q compose.yaml Caddyfile ../../tools/motion/seccomp.json "root@$IP:/opt/cuttingfloor/"
scp -q cuttingfloor.env "root@$IP:/opt/cuttingfloor/cuttingfloor.env"
"${SSH[@]}" "chmod 600 /opt/cuttingfloor/cuttingfloor.env \
  && echo CUTTINGFLOOR_NODE=$NAME >> /opt/cuttingfloor/cuttingfloor.env \
  && mkdir -p /var/lib/cuttingfloor && chown 1000:1000 /var/lib/cuttingfloor"
# A private image needs a pull token: GHCR_USER and GHCR_TOKEN (read:packages) in your shell.
if [ -n "${GHCR_TOKEN:-}" ]; then
  echo "$GHCR_TOKEN" | "${SSH[@]}" docker login ghcr.io -u "${GHCR_USER:?set GHCR_USER}" --password-stdin
fi
"${SSH[@]}" "cd /opt/cuttingfloor && docker compose pull && docker compose up -d"
echo "Up: https://$(grep ^CUTTINGFLOOR_DOMAIN= cuttingfloor.env | cut -d= -f2)/mcp on $IP"
