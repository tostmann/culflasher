#!/usr/bin/env bash
# Deploy the culflasher to the prov server.
#
# Model: the prov server is a *git checkout* of origin. Deploy = server pulls
# origin/main (fast-forward only). We NEVER rsync onto it — that would re-create
# the working-tree-vs-HEAD drift this repo was set up to avoid. Consequence:
# only what has been pushed to origin gets deployed (and per project policy only
# consolidated releases are ever pushed).
#
# The internal prov host/path live in scripts/deploy.env (gitignored) so no
# infrastructure detail lands in the public repo.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cfg="$root/scripts/deploy.env"
[ -f "$cfg" ] && . "$cfg"
: "${PROV_SSH:?set PROV_SSH in scripts/deploy.env}"
: "${PROV_DIR:?set PROV_DIR in scripts/deploy.env}"

git -C "$root" fetch origin --quiet
local_head=$(git -C "$root" rev-parse HEAD)
origin_head=$(git -C "$root" rev-parse origin/main)

if [ "$local_head" != "$origin_head" ] \
   && git -C "$root" merge-base --is-ancestor "$origin_head" "$local_head"; then
  echo "WARN: lokaler HEAD ist origin/main voraus (unpushte Commits)."
  echo "      Deploy veröffentlicht nur origin/main. Erst 'git push origin main' (nur Releases!)."
fi

target=$(git -C "$root" rev-parse --short origin/main)
echo ">> Deploy origin/main ($target) -> $PROV_SSH:$PROV_DIR"
ssh "$PROV_SSH" "git -C '$PROV_DIR' fetch origin --quiet && git -C '$PROV_DIR' pull --ff-only origin main"

deployed=$(ssh "$PROV_SSH" "git -C '$PROV_DIR' rev-parse --short HEAD")
ver=$(ssh "$PROV_SSH" "sed -n 's/.*VERSION = \"\\(.*\\)\".*/\\1/p' '$PROV_DIR/version.js' 2>/dev/null" || true)
echo ">> deployed: $deployed   version: ${ver:-?}"
