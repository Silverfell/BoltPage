#!/bin/bash

# BoltPage Icon Update Script
# Converts boltpage_icon.png to all required icon sizes and formats for Tauri

set -euo pipefail

# Check if ImageMagick is installed (prefer IMv7 `magick`, fallback to `convert`)
IM_CMD=""
if command -v magick &> /dev/null; then
    IM_CMD="magick"
elif command -v convert &> /dev/null; then
    IM_CMD="convert"
else
    echo "❌ Error: ImageMagick is not installed!"
    echo "Please install ImageMagick first:"
    echo "  macOS: brew install imagemagick"
    echo "  Ubuntu/Debian: sudo apt-get install imagemagick"
    echo "  Windows: Download from https://imagemagick.org/"
    exit 1
fi

# Check if source icon exists
SOURCE_ICON="boltpage_icon.png"
if [[ ! -f "$SOURCE_ICON" ]]; then
    echo "❌ Error: $SOURCE_ICON not found in the current directory!"
    echo "Please place $SOURCE_ICON in the root directory and run this script again."
    exit 1
fi

# Create icons directory if it doesn't exist
ICONS_DIR="src-tauri/icons"
mkdir -p "$ICONS_DIR"

echo "🔄 Converting $SOURCE_ICON to all required icon formats..."

# Base icon (PNG format)
echo "📱 Creating base icon.png..."
"$IM_CMD" "$SOURCE_ICON" -resize 1024x1024 "$ICONS_DIR/icon.png"

# macOS icon (.icns)
echo "🍎 Creating macOS icon.icns..."
# Create temporary directory for icon set
TEMP_DIR=$(mktemp -d)
mkdir -p "$TEMP_DIR/icon.iconset"

# Generate all required sizes for macOS
"$IM_CMD" "$SOURCE_ICON" -resize 16x16 "$TEMP_DIR/icon.iconset/icon_16x16.png"
"$IM_CMD" "$SOURCE_ICON" -resize 32x32 "$TEMP_DIR/icon.iconset/icon_16x16@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 32x32 "$TEMP_DIR/icon.iconset/icon_32x32.png"
"$IM_CMD" "$SOURCE_ICON" -resize 64x64 "$TEMP_DIR/icon.iconset/icon_32x32@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 128x128 "$TEMP_DIR/icon.iconset/icon_128x128.png"
"$IM_CMD" "$SOURCE_ICON" -resize 256x256 "$TEMP_DIR/icon.iconset/icon_128x128@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 256x256 "$TEMP_DIR/icon.iconset/icon_256x256.png"
"$IM_CMD" "$SOURCE_ICON" -resize 512x512 "$TEMP_DIR/icon.iconset/icon_256x256@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 512x512 "$TEMP_DIR/icon.iconset/icon_512x512.png"
"$IM_CMD" "$SOURCE_ICON" -resize 1024x1024 "$TEMP_DIR/icon.iconset/icon_512x512@2x.png"

# Create .icns file
iconutil -c icns "$TEMP_DIR/icon.iconset" -o "$ICONS_DIR/icon.icns"

# Windows icon (.ico)
echo "🪟 Creating Windows icon.ico..."
"$IM_CMD" "$SOURCE_ICON" -resize 256x256 "$ICONS_DIR/icon.ico"

# Standard PNG sizes
echo "📐 Creating standard PNG sizes..."
"$IM_CMD" "$SOURCE_ICON" -resize 32x32 "$ICONS_DIR/32x32.png"
"$IM_CMD" "$SOURCE_ICON" -resize 64x64 "$ICONS_DIR/64x64.png"
"$IM_CMD" "$SOURCE_ICON" -resize 128x128 "$ICONS_DIR/128x128.png"
"$IM_CMD" "$SOURCE_ICON" -resize 128x128 "$ICONS_DIR/128x128@2x.png"

# Windows Store/Start Menu icons
echo "🏪 Creating Windows Store icons..."
"$IM_CMD" "$SOURCE_ICON" -resize 30x30 "$ICONS_DIR/Square30x30Logo.png"
"$IM_CMD" "$SOURCE_ICON" -resize 44x44 "$ICONS_DIR/Square44x44Logo.png"
"$IM_CMD" "$SOURCE_ICON" -resize 71x71 "$ICONS_DIR/Square71x71Logo.png"
"$IM_CMD" "$SOURCE_ICON" -resize 89x89 "$ICONS_DIR/Square89x89Logo.png"
"$IM_CMD" "$SOURCE_ICON" -resize 107x107 "$ICONS_DIR/Square107x107Logo.png"
"$IM_CMD" "$SOURCE_ICON" -resize 142x142 "$ICONS_DIR/Square142x142Logo.png"
"$IM_CMD" "$SOURCE_ICON" -resize 150x150 "$ICONS_DIR/Square150x150Logo.png"
"$IM_CMD" "$SOURCE_ICON" -resize 284x284 "$ICONS_DIR/Square284x284Logo.png"
"$IM_CMD" "$SOURCE_ICON" -resize 310x310 "$ICONS_DIR/Square310x310Logo.png"

# Windows Store logo
"$IM_CMD" "$SOURCE_ICON" -resize 50x50 "$ICONS_DIR/StoreLogo.png"

# Android icons (if needed)
echo "🤖 Creating Android icons..."
mkdir -p "$ICONS_DIR/android"
mkdir -p "$ICONS_DIR/android/mipmap-mdpi"
mkdir -p "$ICONS_DIR/android/mipmap-hdpi"
mkdir -p "$ICONS_DIR/android/mipmap-xhdpi"
mkdir -p "$ICONS_DIR/android/mipmap-xxhdpi"
mkdir -p "$ICONS_DIR/android/mipmap-xxxhdpi"

"$IM_CMD" "$SOURCE_ICON" -resize 48x48 "$ICONS_DIR/android/mipmap-mdpi/ic_launcher.png"
"$IM_CMD" "$SOURCE_ICON" -resize 72x72 "$ICONS_DIR/android/mipmap-hdpi/ic_launcher.png"
"$IM_CMD" "$SOURCE_ICON" -resize 96x96 "$ICONS_DIR/android/mipmap-xhdpi/ic_launcher.png"
"$IM_CMD" "$SOURCE_ICON" -resize 144x144 "$ICONS_DIR/android/mipmap-xxhdpi/ic_launcher.png"
"$IM_CMD" "$SOURCE_ICON" -resize 192x192 "$ICONS_DIR/android/mipmap-xxxhdpi/ic_launcher.png"

# iOS icons (if needed)
echo "📱 Creating iOS icons..."
mkdir -p "$ICONS_DIR/ios"
"$IM_CMD" "$SOURCE_ICON" -resize 20x20 "$ICONS_DIR/ios/AppIcon-20x20@1x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 40x40 "$ICONS_DIR/ios/AppIcon-20x20@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 60x60 "$ICONS_DIR/ios/AppIcon-20x20@3x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 29x29 "$ICONS_DIR/ios/AppIcon-29x29@1x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 58x58 "$ICONS_DIR/ios/AppIcon-29x29@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 87x87 "$ICONS_DIR/ios/AppIcon-29x29@3x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 40x40 "$ICONS_DIR/ios/AppIcon-40x40@1x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 80x80 "$ICONS_DIR/ios/AppIcon-40x40@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 120x120 "$ICONS_DIR/ios/AppIcon-40x40@3x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 120x120 "$ICONS_DIR/ios/AppIcon-60x60@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 180x180 "$ICONS_DIR/ios/AppIcon-60x60@3x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 76x76 "$ICONS_DIR/ios/AppIcon-76x76@1x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 152x152 "$ICONS_DIR/ios/AppIcon-76x76@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 167x167 "$ICONS_DIR/ios/AppIcon-83.5x83.5@2x.png"
"$IM_CMD" "$SOURCE_ICON" -resize 1024x1024 "$ICONS_DIR/ios/AppIcon-512@2x.png"

# Clean up temporary directory
rm -rf "$TEMP_DIR"

echo "✅ Icon conversion complete!"
echo ""
echo "📁 Icons created in: $ICONS_DIR/"
echo "🎯 Ready for Tauri build!"
echo ""
echo "💡 Tip: Run this script whenever you update boltpage_icon.png"
echo "💡 Tip: The icons will be automatically used in your next build"

