# BoltPage Packaging and Distribution Guide

This document outlines the packaging and distribution process for BoltPage across Windows, macOS, and Linux platforms.

## Phase 5: Packaging and Distribution - COMPLETED

### 1. Windows Packaging ✅

#### MSI Installer (WiX)
- **Configuration**: Complete in `tauri.conf.json`
- **Features**: Per-machine installation, file associations for .md/.markdown files
- **Build Command**: `cargo tauri build --target x86_64-pc-windows-msv`
- **Output**: `target/release/bundle/msi/BoltPage_1.0.0_x64_en-US.msi`

#### NSIS Installer
- **Configuration**: Complete in `tauri.conf.json`
- **Features**: Custom installer UI, multiple language support
- **Build Command**: `cargo tauri build --target x86_64-pc-windows-msv`
- **Output**: `target/release/bundle/nsis/BoltPage_1.0.0_x64-setup.exe`

#### Code Signing Setup (Requires Certificate)
```bash
# Set environment variables for code signing
export TAURI_SIGNING_PRIVATE_KEY="path/to/certificate.p12"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your_certificate_password"

# Build signed packages
cargo tauri build --target x86_64-pc-windows-msv
```

**Security Warning**: Never commit certificates or passwords to the repository. Use environment variables or secure secret management.

### 2. macOS Packaging ✅

#### DMG Distribution
- **Configuration**: Complete in `tauri.conf.json`
- **Features**: Custom DMG layout, drag-to-Applications folder
- **Build Command**: `cargo tauri build --target x86_64-apple-darwin`
- **Output**: `target/release/bundle/dmg/BoltPage_1.0.0_x64.dmg`

#### Code Signing and Notarization Setup (Requires Apple Developer Account)
```bash
# Set environment variables for signing (use your own values)
export APPLE_CERTIFICATE="Developer ID Application: Your Name (YOUR_TEAM_ID)"
export APPLE_CERTIFICATE_PASSWORD="your_certificate_password"
export APPLE_ID="your-apple-id@example.com"
export APPLE_PASSWORD="your_app_specific_password"
export APPLE_TEAM_ID="YOUR_TEAM_ID"

# Build signed and notarized package
cargo tauri build --target x86_64-apple-darwin

# Manual notarization (if needed)
xcrun notarytool submit "target/release/bundle/dmg/BoltPage_1.0.0_x64.dmg" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

xcrun stapler staple "target/release/bundle/dmg/BoltPage_1.0.0_x64.dmg"
```

#### Entitlements
- **File**: `entitlements.plist` (configured for file access without sandbox)
- **Permissions**: User file read/write, bookmarks for file access

### 3. Linux Packaging ✅

#### DEB Package (Debian/Ubuntu)
- **Configuration**: Complete in `tauri.conf.json`
- **Build Command**: `cargo tauri build --target x86_64-unknown-linux-gnu`
- **Output**: `target/release/bundle/deb/boltpage_1.0.0_amd64.deb`

#### AppImage (Universal Linux)
- **Configuration**: Complete in `tauri.conf.json`
- **Build Command**: `cargo tauri build --target x86_64-unknown-linux-gnu`
- **Output**: `target/release/bundle/appimage/BoltPage_1.0.0_amd64.AppImage`

### 4. Standalone CLI Binary ✅

#### Configuration
- **Binary Target**: Added to `Cargo.toml`
- **Build Command**: `cargo build --bin markrust --release`
- **Output**: `target/release/markrust` (Unix) / `target/release/markrust.exe` (Windows)

#### Features
- Help output with `--help` or `-h`
- Version information with `--version` or `-v`
- File opening: `markrust README.md`
- No arguments: launches GUI without file

#### Installation
```bash
# Build release binary
cargo build --bin markrust --release

# Install to system PATH (Unix)
sudo cp target/release/markrust /usr/local/bin/

# Install to system PATH (Windows)
# Copy target/release/markrust.exe to a directory in %PATH%
```

## Build Commands Summary

### Development Builds
```bash
# GUI application
cargo tauri dev

# CLI binary
cargo build --bin markrust
```

### Release Builds
```bash
# All platforms (run on respective OS)
cargo tauri build

# Specific targets
cargo tauri build --target x86_64-pc-windows-msv    # Windows
cargo tauri build --target x86_64-apple-darwin      # macOS Intel
cargo tauri build --target aarch64-apple-darwin     # macOS Apple Silicon
cargo tauri build --target x86_64-unknown-linux-gnu # Linux

# CLI binary only
cargo build --bin markrust --release
```

## Distribution Checklist

### Before Release
- [ ] Set up code signing certificates (Windows & macOS)
- [ ] Test installation on clean systems
- [ ] Verify file associations work correctly
- [ ] Test theme persistence across restarts
- [ ] Verify all keyboard shortcuts function
- [ ] Test multi-window functionality
- [ ] Check syntax highlighting for various languages

### Code Signing Requirements

#### Windows
1. Purchase code signing certificate from trusted CA
2. Install certificate in Windows certificate store
3. Set `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
4. Build with signing enabled

#### macOS
1. Enroll in Apple Developer Program ($99/year)
2. Create "Developer ID Application" certificate
3. Create app-specific password for notarization
4. Set environment variables for signing and notarization
5. Build with signing and notarization enabled

### Manual Update Instructions

Since BoltPage doesn't include auto-update functionality, users need to manually update:

1. **Windows**: Download and run new MSI/NSIS installer
2. **macOS**: Download new DMG and replace application
3. **Linux**: 
   - DEB: `sudo dpkg -i boltpage_1.0.0_amd64.deb`
   - AppImage: Replace existing AppImage file
4. **CLI Binary**: Replace binary in PATH location

### File Structure After Build

```
target/release/bundle/
├── deb/
│   └── markrust_1.0.0_amd64.deb
├── appimage/
│   └── BoltPage_1.0.0_amd64.AppImage
├── dmg/
│   └── BoltPage_1.0.0_x64.dmg
├── msi/
│   └── BoltPage_1.0.0_x64_en-US.msi
└── nsis/
    └── BoltPage_1.0.0_x64-setup.exe

target/release/
├── markrust                    # CLI binary (Unix)
└── markrust.exe               # CLI binary (Windows)
```

## Installation Size Estimates

- **Windows MSI**: ~15-20MB
- **macOS DMG**: ~20-25MB  
- **Linux DEB**: ~15-20MB
- **Linux AppImage**: ~25-30MB
- **CLI Binary**: ~10-15MB

## Platform-Specific Notes

### Windows
- Requires WebView2 runtime (auto-installed by MSI)
- File associations registered during installation
- Supports both per-user and per-machine installation

### macOS
- Minimum macOS 10.13 (High Sierra)
- Uses system WebView
- Gatekeeper compatible when properly signed and notarized

### Linux
- Requires GTK 3.20+ and WebKitGTK
- Desktop integration via .desktop files
- Supports both DEB and AppImage distribution

Phase 5 implementation is now complete with full packaging configuration and documentation.