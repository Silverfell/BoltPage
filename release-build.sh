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

# The Windows build lives in release.yml (build-windows job), which also
# supports workflow_dispatch. There is no separate windows-build.yml.
WORKFLOW_FILE="release.yml"

# Ensure workflow exists on GitHub for this branch; if not, suggest pushing
if ! gh workflow view -R "$REPO_SLUG" "$WORKFLOW_FILE" >/dev/null 2>&1; then
  echo "⚠️  Workflow $WORKFLOW_FILE not found on GitHub for $REPO_SLUG." >&2
  echo "   GitHub requires the workflow file to exist on the repository's DEFAULT branch ($DEFAULT_REF)." >&2
  echo "   Ensure .github/workflows/$WORKFLOW_FILE is pushed to $DEFAULT_REF." >&2
  if [[ "${AUTO_GIT_PUSH:-0}" == "1" ]]; then
    echo "==> AUTO_GIT_PUSH=1 set; publishing ONLY .github/workflows/$WORKFLOW_FILE to $DEFAULT_REF ..."
    # Never push the whole working branch onto the default branch: that would land
    # feature-branch code on $DEFAULT_REF. Instead commit just the workflow file on
    # a throwaway worktree checked out from origin/$DEFAULT_REF.
    git -C "$ROOT_DIR" fetch origin "$DEFAULT_REF"
    WF_WORKTREE="$(mktemp -d)"
    cleanup_wf_worktree() {
      git -C "$ROOT_DIR" worktree remove --force "$WF_WORKTREE" >/dev/null 2>&1 || true
      rm -rf "$WF_WORKTREE"
    }
    trap cleanup_wf_worktree EXIT
    git -C "$ROOT_DIR" worktree add --detach "$WF_WORKTREE" "origin/$DEFAULT_REF" >/dev/null
    mkdir -p "$WF_WORKTREE/.github/workflows"
    cp "$ROOT_DIR/.github/workflows/$WORKFLOW_FILE" "$WF_WORKTREE/.github/workflows/$WORKFLOW_FILE"
    if git -C "$WF_WORKTREE" diff --quiet -- ".github/workflows/$WORKFLOW_FILE"; then
      echo "   Workflow already current on $DEFAULT_REF; nothing to push."
    else
      git -C "$WF_WORKTREE" add ".github/workflows/$WORKFLOW_FILE"
      git -C "$WF_WORKTREE" commit -m "ci: publish $WORKFLOW_FILE to $DEFAULT_REF for workflow_dispatch" >/dev/null
      git -C "$WF_WORKTREE" push origin "HEAD:$DEFAULT_REF"
    fi
    cleanup_wf_worktree
    trap - EXIT
    # recheck
    sleep 3
    if ! gh workflow view -R "$REPO_SLUG" "$WORKFLOW_FILE" >/dev/null 2>&1; then
      echo "❌ Workflow still not visible on GitHub. Push may have failed or different default branch in repo." >&2
      exit 1
    fi
  else
    echo "👉 Tip: re-run with AUTO_GIT_PUSH=1 to publish just the workflow file: AUTO_GIT_PUSH=1 ./release-build.sh" >&2
    echo "   Or push .github/workflows/$WORKFLOW_FILE manually from a clean checkout of $DEFAULT_REF." >&2
    exit 1
  fi
fi

# Trigger the workflow. No tag-push fallback: pushing a v* tag triggers
# release.yml's create-release job and would publish an unintended public
# GitHub Release.
# Newest run id for this ref (jq strings need double quotes, not single).
latest_run_for_ref() {
  gh run list -R "$REPO_SLUG" --workflow "$WORKFLOW_FILE" --json databaseId,createdAt,headBranch \
    -q "[.[] | select(.headBranch == \"$REF\")] | sort_by(.createdAt) | reverse | .[0].databaseId" 2>/dev/null || true
}

# Record the newest existing run before triggering, so we can recognize the run
# the dispatch creates rather than attaching to a stale one after a fixed sleep.
PREV_RUN_ID=$(latest_run_for_ref)

if ! gh workflow run -R "$REPO_SLUG" "$WORKFLOW_FILE" --ref "$REF" >/dev/null 2>&1; then
  echo "❌ 'gh workflow run' failed (likely missing 'workflow' scope or Actions disabled)." >&2
  echo "   Grant the scope with: gh auth refresh -s workflow" >&2
  exit 1
fi

# Poll for the dispatched run: a run id on this ref that differs from PREV_RUN_ID.
# Sleep-in-loop is intentional: GitHub registers the run asynchronously.
echo "==> Waiting for the dispatched run to register ..."
RUN_ID=""
for _ in $(seq 1 30); do
  CANDIDATE=$(latest_run_for_ref)
  if [[ -n "$CANDIDATE" && "$CANDIDATE" != "$PREV_RUN_ID" ]]; then
    RUN_ID="$CANDIDATE"
    break
  fi
  sleep 2
done
if [[ -z "$RUN_ID" ]]; then
  echo "❌ Timed out waiting for a new $WORKFLOW_FILE run on $REF (previous run id: ${PREV_RUN_ID:-none})." >&2
  exit 1
fi
echo "==> Waiting for workflow run to complete (run id: $RUN_ID)"
gh run watch -R "$REPO_SLUG" "$RUN_ID"

echo "==> Downloading Windows artifacts"
rm -rf "$WIN_OUT_DIR" && mkdir -p "$WIN_OUT_DIR"
gh run download -R "$REPO_SLUG" "$RUN_ID" -n windows-build -D "$WIN_OUT_DIR"

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
# 3) Update website links and cleanup old binaries
########################################
# Locate the page that links the download binaries: default to the known path,
# allow WEBSITE_INDEX to override, then fall back to discovering any page under
# astrojs_website/src that already links a .dmg or .exe.
INDEX_FILE="${WEBSITE_INDEX:-$ROOT_DIR/astrojs_website/src/pages/index.astro}"
if [[ ! -f "$INDEX_FILE" ]]; then
  INDEX_FILE=$(grep -rlE 'href="[^"]*\.(dmg|exe)"' "$ROOT_DIR/astrojs_website/src" 2>/dev/null | head -n1 || true)
fi
if [[ -n "$INDEX_FILE" && -f "$INDEX_FILE" ]]; then
  echo "==> Updating download links in $INDEX_FILE"
  # Extract current linked filenames (first .exe and first .dmg). Two separate
  # substitutions: one alternation without /g would leave the trailing quote.
  OLD_EXE=$(grep -o 'href="[^"]*\.exe"' "$INDEX_FILE" | head -n1 | sed -E 's/^href="//; s/"$//') || true
  OLD_DMG=$(grep -o 'href="[^"]*\.dmg"' "$INDEX_FILE" | head -n1 | sed -E 's/^href="//; s/"$//') || true

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
  echo "⚠️  No website download page found under astrojs_website/src (set WEBSITE_INDEX=path to override)." >&2
  echo "    Binaries were copied to $PUBLIC_DIR but no links were updated." >&2
fi

########################################
# 4) Summary
########################################
echo ""
echo "🎉 Release artifacts prepared in $PUBLIC_DIR:"
echo " - $MAC_OUT_NAME"
echo " - $WIN_OUT_NAME"
echo ""
echo "⚠️  REQUIRED before this release is done: update the Homebrew cask + tap."
echo "    Once the GitHub Release for v${VERSION} is published, run:"
echo "      ./update-cask.sh"
echo "    Otherwise 'brew upgrade --cask boltpage' will not see v${VERSION}."
echo ""
echo "Done."
