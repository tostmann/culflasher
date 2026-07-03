#!/usr/bin/env bash
# Deploy the culflasher to install.busware.de/cul/ (first-party hosting).
#
# Model (like the sibling install.busware.de flashers, e.g. ip4knx
# scripts/deploy_webflasher.sh): assemble a staging dir from the versioned app
# files PLUS the CUL firmware taken from a pinned a-culfw RELEASE, then rsync it
# to the install host. Same-origin manifest.json + CUL_V3.hex gives: pinned
# firmware, downloads countable in the install apache log, CSP connect-src 'self'.
#
# Firmware source = a-culfw RELEASE ASSET, pinned to a tag (decided 2026-07-03).
# The blessed firmware lives ONLY in the GitHub release asset — at the git tag
# the binaries/ tree is absent (404); a-culfw commits binaries to master AFTER
# tagging. The release has no manifest asset, so we generate one (version=tag).
#
# Safety gates (fail-closed): rejects not-found / draft / prerelease / missing
# CUL_V3.hex asset; verifies the download size against the release metadata and
# the Intel-HEX EOF record; refuses a DOWNGRADE (older than live) unless forced;
# backs up the live dir to <dir>.prev before rsync; and re-checks the served
# md5 after rsync.
#
# Internal host/path live in scripts/deploy.env (gitignored).
#
#   ACULFW_TAG=<tag> ./scripts/deploy.sh  # pin a release — RUN THIS AT RELEASE
#   ./scripts/deploy.sh                    # pin the LATEST published release
#   DRY_RUN=1 ./scripts/deploy.sh          # stage + rsync --dry-run (no write)
#   STAGE_ONLY=1 ./scripts/deploy.sh       # build staging dir only
#   ALLOW_DOWNGRADE=1 …                     # override the downgrade guard
#   ALLOW_PRERELEASE=1 …                    # allow a prerelease tag
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cfg="$root/scripts/deploy.env"
[ -f "$cfg" ] && . "$cfg"
: "${INSTALL_SSH:?set INSTALL_SSH in scripts/deploy.env}"
: "${INSTALL_DIR:?set INSTALL_DIR in scripts/deploy.env}"

ACULFW_REPO="${ACULFW_REPO:-tostmann/a-culfw}"
LIVE_URL="${LIVE_URL:-https://install.busware.de/cul}"
ASSET="CUL_V3.hex"

# --- Release auflösen + fail-closed validieren -----------------------------
TAG="${ACULFW_TAG:-$(gh release view --repo "$ACULFW_REPO" --json tagName --jq .tagName 2>/dev/null || true)}"
[ -n "$TAG" ] || { echo "ERROR: kein a-culfw Release gefunden (ACULFW_TAG=<tag> setzen)"; exit 1; }

meta=$(gh release view "$TAG" --repo "$ACULFW_REPO" --json publishedAt,isDraft,isPrerelease,assets 2>/dev/null) \
  || { echo "ERROR: Release $TAG nicht gefunden"; exit 1; }
read -r published isdraft ispre assetsize < <(printf '%s' "$meta" | python3 -c "
import sys, json
d = json.load(sys.stdin)
size = next((a['size'] for a in d.get('assets', []) if a['name'] == '$ASSET'), '')
print(d.get('publishedAt') or '-', d.get('isDraft'), d.get('isPrerelease'), size or '-')
")

[ "$published" != "-" ]      || { echo "ERROR: Release $TAG hat kein publishedAt (Draft?) — Abbruch"; exit 1; }
[ "$isdraft" != "True" ]     || { echo "ERROR: Release $TAG ist ein DRAFT — Abbruch"; exit 1; }
if [ "$ispre" = "True" ] && [ "${ALLOW_PRERELEASE:-0}" != "1" ]; then
  echo "ERROR: Release $TAG ist ein PRERELEASE — ALLOW_PRERELEASE=1 zum Erzwingen"; exit 1
fi
if [ "$assetsize" = "-" ]; then
  echo "ERROR: Release $TAG hat kein Asset '$ASSET' (umbenannt?). Vorhandene Assets:"
  printf '%s' "$meta" | python3 -c "import sys,json;[print('   '+a['name']) for a in json.load(sys.stdin).get('assets',[])]"
  exit 1
fi

# --- Staging ---------------------------------------------------------------
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

for f in index.html app.js boot.js FlashOnWeb.js AtmelDFU.js version.js \
         busware.png README.md TROUBLESHOOTING.md; do
  [ -f "$root/$f" ] || { echo "ERROR: fehlende App-Datei $f"; exit 1; }
  cp "$root/$f" "$stage/"
done
cp -r "$root/vendor" "$stage/vendor"

# Firmware aus dem Release-Asset + Integritätsprüfung
gh release download "$TAG" --repo "$ACULFW_REPO" --pattern "$ASSET" --dir "$stage" --clobber
dlsize=$(stat -c%s "$stage/$ASSET")
[ "$dlsize" = "$assetsize" ] \
  || { echo "ERROR: $ASSET Größe $dlsize != Release-Metadaten $assetsize (Download unvollständig/manipuliert?)"; exit 1; }
[ "$(head -c1 "$stage/$ASSET")" = ":" ] \
  || { echo "ERROR: $ASSET beginnt nicht mit ':' — kein Intel-HEX"; exit 1; }
lastline=$(grep -v '^[[:space:]]*$' "$stage/$ASSET" | tail -1 | tr -d '\r')
[ "$lastline" = ":00000001FF" ] \
  || { echo "ERROR: $ASSET endet nicht auf dem Intel-HEX EOF-Record (letzte Zeile: '$lastline')"; exit 1; }
md5=$(md5sum "$stage/$ASSET" | awk '{print $1}')

# manifest.json lokal generieren (Releases tragen keins). Version = Tag, Datum = YYYY-MM-DD.
python3 - "$stage/manifest.json" "$TAG" "$published" <<'PY'
import json, sys
path, tag, pub = sys.argv[1], sys.argv[2], sys.argv[3]
date = pub.split("T")[0] if "T" in pub else pub
json.dump({"CUL_V3": {"version": tag, "last_build": date,
                      "artifacts": [{"file": "CUL_V3.hex", "type": "app"}]}},
          open(path, "w"), indent=2)
PY

appver=$(sed -n 's/.*VERSION = "\(.*\)".*/\1/p' "$root/version.js")
printf 'culflasher %s\na-culfw source: %s\nrelease-tag: %s\npublished: %s\nfirmware: %s  size %s  md5 %s\n' \
  "$appver" "$ACULFW_REPO" "$TAG" "$published" "$ASSET" "$dlsize" "$md5" > "$stage/SOURCE.txt"

echo ">> culflasher $appver  |  a-culfw release $TAG (published $published, $dlsize B, md5 $md5)"

if [ "${STAGE_ONLY:-0}" = "1" ]; then
  keep="$root/webflasher-stage"; rm -rf "$keep"; cp -r "$stage" "$keep"
  echo ">> STAGE_ONLY: $keep"; trap - EXIT; exit 0
fi

# --- Downgrade-Guard: neues Release nicht älter als live -------------------
live_date=$(curl -fsS "$LIVE_URL/manifest.json" 2>/dev/null \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('CUL_V3',{}).get('last_build',''))" 2>/dev/null || true)
if [ -n "$live_date" ]; then
  new_epoch=$(date -d "$published" +%s 2>/dev/null || echo 0)
  live_epoch=$(date -d "$live_date" +%s 2>/dev/null || echo 0)
  if [ "$new_epoch" -gt 0 ] && [ "$live_epoch" -gt 0 ] && [ "$new_epoch" -lt "$live_epoch" ]; then
    if [ "${ALLOW_DOWNGRADE:-0}" != "1" ]; then
      echo "ERROR: Release $TAG ($published) ist ÄLTER als live ($live_date) — Abbruch."
      echo "       ALLOW_DOWNGRADE=1 zum Erzwingen."
      exit 1
    fi
    echo "WARN: Downgrade auf $TAG erzwungen (ALLOW_DOWNGRADE=1)."
  fi
fi

# --- rsync -----------------------------------------------------------------
CHMOD="--chmod=D755,F644"   # mktemp -d liefert 700; ohne das sperrt Apache mit 403
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo ">> DRY_RUN rsync -> $INSTALL_SSH:$INSTALL_DIR/"
  ssh "$INSTALL_SSH" "mkdir -p '$INSTALL_DIR'"
  rsync -az $CHMOD --checksum --delete --dry-run -v "$stage/" "$INSTALL_SSH:$INSTALL_DIR/"
  exit 0
fi

# Rollback-Sicherung: aktuellen Live-Stand nach <dir>.prev spiegeln (1 Schritt zurück).
ssh "$INSTALL_SSH" "mkdir -p '$INSTALL_DIR'; if [ -n \"\$(ls -A '$INSTALL_DIR' 2>/dev/null)\" ]; then rm -rf '${INSTALL_DIR}.prev' && cp -a '$INSTALL_DIR' '${INSTALL_DIR}.prev'; fi"
rsync -az $CHMOD --checksum --delete "$stage/" "$INSTALL_SSH:$INSTALL_DIR/"

# Post-Deploy-Verify: die AUSGELIEFERTEN Bytes müssen dem Staging entsprechen.
served_md5=$(curl -fsS "$LIVE_URL/$ASSET" 2>/dev/null | md5sum | awk '{print $1}')
[ "$served_md5" = "$md5" ] \
  || { echo "ERROR: live $ASSET md5 $served_md5 != deployed $md5 — Deploy NICHT verifiziert!"; exit 1; }

echo ">> deployed + verified -> $LIVE_URL/  (a-culfw release $TAG, md5 $md5 live)"
