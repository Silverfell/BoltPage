#!/bin/sh
# Release identity: what the current BoltPage release is called. The version
# comes from package.json; the tag and the published asset names derive from it.
#
#   release-identity.sh        print KEY=value lines, safe to eval
#   release-identity.sh KEY    print that one value
#
# Keys: VERSION, TAG, ARM_DMG, X64_DMG, WIN_SETUP.
# RELEASE_VERSION in the environment replaces the package.json version
# (update-cask.sh passes its VERSION override this way).
#
# ARM_DMG/X64_DMG are the names release.yml renames the DMGs to. WIN_SETUP is the
# name Tauri gives the NSIS installer, which release.yml uploads as built.
# Casks/boltpage.rb spells the two DMG names itself (Ruby cannot call this
# script), so keep its url lines in step by hand.

set -e

# Fixed collation so the character ranges below mean ASCII.
LC_ALL=C
export LC_ALL

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Extract version from package.json (no jq dependency — pure sed)
VERSION="${RELEASE_VERSION:-$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/../package.json" | head -1)}"

# The version ends up in eval'd output, tag names and file names: digits first,
# then only letters, digits and . + -
case "$VERSION" in
  '')
    echo "ERROR: Could not read version from package.json" >&2
    exit 1
    ;;
  [!0-9]*|*[!0-9A-Za-z.+-]*)
    echo "ERROR: Not a valid version: $VERSION" >&2
    exit 1
    ;;
esac

TAG="v$VERSION"
ARM_DMG="BoltPage-$VERSION-arm64.dmg"
X64_DMG="BoltPage-$VERSION-x64.dmg"
WIN_SETUP="BoltPage_${VERSION}_x64-setup.exe"

case "${1:-}" in
  '')
    printf 'VERSION=%s\nTAG=%s\nARM_DMG=%s\nX64_DMG=%s\nWIN_SETUP=%s\n' \
      "$VERSION" "$TAG" "$ARM_DMG" "$X64_DMG" "$WIN_SETUP"
    ;;
  VERSION) echo "$VERSION" ;;
  TAG) echo "$TAG" ;;
  ARM_DMG) echo "$ARM_DMG" ;;
  X64_DMG) echo "$X64_DMG" ;;
  WIN_SETUP) echo "$WIN_SETUP" ;;
  *)
    echo "Usage: release-identity.sh [VERSION|TAG|ARM_DMG|X64_DMG|WIN_SETUP]" >&2
    exit 2
    ;;
esac
