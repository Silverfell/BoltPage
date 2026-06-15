#!/bin/bash

# BoltPage Release Build Script
# - On macOS: builds, signs, and notarizes the macOS app + DMG
# - On Windows (Git Bash): builds Windows installers (MSI/NSIS) if configured

set -euo pipefail

OS_NAME=$(uname -s || echo "unknown")

# Function to extract version and app name from package.json
get_package_info() {
    local package_file="package.json"
    if [[ ! -f "$package_file" ]]; then
        echo "❌ Error: $package_file not found!" >&2
        exit 1
    fi
    
    # Extract version using grep and sed
    local version=$(grep '"version"' "$package_file" | sed 's/.*"version": *"\([^"]*\)".*/\1/')
    if [[ -z "$version" ]]; then
        echo "❌ Error: Could not extract version from $package_file" >&2
        exit 1
    fi
    
    # Extract app name using grep and sed
    local app_name=$(grep '"name"' "$package_file" | sed 's/.*"name": *"\([^"]*\)".*/\1/')
    if [[ -z "$app_name" ]]; then
        echo "❌ Error: Could not extract app name from $package_file" >&2
        exit 1
    fi
    
    echo "$version|$app_name"
}

# Function to update app name in a file
update_app_name_in_file() {
    local file_path="$1"
    local new_name="$2"
    
    if [[ ! -f "$file_path" ]]; then
        echo "⚠️  Warning: $file_path not found, skipping..."
        return 0
    fi
    
    # Use sed to replace the app name - be very precise
    if [[ "$OS_NAME" == "Darwin" ]]; then
        # macOS sed requires different syntax
        sed -i '' "s/^name = \".*\"/name = \"$new_name\"/" "$file_path"
    else
        # Linux/Windows sed
        sed -i "s/^name = \".*\"/name = \"$new_name\"/" "$file_path"
    fi
    
    echo "✅ Updated app name in $file_path to: $new_name"
}

# Function to update package name in Cargo.toml (should be lowercase)
update_package_name_in_file() {
    local file_path="$1"
    local new_name="$2"
    
    if [[ ! -f "$file_path" ]]; then
        echo "⚠️  Warning: $file_path not found, skipping..."
        return 0
    fi
    
    # Convert to lowercase for package names
    local lowercase_name=$(echo "$new_name" | tr '[:upper:]' '[:lower:]')
    
    # Use sed to replace the package name - be very precise
    if [[ "$OS_NAME" == "Darwin" ]]; then
        # macOS sed requires different syntax
        sed -i '' "s/^name = \".*\"/name = \"$lowercase_name\"/" "$file_path"
    else
        # Linux/Windows sed
        sed -i "s/^name = \".*\"/name = \"$lowercase_name\"/" "$file_path"
    fi
    
    echo "✅ Updated package name in $file_path to: $lowercase_name (lowercase)"
}

# Function to update JSON product name in a file
update_json_product_name() {
    local file_path="$1"
    local new_name="$2"
    
    if [[ ! -f "$file_path" ]]; then
        echo "⚠️  Warning: $file_path not found, skipping..."
        return 0
    fi
    
    # Use sed to replace the JSON product name - be very precise
    if [[ "$OS_NAME" == "Darwin" ]]; then
        # macOS sed requires different syntax
        sed -i '' "s/\"productName\": \".*\"/\"productName\": \"$new_name\"/" "$file_path"
    else
        # Linux/Windows sed
        sed -i "s/\"productName\": \".*\"/\"productName\": \"$new_name\"/" "$file_path"
    fi
    
    echo "✅ Updated JSON product name in $file_path to: $new_name"
}

# Function to update Ruby version in a file
update_ruby_version() {
    local file_path="$1"
    local new_version="$2"
    
    if [[ ! -f "$file_path" ]]; then
        echo "⚠️  Warning: $file_path not found, skipping..."
        return 0
    fi
    
    # Use sed to replace the Ruby version - be very precise
    if [[ "$OS_NAME" == "Darwin" ]]; then
        # macOS sed requires different syntax
        sed -i '' "s/version \".*\"/version \"$new_version\"/" "$file_path"
    else
        # Linux/Windows sed
        sed -i "s/version \".*\"/version \"$new_version\"/" "$file_path"
    fi
    
    echo "✅ Updated Ruby version in $file_path to: $new_version"
}

# Function to update Ruby name in a file
update_ruby_name() {
    local file_path="$1"
    local new_name="$2"
    
    if [[ ! -f "$file_path" ]]; then
        echo "⚠️  Warning: $file_path not found, skipping..."
        return 0
    fi
    
    # Use sed to replace the Ruby name - be very precise
    if [[ "$OS_NAME" == "Darwin" ]]; then
        # macOS sed requires different syntax
        sed -i '' "s/name \".*\"/name \"$new_name\"/" "$file_path"
    else
        # Linux/Windows sed
        sed -i "s/name \".*\"/name \"$new_name\"/" "$file_path"
    fi
    
    echo "✅ Updated Ruby name in $file_path to: $new_name"
}

# Synchronize versions and app names before building
echo "🔄 Synchronizing version numbers and app names..."
PACKAGE_INFO=$(get_package_info)
PACKAGE_VERSION=$(echo "$PACKAGE_INFO" | cut -d'|' -f1)
PACKAGE_NAME=$(echo "$PACKAGE_INFO" | cut -d'|' -f2)

echo "📋 package.json version: $PACKAGE_VERSION"
echo "📋 package.json app name: $PACKAGE_NAME"

# Cargo.toml and tauri.conf.json versions are synced by scripts/sync-version.sh,
# which Tauri runs as beforeBuildCommand in the build below; don't write them
# here too. Only the name/productName (not handled there) are synced now.
update_package_name_in_file "src-tauri/Cargo.toml" "$PACKAGE_NAME"
update_json_product_name "src-tauri/tauri.conf.json" "$PACKAGE_NAME"

# Update Homebrew cask
update_ruby_version "Homebrew/Casks/boltpage.rb" "$PACKAGE_VERSION"
update_ruby_name "Homebrew/Casks/boltpage.rb" "$PACKAGE_NAME"

echo "✅ Version and app name synchronization complete!"
echo ""

case "$OS_NAME" in
  Darwin)
    echo "🚀 Building BoltPage for macOS release..."

    # Load credentials from local env files if not already set
    if [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
      for f in ".env.local" ".env.release" ".env"; do
        if [[ -f "$f" ]]; then
          echo "🔐 Loading credentials from $f"
          set -a
          # shellcheck disable=SC1090
          . "$f"
          set +a
          break
        fi
      done
    fi

    # Validate required credentials are available now
    if [[ -z "${APPLE_ID:-}" || -z "${APPLE_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
      echo "❌ Missing notarization credentials. Provide them via environment or a local .env file." >&2
      echo "   Required variables: APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID" >&2
      exit 1
    fi

    # Export environment variables for Tauri build process
    export APPLE_ID
    export APPLE_PASSWORD
    export APPLE_TEAM_ID

    echo "📦 Building and signing application..."
    npm run tauri build

    echo "✅ Build complete!"
    echo ""
    echo "📁 Build artifacts:"
    echo "   App Bundle: target/release/bundle/macos/BoltPage.app"
    # Print the actual DMG produced (arch can vary)
    echo "   DMG Installer(s):"
    ls -1 target/release/bundle/dmg/*.dmg 2>/dev/null || echo "   (no DMG found)"
    echo ""

    # Verify the signature
    echo "🔍 Verifying signature..."
    codesign -dv --verbose=4 "target/release/bundle/macos/BoltPage.app"

    echo ""
    echo "🛡️  Testing Gatekeeper acceptance..."
    spctl -a -v "target/release/bundle/macos/BoltPage.app"

    echo ""
    echo "✅ BoltPage is ready for distribution!"
    echo ""
    echo "To install locally:"
    echo "   cp -R target/release/bundle/macos/BoltPage.app /Applications/"
    echo ""
    echo "To distribute:"
    echo "   Use the DMG file printed above (in target/release/bundle/dmg)"

    echo ""
    echo "🪟 Windows installers are not supported from macOS in Tauri v2."
    echo "   To produce Windows MSI/NSIS: run this script on Windows, or use CI with a Windows runner."
    ;;

  MINGW*|MSYS*|CYGWIN*)
    echo "🚀 Building BoltPage for Windows release..."
    echo "📦 Building NSIS installer via Tauri (avoids WiX/MSI requirement)..."

    # On Windows, signing requires proper configuration in tauri.conf.json and installed tooling.
    # This script will just build the installers as configured.
    npm run tauri build -- --bundles nsis

    echo "✅ Build complete!"
    echo ""
    echo "📁 Build artifacts:"
    echo "   NSIS/EXE:"
    ls -1 target/release/bundle/nsis/*.exe 2>/dev/null || echo "   (no NSIS EXE found)"
    echo ""
    echo "ℹ️ For MSI output, install WiX Toolset v3 and run: 'npm run tauri build -- --bundles msi'"
    echo "   WiX install (PowerShell/Administrator): choco install wixtoolset --version 3.14.0.2921"
    echo "ℹ️ Windows code signing can be configured in src-tauri/tauri.conf.json under bundle.windows."
    ;;

  *)
    echo "❌ Unsupported OS: $OS_NAME"
    echo "This script supports macOS and Windows (Git Bash/MSYS) only."
    exit 1
    ;;
esac