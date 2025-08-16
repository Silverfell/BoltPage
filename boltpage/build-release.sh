#!/bin/bash

# BoltPage Release Build Script
# - On macOS: builds, signs, and notarizes the macOS app + DMG
# - On Windows (Git Bash): builds Windows installers (MSI/NSIS) if configured

set -euo pipefail

OS_NAME=$(uname -s || echo "unknown")

case "$OS_NAME" in
  Darwin)
    echo "🚀 Building BoltPage for macOS release..."

    # Set notarization credentials
    export APPLE_ID="igor@danceinpalemoonlight.com"
    export APPLE_PASSWORD="ggsn-xche-bjzl-hzyh"
    export APPLE_TEAM_ID="U59VVNHDJC"

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