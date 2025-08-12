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
    echo "🪟 Attempting Windows (NSIS) cross-build from macOS..."
    # Prereqs: rustup target add x86_64-pc-windows-gnu; brew install mingw-w64 nsis
    WIN_TARGET="x86_64-pc-windows-gnu"
    if rustup target list --installed | grep -q "${WIN_TARGET}" && \
       command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 && \
       command -v makensis >/dev/null 2>&1; then
      echo "📦 Building Windows NSIS installer..."
      # Pass args through npm to tauri CLI
      npm run tauri build -- --bundles nsis --target ${WIN_TARGET}

      echo "✅ Windows build complete (if bundling succeeded)."
      echo "📁 Windows artifacts:"
      ls -1 target/${WIN_TARGET}/release/bundle/nsis/*.exe 2>/dev/null || \
        ls -1 target/release/bundle/nsis/*.exe 2>/dev/null || echo "   (no NSIS EXE found)"
    else
      echo "⚠️  Skipping Windows cross-build. Missing prerequisites."
      echo "   Required: rust target '${WIN_TARGET}', MinGW-w64 toolchain, NSIS (makensis)."
      echo "   Install suggestions:"
      echo "     rustup target add ${WIN_TARGET}"
      echo "     brew install mingw-w64 nsis"
    fi
    ;;

  MINGW*|MSYS*|CYGWIN*)
    echo "🚀 Building BoltPage for Windows release..."
    echo "📦 Building installers (MSI/NSIS) via Tauri..."

    # On Windows, signing requires proper configuration in tauri.conf.json and installed tooling.
    # This script will just build the installers as configured.
    npm run tauri build

    echo "✅ Build complete!"
    echo ""
    echo "📁 Build artifacts (if configured):"
    echo "   MSI:"
    ls -1 target/release/bundle/msi/*.msi 2>/dev/null || echo "   (no MSI found)"
    echo "   NSIS/EXE:"
    ls -1 target/release/bundle/nsis/*.exe 2>/dev/null || echo "   (no NSIS EXE found)"
    echo ""
    echo "ℹ️ Windows code signing can be configured in src-tauri/tauri.conf.json under bundle.windows."
    ;;

  *)
    echo "❌ Unsupported OS: $OS_NAME"
    echo "This script supports macOS and Windows (Git Bash/MSYS) only."
    exit 1
    ;;
esac