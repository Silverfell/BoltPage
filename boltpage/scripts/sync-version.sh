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
sed -i.bak "0,/^version = \"[^\"]*\"/{s/^version = \"[^\"]*\"/version = \"$VERSION\"/;}" "$PROJECT_DIR/src-tauri/Cargo.toml"
rm -f "$PROJECT_DIR/src-tauri/Cargo.toml.bak"

echo "Version synced to $VERSION"
