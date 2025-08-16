# BoltPage Development Setup Guide

This guide provides detailed instructions for setting up the BoltPage development environment on Windows and macOS.

## Prerequisites

BoltPage is built with Tauri 2.0, which requires Rust for the backend and Node.js for the development toolchain.

### System Requirements

- **Windows**: Windows 10 version 1803+ or Windows 11
- **macOS**: macOS 10.15+ (Catalina or later)
- **RAM**: 4GB minimum, 8GB recommended
- **Storage**: 2GB free space for development tools and dependencies

## Installation Guide

### Windows Setup

#### 1. Install Microsoft C++ Build Tools
```bash
# Option A: Using winget (Windows 10 1809+/Windows 11)
winget install Microsoft.VisualStudio.2022.BuildTools

# Option B: Manual download
# Visit: https://visualstudio.microsoft.com/visual-cpp-build-tools/
# Select "Desktop development with C++" workload during installation
```

#### 2. Install WebView2 Runtime
WebView2 is pre-installed on Windows 10 (1803+) and Windows 11. If needed:
```bash
# Download and install WebView2 Evergreen Runtime from:
# https://developer.microsoft.com/en-us/microsoft-edge/webview2/
```

#### 3. Install Rust
```bash
# Install Rust using winget
winget install --id Rustlang.Rustup

# Restart terminal, then set MSVC toolchain as default
rustup default stable-msvc

# Verify installation
rustc --version
cargo --version
```

#### 4. Install Node.js
```bash
# Install Node.js LTS using winget
winget install OpenJS.NodeJS.LTS

# Or download from: https://nodejs.org/
# Verify installation
node --version
npm --version
```

#### 5. Install Tauri CLI
```bash
npm install --save-dev @tauri-apps/cli@latest
```

### macOS Setup

#### 1. Install Xcode
```bash
# Install from Mac App Store or download from Apple Developer
# After installation, launch Xcode to accept license and complete setup

# Verify Xcode Command Line Tools
xcode-select --install
```

#### 2. Install Rust
```bash
# Install Rust using official installer
curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh

# Restart terminal, then verify installation
rustc --version
cargo --version
```

#### 3. Install Node.js
```bash
# Option A: Download LTS from https://nodejs.org/

# Option B: Using Homebrew
brew install node@lts

# Verify installation
node --version
npm --version
```

#### 4. Install Tauri CLI
```bash
npm install --save-dev @tauri-apps/cli@latest
```

## Project Setup

### 1. Clone the Repository
```bash
git clone <repository-url>
cd markrust
```

### 2. Install Dependencies
```bash
# Install Node.js dependencies
npm install

# Rust dependencies will be installed automatically during build
```

### 3. Build the Project

#### Development Build
```bash
# Build and run in development mode with hot reload
npm run tauri dev
```

#### Release Build
```bash
# Build optimized release version
npm run tauri build
```

The built application will be available in:
- **Windows**: `target/release/bundle/msi/BoltPage_1.0.0_x64_en-US.msi`
- **macOS**: `target/release/bundle/macos/BoltPage.app` and `target/release/bundle/dmg/BoltPage_1.0.0_aarch64.dmg`

### 4. Install Application (macOS)
```bash
# Copy to Applications folder
cp -R target/release/bundle/macos/BoltPage.app /Applications/

# Register file associations (optional)
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f /Applications/BoltPage.app
```

### 5. Install Application (Windows)
```bash
# Run the MSI installer
target/release/bundle/msi/BoltPage_1.0.0_x64_en-US.msi
```

## Project Structure

```
markrust/
├── src/                    # Frontend files (HTML, CSS, JS)
├── src-tauri/             # Tauri Rust application
│   ├── src/
│   │   ├── main.rs        # CLI entry point
│   │   └── lib.rs         # Main application logic
│   ├── capabilities/      # ACL permissions
│   └── Cargo.toml         # Rust dependencies
├── markrust-core/         # Core Markdown parsing library
├── package.json           # Node.js dependencies
└── tauri.conf.json        # Tauri configuration
```

## Development Commands

```bash
# Development with hot reload
npm run tauri dev

# Build release version
npm run tauri build

# Run Rust tests
cargo test

# Test core library specifically
cargo test -p markrust-core

# Run CLI version directly
./target/debug/markrust [file.md]
./target/release/markrust [file.md]
```

## Troubleshooting

### Common Issues

#### Windows
- **Build fails**: Ensure Visual Studio Build Tools are installed with C++ workload
- **WebView2 missing**: Download WebView2 Runtime from Microsoft
- **Permission errors**: Run terminal as Administrator if needed

#### macOS
- **Build fails**: Ensure Xcode is installed and license accepted
- **Code signing**: Developer ID required for distribution
- **Permission denied**: Use `chmod +x` to make scripts executable

#### Both Platforms
- **Rust not found**: Restart terminal after Rust installation
- **Node.js issues**: Ensure Node.js 18+ LTS version is installed
- **Build slow**: Initial builds are slow due to Rust compilation; subsequent builds are faster

### Getting Help

- **Tauri Documentation**: https://v2.tauri.app/
- **Rust Documentation**: https://doc.rust-lang.org/
- **Project Issues**: Check repository issues for known problems

## Features

BoltPage includes:
- Real-time Markdown preview with syntax highlighting
- Multiple themes (light, dark, system, drac)
- File watching with auto-refresh indicators
- Integrated plain-text editor
- Multiple window support
- Persistent window sizing preferences
- GitHub-flavored Markdown support
- Cross-platform file associations

## License

[Add your license information here]