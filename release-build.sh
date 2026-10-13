#!/usr/bin/env bash

# release-build.sh — run the release flow from a tag that is already pushed.
#
# The flow: dev -> main PR, then a lightweight tag on main. Pushing the v* tag
# runs release.yml, which builds, notarizes and publishes the GitHub Release.
# This script picks up from there:
#   1. confirm v<version> exists on GitHub and its commit is on main
#   2. wait for the GitHub Release to be published with its three assets
#   3. run update-cask.sh (cask rewrite + Homebrew tap push)
#   4. remind you to commit the cask on dev
#
# It builds nothing and pushes no tag; its only push is update-cask.sh's cask
# push to the tap. The tag name is v + the package.json version, taken from
# boltpage/scripts/release-identity.sh (the rule release.yml's check-tag job
# enforces), and only that exact tag is looked for.
#
# Usage:
#   ./release-build.sh              # after pushing the tag from main
#   DRY_RUN=1 ./release-build.sh    # same checks; update-cask.sh rewrites the
#                                   # cask locally and skips the tap push
#
# Env overrides: GH_REPO (default Silverfell/BoltPage, as in update-cask.sh),
#                RELEASE_WAIT_SECS (default 3600), RELEASE_POLL_SECS (default 30).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${GH_REPO:-Silverfell/BoltPage}"
WAIT_SECS="${RELEASE_WAIT_SECS:-3600}"
POLL_SECS="${RELEASE_POLL_SECS:-30}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: Missing required command: $1" >&2
    exit 1
  fi
}
# gh queries GitHub; git is used by update-cask.sh to push the tap.
for c in gh git; do require_cmd "$c"; done

# Version, tag and asset names come from release-identity.sh. Captured before
# eval so a failure stops the script (eval of a failed substitution would
# succeed on empty input). RELEASE_VERSION is cleared so a stray one in the
# environment cannot move the tag away from the package.json version that
# update-cask.sh uses below.
IDENTITY="$(RELEASE_VERSION= sh "$ROOT_DIR/boltpage/scripts/release-identity.sh")"
eval "$IDENTITY"
echo "==> Release flow for $TAG ($REPO)"

########################################
# 1) The tag is on GitHub and on main
########################################
# The compare status is the tag relative to main: "identical" (main's tip) or
# "behind" (an ancestor of main) means the tagged commit is on main. A missing
# tag makes the call fail.
if ! TAG_STATUS=$(gh api "repos/$REPO/compare/main...$TAG" --jq .status); then
  echo "ERROR: Could not compare tag $TAG with main on $REPO (gh error above)." >&2
  echo "       Push the tag from main first, then re-run." >&2
  exit 1
fi
case "$TAG_STATUS" in
  identical|behind)
    echo "==> $TAG is on main ($TAG_STATUS)"
    ;;
  *)
    echo "ERROR: $TAG is not on main (compare status: $TAG_STATUS)." >&2
    echo "       Merge dev into main and tag main, then re-run." >&2
    exit 1
    ;;
esac

########################################
# 2) Wait for the GitHub Release to be published
########################################
# release.yml's last job creates the Release and uploads its files, so wait for
# a published (non-draft) Release that carries all three expected assets.
echo "==> Waiting for the $TAG release (timeout ${WAIT_SECS}s, checking every ${POLL_SECS}s)"
DEADLINE=$((SECONDS + WAIT_SECS))
while :; do
  # "release not found" is the normal state while the workflow runs, so a
  # failed lookup counts as "no assets yet".
  ASSETS=$(gh release view "$TAG" -R "$REPO" --json isDraft,assets \
    --jq 'select(.isDraft | not) | .assets[].name' 2>/dev/null || true)
  MISSING=""
  for asset in "$ARM_DMG" "$X64_DMG" "$WIN_SETUP"; do
    grep -qxF "$asset" <<<"$ASSETS" || MISSING="$MISSING $asset"
  done
  if [[ -z "$MISSING" ]]; then
    break
  fi
  if (( SECONDS >= DEADLINE )); then
    echo "ERROR: Timed out after ${WAIT_SECS}s waiting for the $TAG release (missing:$MISSING)." >&2
    echo "       Check the workflow run: gh run list -R $REPO --workflow release.yml" >&2
    exit 1
  fi
  echo "    not ready (missing:$MISSING); next check in ${POLL_SECS}s"
  sleep "$POLL_SECS"
done
echo "==> $TAG release is published with all assets"

########################################
# 3) Update the Homebrew cask + tap
########################################
DRY_RUN="${DRY_RUN:-0}" "$ROOT_DIR/update-cask.sh"

########################################
# 4) Reminder
########################################
echo ""
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1: the tap was not pushed; the local cask was rewritten."
else
  echo "Reminder: commit the updated cask on dev (it reaches main with the next dev -> main PR)."
fi
echo "Done."
