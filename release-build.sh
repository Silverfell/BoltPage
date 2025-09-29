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

# Determine ref to build (current branch) and repo default branch
REF=$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
DEFAULT_REF=$(gh repo view -R "$REPO_SLUG" --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null || echo "main")
echo "==> Triggering workflow on ref: $REF (repo default: $DEFAULT_REF)"

# Ensure workflow exists on GitHub for this branch; if not, suggest pushing
if ! gh workflow view -R "$REPO_SLUG" windows-build.yml >/dev/null 2>&1; then
  echo "⚠️  Workflow windows-build.yml not found on GitHub for $REPO_SLUG." >&2
  echo "   GitHub requires the workflow file to exist on the repository's DEFAULT branch ($DEFAULT_REF)." >&2
  echo "   Ensure .github/workflows/windows-build.yml is pushed to $DEFAULT_REF." >&2
  if [[ "${AUTO_GIT_PUSH:-0}" == "1" ]]; then
    echo "==> AUTO_GIT_PUSH=1 set; pushing workflow to default branch ($DEFAULT_REF) ..."
    # Push current branch to the repo's default branch, to ensure workflow presence
    git -C "$ROOT_DIR" push origin "$REF":"$DEFAULT_REF"
    # recheck
    sleep 3
    if ! gh workflow view -R "$REPO_SLUG" windows-build.yml >/dev/null 2>&1; then
      echo "❌ Workflow still not visible on GitHub. Push may have failed or different default branch in repo." >&2
      exit 1
    fi
  else
    echo "👉 Tip: re-run with AUTO_GIT_PUSH=1 to push automatically: AUTO_GIT_PUSH=1 ./release-build.sh" >&2
    echo "   Or push manually: git push origin $REF:$DEFAULT_REF" >&2
    exit 1
  fi
fi

# Trigger the workflow (uses the workflow file we added). If dispatch fails (permissions),
# fallback to pushing a temporary tag matching 'v*' to trigger the tag workflow automatically.
if ! gh workflow run -R "$REPO_SLUG" windows-build.yml --ref "$REF" >/dev/null 2>&1; then
  echo "⚠️  'gh workflow run' failed (likely missing 'workflow' scope or Actions disabled)."
  echo "   Falling back to temporary tag push to trigger build on GitHub."
  TEMP_TAG="v${VERSION}-ci-$(date +%s)"
  echo "==> Creating temporary tag: $TEMP_TAG"
  git -C "$ROOT_DIR" tag -f "$TEMP_TAG" "$REF"
  git -C "$ROOT_DIR" push -f origin "refs/tags/$TEMP_TAG"
  REF="$TEMP_TAG"
fi

# Find the latest run for this workflow on the selected ref
sleep 3
RUN_ID=""
if [[ "$REF" == v* ]]; then
  # For tag builds, match by head SHA of the tag
  TAG_SHA=$(git -C "$ROOT_DIR" rev-list -n 1 "$REF")
RUN_ID=$(gh run list -R "$REPO_SLUG" --workflow windows-build.yml --json databaseId,createdAt,headSha \
    -q "[.[] | select(.headSha == '$TAG_SHA')] | sort_by(.createdAt) | reverse | .[0].databaseId" 2>/dev/null || echo "")
else
RUN_ID=$(gh run list -R "$REPO_SLUG" --workflow windows-build.yml --json databaseId,createdAt,headBranch \
    -q "[.[] | select(.headBranch == '$REF')] | sort_by(.createdAt) | reverse | .[0].databaseId" 2>/dev/null || echo "")
fi
if [[ -z "$RUN_ID" ]]; then
  # Fallback: any latest run
  RUN_ID=$(gh run list -R "$REPO_SLUG" --workflow windows-build.yml --json databaseId,createdAt \
    -q 'sort_by(.createdAt) | reverse | .[0].databaseId')
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

# Cleanup: delete temporary tag if used
if [[ "${TEMP_TAG:-}" != "" ]]; then
  echo "==> Cleaning up temporary tag $TEMP_TAG"
  git -C "$ROOT_DIR" tag -d "$TEMP_TAG" >/dev/null 2>&1 || true
  git -C "$ROOT_DIR" push origin ":refs/tags/$TEMP_TAG" >/dev/null 2>&1 || true
fi

########################################
# 3) Update website links and cleanup old binaries
########################################
INDEX_FILE="$ROOT_DIR/astrojs_website/src/pages/index.astro"
if [[ -f "$INDEX_FILE" ]]; then
  echo "==> Updating download links in $INDEX_FILE"
  # Extract current linked filenames (first .exe and first .dmg)
  OLD_EXE=$(grep -o 'href="[^"]*\.exe"' "$INDEX_FILE" | head -n1 | sed -E 's/^href="|"$//') || true
  OLD_DMG=$(grep -o 'href="[^"]*\.dmg"' "$INDEX_FILE" | head -n1 | sed -E 's/^href="|"$//') || true

  # Replace with new filenames (no path prefix, public is root)
  if [[ -n "$OLD_EXE" ]]; then
    echo "    Replacing Windows link: $OLD_EXE -> $WIN_OUT_NAME"
    # macOS sed vs others handled earlier; here we only run on macOS
    sed -i '' "s|href=\"${OLD_EXE}\"|href=\"${WIN_OUT_NAME}\"|" "$INDEX_FILE"
  fi
  if [[ -n "$OLD_DMG" ]]; then
    echo "    Replacing macOS link: $OLD_DMG -> $MAC_OUT_NAME"
    sed -i '' "s|href=\"${OLD_DMG}\"|href=\"${MAC_OUT_NAME}\"|" "$INDEX_FILE"
  fi

  # Remove old binaries from public if they differ
  if [[ -n "${OLD_EXE:-}" && "$OLD_EXE" != "$WIN_OUT_NAME" && -f "$PUBLIC_DIR/$OLD_EXE" ]]; then
    echo "    Deleting old Windows binary: $PUBLIC_DIR/$OLD_EXE"
    rm -f "$PUBLIC_DIR/$OLD_EXE"
  fi
  if [[ -n "${OLD_DMG:-}" && "$OLD_DMG" != "$MAC_OUT_NAME" && -f "$PUBLIC_DIR/$OLD_DMG" ]]; then
    echo "    Deleting old macOS binary: $PUBLIC_DIR/$OLD_DMG"
    rm -f "$PUBLIC_DIR/$OLD_DMG"
  fi
else
  echo "⚠️  $INDEX_FILE not found; skipping link update."
fi

########################################
# 4) Summary
########################################
echo ""
echo "🎉 Release artifacts prepared in $PUBLIC_DIR:"
echo " - $MAC_OUT_NAME"
echo " - $WIN_OUT_NAME"
echo ""
echo "Done."
