#!/usr/bin/env bash

# update-cask.sh — publish a released version to the Homebrew cask + tap.
#
# REQUIRED for every release. After the GitHub Release for v<version> is
# published (tag push -> release.yml uploads the notarized arm64/x64 DMGs),
# run this so the cask points at the new version and the Homebrew tap is
# updated; otherwise `brew upgrade --cask boltpage` never sees the release.
#
# Usage:
#   ./update-cask.sh             # version from boltpage/package.json
#   VERSION=2.3.0 ./update-cask.sh
#   DRY_RUN=1 ./update-cask.sh   # rewrite the cask locally, skip the tap push
#
# Env overrides: GH_REPO (default Silverfell/BoltPage),
#                TAP_REPO (default Silverfell/homebrew-tap).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CASK="$ROOT_DIR/boltpage/Homebrew/Casks/boltpage.rb"
REPO="${GH_REPO:-Silverfell/BoltPage}"
TAP_REPO="${TAP_REPO:-Silverfell/homebrew-tap}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ Missing required command: $1" >&2
    exit 1
  fi
}
for c in gh shasum git awk; do require_cmd "$c"; done

# Version, tag and DMG names come from release-identity.sh; VERSION overrides
# the package.json version. Captured before eval so a failure stops the script
# (eval of a failed substitution would succeed on empty input).
IDENTITY="$(RELEASE_VERSION="${VERSION:-}" sh "$ROOT_DIR/boltpage/scripts/release-identity.sh")"
eval "$IDENTITY"
echo "==> Updating cask for $TAG ($REPO -> $TAP_REPO)"

# 1) Pull the published release DMGs and checksum them.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! gh release download "$TAG" -R "$REPO" -p "$ARM_DMG" -p "$X64_DMG" -D "$TMP"; then
  echo "❌ Could not download $ARM_DMG / $X64_DMG from the $TAG release." >&2
  echo "   Publish the GitHub Release first (push the $TAG tag), then re-run." >&2
  exit 1
fi
ARM_SHA="$(shasum -a 256 "$TMP/$ARM_DMG" | awk '{print $1}')"
X64_SHA="$(shasum -a 256 "$TMP/$X64_DMG" | awk '{print $1}')"
echo "    arm64 sha256 $ARM_SHA"
echo "    x64   sha256 $X64_SHA"

# 2) Rewrite version + per-arch sha256 in the cask. URLs interpolate #{version}
#    in the cask, so only the version line and the two sha256 lines change.
awk -v ver="$VERSION" -v arm="$ARM_SHA" -v x64="$X64_SHA" '
  /^[[:space:]]*version / { sub(/"[^"]*"/, "\"" ver "\"") }
  /on_arm do/   { blk = "arm" }
  /on_intel do/ { blk = "x64" }
  /^[[:space:]]*sha256 / {
    if (blk == "arm")      sub(/"[^"]*"/, "\"" arm "\"")
    else if (blk == "x64") sub(/"[^"]*"/, "\"" x64 "\"")
  }
  { print }
' "$CASK" > "$CASK.tmp" && mv "$CASK.tmp" "$CASK"
echo "==> Rewrote $CASK"

# 3) Push the cask to the tap: the channel `brew install` actually reads from.
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "==> DRY_RUN=1: cask updated locally; skipping tap push."
  exit 0
fi

TAP_TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" "$TAP_TMP"' EXIT
gh repo clone "$TAP_REPO" "$TAP_TMP" >/dev/null 2>&1
mkdir -p "$TAP_TMP/Casks"
cp "$CASK" "$TAP_TMP/Casks/boltpage.rb"
if git -C "$TAP_TMP" diff --quiet -- Casks/boltpage.rb; then
  echo "==> Tap already current for $TAG; nothing to push."
else
  git -C "$TAP_TMP" add Casks/boltpage.rb
  git -C "$TAP_TMP" commit -qm "Update BoltPage cask to $TAG"
  git -C "$TAP_TMP" push -q origin HEAD
  echo "==> Pushed cask $TAG to $TAP_REPO"
fi

echo ""
echo "Done. Commit the updated cask in this repo so the source stays in sync:"
echo "  git add $CASK && git commit -m \"chore(cask): update to $TAG\""
