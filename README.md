# BoltPage

A fast, lightweight Markdown viewer and editor built with Rust and Tauri. BoltPage supports GitHub-flavored Markdown with syntax highlighting, multiple themes, and a multi-window interface.

![BoltPage Screenshot](BoltPage_screenshot.png)

## Foreword

This project is aggressively vibe-coded. Not blind-coded, not one-shotted, not made in one day. Most of this code was reviewed and manually approved. It does what it's supposed to. However, I did want to build an app entirely programmed by AI, and I needed a Markdown file viewer and quick editor that fit my needs.

So, BoltPage was born. It's built on Rust for speed, and implements Tauri because I am not going to supervise the creation of an entire file viewer as a test project.

BoldPage works, very well, for my use case. It's fast, lightweight, and does everything I need it to. I hope you can find some use in it too.

## AI Coding Agent notes

The project contains ai_truthfulness.md and ai_software.md. These are the actual prompts I feed to the coding agents. You will notice they are not your typical corporate speak prompts you see floating around the internet. That's because they were not written to impress you with how good I am at AI.

They were written to work, and they are battle-tested across several projects. BoltPage is simply the one I chose to share with you. Feel free to adjust and reuse, these are the real point of this distribution.

## Features

- **Fast Markdown Rendering**: Built with Rust for maximum performance
- **Multi-Window Support**: Open multiple files in separate windows, each with independent preferences
- **Syntax Highlighting**: Beautiful code block highlighting that doesn't look like a dot matrix printer made it
- **GitHub-Flavored Markdown**: Full support for GFM including tables, task lists, and more
- **Multiple File Formats**: View and edit Markdown (.md), view-only JSON, YAML, TXT, and PDF files
- **Live Preview**: See changes in real-time as you edit
- **File Watching**: Automatic detection of external file changes
- **Cross-Platform**: Available for macOS, Windows, and Linux

## Installation

### macOS

#### Direct Download
Download the latest `.dmg` file from the [Releases](https://github.com/Silverfell/BoltPage/releases) page.

### Windows

Windows builds are currently not signed. Will have to fix that if more than three of us use this.

Download the latest `.exe` installer from the [Releases](https://github.com/Silverfell/BoltPage/releases) page.

### Linux

Completely untested and unverified, but it's there.

Download the latest `.AppImage` or `.deb` package from the [Releases](https://github.com/Silverfell/BoltPage/releases) page.

## Building from Source

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Node.js](https://nodejs.org/) (v18 or later)
- Platform-specific requirements:
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio Build Tools with C++ support
  - **Linux**: Development packages (webkit2gtk, etc.)

### Build Steps

```bash
# Clone the repository
git clone https://github.com/Silverfell/BoltPage.git
cd BoltPage/boltpage

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production (unsigned)
npm run tauri build

# For signed builds (macOS/Windows), configure credentials first:
# 1. Copy the environment template
cp .env.example .env

# 2. Edit .env with your Apple/Windows signing credentials
# 3. Then run the release build script
./build-release.sh
```

### Code Signing (Optional)

For distributing signed applications:

1. **Copy the environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your credentials:**
   - **macOS**: Requires Apple Developer account, signing certificate, and app-specific password
   - **Windows**: Requires code signing certificate (optional but recommended)

3. **Run the release build:**
   ```bash
   cd boltpage
   ./build-release.sh
   ```

The `.env` file is gitignored and will never be committed. See `.env.example` for all required variables.


## Development

BoltPage is built with:
- **[Tauri](https://tauri.app/)**: Desktop application framework
- **[Rust](https://www.rust-lang.org/)**: Core application logic and markdown processing
- **[pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)**: Markdown parser
- **[syntect](https://github.com/trishume/syntect)**: Syntax highlighting
- **Vanilla JavaScript**: Frontend interface (no framework dependencies)

### CI/CD

BoltPage uses GitHub Actions for automated testing and releases:
- **Pull Request Checks**: Automated linting, testing, and build verification
- **Continuous Integration**: Validates all commits to main branch
- **Release Builds**: Creates signed installers when version tags are pushed

See [CI/CD Documentation](docs/release_CI.md) for complete details on:
- Workflow triggers and jobs
- Required GitHub secrets
- Local testing procedures
- Troubleshooting guide

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

### Important Security Notes

- Never commit `.env` files or credentials to the repository
- Use environment variables for all sensitive data
- GitHub secrets are used for CI/CD credentials

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [Tauri](https://tauri.app/)
- Markdown parsing by [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)
- Syntax highlighting by [syntect](https://github.com/trishume/syntect)
