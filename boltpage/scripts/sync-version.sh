#!/bin/sh
# Reads version from package.json and writes it into tauri.conf.json and Cargo.toml.
# Run automatically via the Tauri beforeBuildCommand.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Extract version from package.json (no jq dependency — pure sed)
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PROJECT_DIR/package.json" | head -1)

if [ -z "$VERSION" ]; then
  echo "ERROR: Could not read version from package.json" >&2
  exit 1
fi

echo "Syncing version $VERSION from package.json"

# Update tauri.conf.json
sed -i.bak "s/\"version\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"version\": \"$VERSION\"/" "$PROJECT_DIR/src-tauri/tauri.conf.json"
rm -f "$PROJECT_DIR/src-tauri/tauri.conf.json.bak"

# Update Cargo.toml (only the package version, not dependency versions)
# Uses awk instead of sed "0,/pattern/" which is GNU-only and fails on macOS BSD sed.
awk -v ver="$VERSION" '!done && /^version = "/ { sub(/^version = "[^"]*"/, "version = \"" ver "\""); done=1 } 1' \
  "$PROJECT_DIR/src-tauri/Cargo.toml" > "$PROJECT_DIR/src-tauri/Cargo.toml.tmp" \
  && mv "$PROJECT_DIR/src-tauri/Cargo.toml.tmp" "$PROJECT_DIR/src-tauri/Cargo.toml"

echo "Version synced to $VERSION"
