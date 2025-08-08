#!/bin/bash

# MarkRust Release Build Script
# This script builds, signs, and notarizes MarkRust for macOS distribution

set -e  # Exit on any error

echo "🚀 Building MarkRust for macOS release..."

# Set notarization credentials
export APPLE_ID="igor@danceinpalemoonlight.com"
export APPLE_PASSWORD="ggsn-xche-bjzl-hzyh"
export APPLE_TEAM_ID="U59VVNHDJC"

echo "📦 Building and signing application..."
npm run tauri build

echo "✅ Build complete!"
echo ""
echo "📁 Build artifacts:"
echo "   App Bundle: target/release/bundle/macos/MarkRust.app"
echo "   DMG Installer: target/release/bundle/dmg/MarkRust_1.0.0_aarch64.dmg"
echo ""

# Verify the signature
echo "🔍 Verifying signature..."
codesign -dv --verbose=4 "target/release/bundle/macos/MarkRust.app"

echo ""
echo "🛡️  Testing Gatekeeper acceptance..."
spctl -a -v "target/release/bundle/macos/MarkRust.app"

echo ""
echo "✅ MarkRust is ready for distribution!"
echo ""
echo "To install locally:"
echo "   cp -R target/release/bundle/macos/MarkRust.app /Applications/"
echo ""
echo "To distribute:"
echo "   Use the DMG file: target/release/bundle/dmg/MarkRust_1.0.0_aarch64.dmg"