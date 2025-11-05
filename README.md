# BoltPage

A fast, lightweight Markdown viewer and editor built with Rust and Tauri. BoltPage supports GitHub-flavored Markdown with syntax highlighting, multiple themes, and a multi-window interface.

![BoltPage Screenshot](boltpage_icon.png)

## Features

- **Fast Markdown Rendering**: Built with Rust for maximum performance
- **Multi-Window Support**: Open multiple files in separate windows, each with independent preferences
- **Syntax Highlighting**: Beautiful code block highlighting with multiple themes
- **GitHub-Flavored Markdown**: Full support for GFM including tables, task lists, and more
- **Multiple File Formats**: View and edit Markdown (.md), JSON, YAML, TXT, and PDF files
- **Live Preview**: See changes in real-time as you edit
- **File Watching**: Automatic detection of external file changes
- **Cross-Platform**: Available for macOS, Windows, and Linux
- **Theme Support**: Multiple built-in themes for comfortable viewing

## Installation

### macOS

#### Homebrew (Coming Soon)
```bash
brew install --cask boltpage
```

#### Direct Download
Download the latest `.dmg` file from the [Releases](https://github.com/YOUR_USERNAME/BoltPage/releases) page.

### Windows

Download the latest `.exe` installer from the [Releases](https://github.com/YOUR_USERNAME/BoltPage/releases) page.

### Linux

Download the latest `.AppImage` or `.deb` package from the [Releases](https://github.com/YOUR_USERNAME/BoltPage/releases) page.

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
git clone https://github.com/YOUR_USERNAME/BoltPage.git
cd BoltPage/boltpage

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

For detailed build instructions, see:
- [Setup Guide](boltpage/setup_readme.md)
- [Packaging Guide](boltpage/PACKAGING.md)
- [Strict Build Instructions](boltpage/STRICT_BUILD_INSTRUCTIONS.md)

## Usage

### Opening Files

- **Double-click** any supported file type (`.md`, `.markdown`, `.json`, `.yaml`, `.txt`, `.pdf`)
- **Drag and drop** files onto the BoltPage window
- **File → Open** from the menu

### Keyboard Shortcuts

- `Cmd/Ctrl + N`: New file
- `Cmd/Ctrl + O`: Open file
- `Cmd/Ctrl + S`: Save file
- `Cmd/Ctrl + E`: Toggle edit mode
- `Cmd/Ctrl + W`: Close window

## Development

BoltPage is built with:
- **[Tauri](https://tauri.app/)**: Desktop application framework
- **[Rust](https://www.rust-lang.org/)**: Core application logic and markdown processing
- **[pulldown-cmark](https://github.com/raphlinus/pulldown-cmark)**: Markdown parser
- **[syntect](https://github.com/trishume/syntect)**: Syntax highlighting
- **Vanilla JavaScript**: Frontend interface (no framework dependencies)

### Project Structure

```
BoltPage/
├── boltpage/              # Main Tauri application
│   ├── src/              # Frontend assets (HTML, CSS, JavaScript)
│   ├── src-tauri/        # Rust backend
│   ├── markrust-core/    # Markdown processing library
│   └── Homebrew/         # Homebrew cask definition
├── astrojs_website/      # Landing page website
└── docs/                 # Additional documentation
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

### Guidelines

- Follow the existing code style
- Add tests for new features
- Update documentation as needed
- Ensure all tests pass before submitting PR

## Security

If you discover a security vulnerability, please send an email to [SECURITY_EMAIL_HERE] instead of using the issue tracker.

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

## Support

- 📖 [Documentation](https://github.com/YOUR_USERNAME/BoltPage/wiki)
- 🐛 [Issue Tracker](https://github.com/YOUR_USERNAME/BoltPage/issues)
- 💬 [Discussions](https://github.com/YOUR_USERNAME/BoltPage/discussions)

---

Made with ⚡ by the BoltPage community
