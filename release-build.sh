#!/usr/bin/env bash

# Release build orchestrator for BoltPage
# - Builds macOS app locally (DMG)
# - Triggers GitHub Actions to build Windows installer (NSIS)
# - Copies both installers into astrojs_website/public/

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAC_DIR="$ROOT_DIR/boltpage"
PUBLIC_DIR="$ROOT_DIR/astrojs_website/public"
WIN_OUT_DIR="$ROOT_DIR/dist/windows"

echo "==> BoltPage release build starting"

# Ensure output directory exists
mkdir -p "$PUBLIC_DIR" "$WIN_OUT_DIR"

# Helper: require a command
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ Missing required command: $1" >&2
    exit 1
  fi
}

# Get project version from boltpage/package.json
require_cmd node
VERSION=$(node -p "require('./boltpage/package.json').version")
echo "==> Version: $VERSION"

########################################
# 1) Build macOS locally (DMG)
########################################
echo "==> Building macOS app locally (DMG)"
(
  cd "$MAC_DIR"
  ./build-release.sh
)

# Find the freshly built DMG
MAC_DMG=$(ls -t "$MAC_DIR/target/release/bundle/dmg/"*.dmg 2>/dev/null | head -n1 || true)
if [[ -z "$MAC_DMG" ]]; then
  echo "❌ Could not find macOS DMG in $MAC_DIR/target/release/bundle/dmg" >&2
  exit 1
fi
MAC_OUT_NAME="BoltPage-${VERSION}-mac.dmg"
cp -f "$MAC_DMG" "$PUBLIC_DIR/$MAC_OUT_NAME"
echo "✅ Copied macOS DMG to: $PUBLIC_DIR/$MAC_OUT_NAME"

########################################
# 2) Build Windows on GitHub Actions
########################################
echo "==> Triggering Windows build on GitHub Actions"
require_cmd gh

# Determine repo slug (owner/repo)
REPO_SLUG="${GH_REPO:-}"
if [[ -z "$REPO_SLUG" ]]; then
  # Try gh to detect current repo
  if gh repo view --json nameWithOwner -q .nameWithOwner >/dev/null 2>&1; then
    REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  else
    # Fallback to parsing git remote origin
    ORIGIN_URL=$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || echo "")
    if [[ "$ORIGIN_URL" =~ github.com[:/](.+)/(.+)\.git$ ]]; then
      REPO_SLUG="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    fi
  fi
fi
if [[ -z "$REPO_SLUG" ]]; then
  echo "❌ Unable to detect GitHub repository slug. Set GH_REPO=owner/repo and retry." >&2
  exit 1
fi
echo "==> Using repository: $REPO_SLUG"

# Determine ref to build (current branch)
REF=$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
echo "==> Triggering workflow on ref: $REF"

# Trigger the workflow (uses the workflow file we added)
gh workflow run -R "$REPO_SLUG" windows-build.yml --ref "$REF"

# Find the latest run for this workflow on the selected branch
sleep 2
RUN_ID=$(gh run list -R "$REPO_SLUG" --workflow windows-build.yml --json databaseId,createdAt,headBranch \
  -q "[.[] | select(.headBranch == '$REF')] | sort_by(.createdAt) | reverse | .[0].databaseId" 2>/dev/null || echo "")
if [[ -z "$RUN_ID" ]]; then
  # Fallback: any latest run
  RUN_ID=$(gh run list -R "$REPO_SLUG" --workflow windows-build.yml --json databaseId,createdAt \
    -q 'sort_by(.[]; .createdAt) | reverse | .[0].databaseId')
fi
if [[ -z "$RUN_ID" ]]; then
  echo "❌ Could not determine workflow run ID for windows-build.yml on $REPO_SLUG" >&2
  exit 1
fi
echo "==> Waiting for workflow run to complete (run id: $RUN_ID)"
gh run watch -R "$REPO_SLUG" "$RUN_ID"

echo "==> Downloading Windows artifacts"
rm -rf "$WIN_OUT_DIR" && mkdir -p "$WIN_OUT_DIR"
gh run download -R "$REPO_SLUG" "$RUN_ID" -n boltpage-windows -D "$WIN_OUT_DIR"

# Locate the NSIS EXE in the downloaded artifacts
WIN_EXE=$(find "$WIN_OUT_DIR" -type f -name "*.exe" | head -n1 || true)
if [[ -z "$WIN_EXE" ]]; then
  echo "❌ Could not find Windows EXE in $WIN_OUT_DIR" >&2
  echo "   Check the workflow run artifacts for name/path changes." >&2
  exit 1
fi
WIN_OUT_NAME="BoltPage-${VERSION}-windows.exe"
cp -f "$WIN_EXE" "$PUBLIC_DIR/$WIN_OUT_NAME"
echo "✅ Copied Windows EXE to: $PUBLIC_DIR/$WIN_OUT_NAME"

########################################
# 3) Summary
########################################
echo ""
echo "🎉 Release artifacts prepared in $PUBLIC_DIR:"
echo " - $MAC_OUT_NAME"
echo " - $WIN_OUT_NAME"
echo ""
echo "Done."
