#!/usr/bin/env bash
# Deploy the culflasher to install.busware.de/cul/ (first-party hosting).
#
# Model (like the sibling install.busware.de flashers, e.g. ip4knx
# scripts/deploy_webflasher.sh): assemble a staging dir from the versioned app
# files PLUS a snapshot of the CUL firmware pinned to an exact a-culfw commit,
# then rsync it to the install host. Hosting manifest.json + CUL_V3.hex
# same-origin gives: pinned firmware (only moves on redeploy), downloads
# countable in the install apache log, and a CSP with connect-src 'self'.
#
# Internal host/path live in scripts/deploy.env (gitignored). Firmware source
# repo/commit are pinned here; override the commit with ACULFW_SHA=<sha>.
#
#   ./scripts/deploy.sh            # snapshot a-culfw master@HEAD, stage, rsync
#   DRY_RUN=1 ./scripts/deploy.sh  # build staging + rsync --dry-run (no write)
#   STAGE_ONLY=1 ./scripts/deploy.sh   # build staging dir only, print its path
#   ACULFW_SHA=<sha> ./scripts/deploy.sh   # pin a specific a-culfw commit
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cfg="$root/scripts/deploy.env"
[ -f "$cfg" ] && . "$cfg"
: "${INSTALL_SSH:?set INSTALL_SSH in scripts/deploy.env}"
: "${INSTALL_DIR:?set INSTALL_DIR in scripts/deploy.env}"

ACULFW_REPO="${ACULFW_REPO:-tostmann/a-culfw}"

# --- Firmware pinnen: exakten Commit auflösen, alles von diesem SHA ziehen ---
SHA="${ACULFW_SHA:-$(gh api "repos/$ACULFW_REPO/commits/master" --jq .sha)}"
[ -n "$SHA" ] || { echo "ERROR: konnte a-culfw-Commit nicht auflösen"; exit 1; }
RAW="https://raw.githubusercontent.com/$ACULFW_REPO/$SHA/binaries"

# --- Staging ---------------------------------------------------------------
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# App-Runtime + Docs aus dem Repo
for f in index.html app.js boot.js FlashOnWeb.js AtmelDFU.js version.js \
         busware.png README.md TROUBLESHOOTING.md; do
  [ -f "$root/$f" ] || { echo "ERROR: fehlende App-Datei $f"; exit 1; }
  cp "$root/$f" "$stage/"
done
cp -r "$root/vendor" "$stage/vendor"

# Firmware-Snapshot vom gepinnten a-culfw-Commit
curl -fsS "$RAW/manifest.json" -o "$stage/manifest.json"
file=$(python3 -c "import json;print(json.load(open('$stage/manifest.json'))['CUL_V3']['artifacts'][0]['file'])")
ver=$(python3 -c "import json;print(json.load(open('$stage/manifest.json'))['CUL_V3']['version'])")
curl -fsS "$RAW/$file" -o "$stage/$file"
# Sanity: Intel-HEX beginnt mit ':' und ist nicht leer
[ -s "$stage/$file" ] && [ "$(head -c1 "$stage/$file")" = ":" ] \
  || { echo "ERROR: $file ist leer oder kein Intel-HEX"; exit 1; }

appver=$(sed -n 's/.*VERSION = "\(.*\)".*/\1/p' "$root/version.js")
md5=$(md5sum "$stage/$file" | awk '{print $1}')
printf 'culflasher %s\na-culfw source: %s\ncommit: %s\nfirmware: %s  version %s  md5 %s\n' \
  "$appver" "$ACULFW_REPO" "$SHA" "$file" "$ver" "$md5" > "$stage/SOURCE.txt"

echo ">> culflasher $appver  |  firmware $file v$ver (a-culfw@${SHA:0:12}, md5 $md5)"

if [ "${STAGE_ONLY:-0}" = "1" ]; then
  keep="$root/webflasher-stage"; rm -rf "$keep"; cp -r "$stage" "$keep"
  echo ">> STAGE_ONLY: $keep"; trap - EXIT; exit 0
fi

# --- rsync -----------------------------------------------------------------
ssh "$INSTALL_SSH" "mkdir -p '$INSTALL_DIR'"
# --chmod erzwingt world-lesbare Rechte (Dirs 755, Files 644) unabhängig von
# der Staging-Quelle — mktemp -d liefert 700, das rsync -a sonst mitschleppt
# und Apache (www-data) mit 403 aussperrt.
CHMOD="--chmod=D755,F644"
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo ">> DRY_RUN rsync -> $INSTALL_SSH:$INSTALL_DIR/"
  rsync -az $CHMOD --checksum --delete --dry-run -v "$stage/" "$INSTALL_SSH:$INSTALL_DIR/"
  exit 0
fi
rsync -az $CHMOD --checksum --delete "$stage/" "$INSTALL_SSH:$INSTALL_DIR/"
echo ">> deployed -> https://install.busware.de/cul/  (fw v$ver, a-culfw@${SHA:0:12})"
