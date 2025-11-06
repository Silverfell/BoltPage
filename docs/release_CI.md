# BoltPage CI/CD Documentation

This document describes the Continuous Integration and Continuous Deployment (CI/CD) setup for BoltPage.

## Overview

BoltPage uses GitHub Actions for automated testing, building, and releasing. The CI/CD pipeline consists of three main workflows:

1. **Pull Request Checks** (`pr-checks.yml`) - Validates PRs before merging
2. **Continuous Integration** (`ci.yml`) - Validates main branch after merging
3. **Release** (`release.yml`) - Creates signed releases when version tags are pushed

---

## Workflow Details

### 1. Pull Request Checks (`.github/workflows/pr-checks.yml`)

**Triggers:**
- Opening a pull request to `main`, `master`, or `develop`
- Updating a pull request
- Manual trigger via GitHub UI

**Jobs:**

#### a. Lint and Format Check
- **Purpose**: Ensure code follows style guidelines
- **Runs on**: Ubuntu
- **Checks**:
  - `cargo fmt --check` - Validates Rust code formatting
  - `cargo clippy` - Runs Rust linter with warnings as errors
- **Fast fail**: Stops other jobs if this fails

#### b. Test Suite
- **Purpose**: Run all tests across platforms
- **Runs on**: Ubuntu, macOS, Windows
- **Checks**:
  - `cargo test` - Runs all unit and integration tests
  - Tests run on all three platforms in parallel
- **Matrix strategy**: Tests all platforms simultaneously

#### c. Build Verification
- **Purpose**: Ensure application builds successfully (unsigned)
- **Runs on**: Ubuntu, macOS, Windows
- **Dependencies**: Requires lint and test to pass first
- **Checks**:
  - Full Tauri build without code signing
  - Verifies build artifacts are created
  - Tests cross-platform compatibility

#### d. PR Checks Summary
- **Purpose**: Provide final status for the PR
- **Always runs**: Even if other jobs fail
- **Action**: Fails the workflow if any check failed

**Usage:**
```bash
# PRs are automatically checked when opened/updated
# No manual action needed

# To test locally before opening PR:
cd boltpage
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all --all-features
npm run tauri build
```

---

### 2. Continuous Integration (`.github/workflows/ci.yml`)

**Triggers:**
- Push to `main`, `master`, or `develop` branches
- Manual trigger via GitHub UI

**Jobs:**

#### a. Quick Check
- **Purpose**: Fast validation that code compiles
- **Runs on**: Ubuntu
- **Checks**: `cargo check` with all features

#### b. Lint
- **Purpose**: Code quality checks
- **Dependencies**: Requires quick check to pass
- **Checks**:
  - Format validation
  - Clippy lints

#### c. Test (Matrix)
- **Purpose**: Comprehensive testing
- **Runs on**: Ubuntu, macOS, Windows
- **Dependencies**: Requires quick check to pass
- **Checks**:
  - All unit tests
  - Integration tests
  - Doc tests

#### d. Build (Matrix)
- **Purpose**: Full build verification
- **Runs on**: Ubuntu, macOS, Windows
- **Dependencies**: Requires lint and test to pass
- **Checks**: Complete unsigned build on all platforms

#### e. CI Success
- **Purpose**: Final status indicator
- **Always runs**: Provides comprehensive status
- **Action**: Posts success message with commit info

**Usage:**
```bash
# Automatically runs when code is pushed to main/master/develop
# Ensures main branch is always in a buildable state

# To test locally:
cd boltpage
cargo check --all-targets --all-features
cargo test --all --all-features
cargo test --doc
npm run tauri build
```

---

### 3. Release (`.github/workflows/release.yml`)

**Triggers:**
- Push of version tags (e.g., `v1.4.5`, `v2.0.0`)
- Manual trigger via GitHub UI

**Jobs:**

#### a. Build macOS
- **Purpose**: Create signed, notarized macOS DMG
- **Runs on**: macOS
- **Steps**:
  1. Setup Apple certificates in temporary keychain
  2. Build application with signing
  3. Notarize with Apple
  4. Staple notarization ticket
  5. Upload DMG as artifact
- **Required Secrets**:
  - `APPLE_CERTIFICATE` - Base64-encoded Developer ID cert
  - `APPLE_CERTIFICATE_PASSWORD` - Certificate password
  - `APPLE_SIGNING_IDENTITY` - Signing identity string
  - `APPLE_TEAM_ID` - Apple Developer Team ID
  - `APPLE_ID` - Apple ID email
  - `APPLE_PASSWORD` - App-specific password

#### b. Build Windows
- **Purpose**: Create signed Windows installer
- **Runs on**: Windows
- **Steps**:
  1. Setup Windows code signing certificate
  2. Build NSIS installer with signing
  3. Upload installer as artifact
- **Optional Secrets**:
  - `WINDOWS_CERTIFICATE` - Base64-encoded PFX cert
  - `WINDOWS_CERTIFICATE_PASSWORD` - Certificate password

#### c. Create Release
- **Purpose**: Publish GitHub release with artifacts
- **Dependencies**: Requires macOS and Windows builds to complete
- **Only runs**: When triggered by a version tag
- **Actions**:
  1. Download build artifacts from previous jobs
  2. Create GitHub release with tag name
  3. Upload DMG and EXE to release
  4. Mark as published (not draft)
- **Uses**: `GITHUB_TOKEN` (automatically provided)

**Usage:**
```bash
# 1. Update version in all files
npm version patch  # or minor, major
# This updates package.json

# 2. Ensure versions are synchronized
cd boltpage
./build-release.sh  # Updates all version numbers

# 3. Commit version bump
git add -A
git commit -m "Bump version to X.Y.Z"
git push

# 4. Create and push tag
git tag v1.4.5
git push origin v1.4.5

# 5. GitHub Actions will automatically:
#    - Build signed macOS DMG
#    - Build signed Windows installer
#    - Create GitHub release
#    - Upload artifacts

# 6. Monitor progress:
# Go to: https://github.com/YOUR_USERNAME/BoltPage/actions
```

---

## Required GitHub Secrets

Set these in: `Settings → Secrets and variables → Actions`

### macOS Code Signing (Required for releases)

| Secret Name | Description | How to Get |
|------------|-------------|------------|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` certificate | Export from Keychain, then: `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the certificate | Password used when exporting cert |
| `APPLE_SIGNING_IDENTITY` | Full signing identity | e.g., `"Developer ID Application: Name (TEAMID)"` |
| `APPLE_TEAM_ID` | 10-character team ID | Found in Apple Developer account |
| `APPLE_ID` | Apple ID email | Your Apple Developer email |
| `APPLE_PASSWORD` | App-specific password | Generate at appleid.apple.com |

### Windows Code Signing (Optional for releases)

| Secret Name | Description | How to Get |
|------------|-------------|------------|
| `WINDOWS_CERTIFICATE` | Base64-encoded `.pfx` certificate | `base64 -i cert.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | Certificate password | Password for your Windows cert |

**Note**: `GITHUB_TOKEN` is automatically provided and doesn't need to be set.

---

## Workflow File Locations

All workflows are in the `.github/workflows/` directory:

```
.github/workflows/
├── ci.yml           # Continuous Integration (main branch)
├── pr-checks.yml    # Pull Request validation
└── release.yml      # Release builds and publishing
```

**Previously**: Workflows were duplicated in `boltpage/.github/workflows/` - these have been consolidated.

---

## Local Testing

Before pushing code or opening a PR, test locally:

### Quick Validation
```bash
cd boltpage

# Check formatting
cargo fmt --all -- --check

# Run linter
cargo clippy --all-targets --all-features -- -D warnings

# Run tests
cargo test --all --all-features --verbose
```

### Full Build Test
```bash
cd boltpage

# Install dependencies
npm ci

# Build (unsigned)
npm run tauri build

# For signed build (requires .env setup):
cp .env.example .env
# Edit .env with your credentials
./build-release.sh
```

### Fix Common Issues
```bash
# Fix formatting automatically
cargo fmt --all

# Fix some Clippy warnings automatically
cargo clippy --all-targets --all-features --fix
```

---

## Caching Strategy

All workflows use GitHub Actions caching to speed up builds:

- **Cargo registry** - Downloaded crates
- **Cargo git** - Git dependencies
- **Cargo target** - Compiled artifacts
- **npm packages** - Node.js dependencies

Cache keys are based on:
- Operating system
- `Cargo.lock` hash (Rust dependencies)
- `package-lock.json` hash (npm dependencies)

**Cache invalidation**: Automatically happens when dependencies change.

---

## Troubleshooting

### PR Checks Failing

**Formatting errors:**
```bash
# Fix locally
cd boltpage
cargo fmt --all
git commit -am "Fix formatting"
git push
```

**Clippy warnings:**
```bash
# See what's wrong
cargo clippy --all-targets --all-features

# Fix automatically where possible
cargo clippy --all-targets --all-features --fix

# Or fix manually and commit
```

**Test failures:**
```bash
# Run tests locally to see failures
cargo test --all --all-features --verbose

# Run specific test
cargo test test_name -- --nocapture

# Run tests for specific package
cargo test -p markrust-core
```

**Build failures:**
```bash
# Try clean build
cargo clean
npm run tauri build

# Check for missing system dependencies (Linux)
sudo apt-get install libwebkit2gtk-4.0-dev libgtk-3-dev
```

### Release Failures

**macOS signing fails:**
- Verify `APPLE_CERTIFICATE` secret is correct base64
- Check `APPLE_SIGNING_IDENTITY` matches certificate exactly
- Ensure certificate is not expired
- Verify Team ID is correct

**macOS notarization fails:**
- Check `APPLE_PASSWORD` is an app-specific password (not main password)
- Verify Apple ID has appropriate permissions
- Check notarization status: `xcrun notarytool history --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID"`

**Windows signing fails:**
- Verify certificate is not expired
- Check certificate password is correct
- Ensure certificate is properly encoded: `base64 -i cert.pfx | pbcopy`

**Release not created:**
- Ensure tag starts with `v` (e.g., `v1.4.5` not `1.4.5`)
- Check both build jobs completed successfully
- Verify `GITHUB_TOKEN` permissions (should be automatic)

---

## Platform-Specific Notes

### Ubuntu/Linux
- Requires WebKit2GTK and GTK3 development packages
- Installed automatically in workflows
- For local development: `sudo apt-get install libwebkit2gtk-4.0-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`

### macOS
- Requires Xcode Command Line Tools
- Code signing requires Apple Developer account ($99/year)
- Notarization is mandatory for distribution outside App Store

### Windows
- Requires Visual Studio Build Tools
- Code signing is optional but recommended
- NSIS is installed automatically in workflows

---

## Best Practices

### For Contributors

1. **Before opening PR**:
   - Run `cargo fmt --all`
   - Run `cargo clippy` and fix warnings
   - Run `cargo test` and ensure all tests pass
   - Test build locally if making significant changes

2. **PR description**:
   - Describe what changed and why
   - Reference related issues
   - Note any breaking changes

3. **Respond to CI failures**:
   - Check CI logs for specific errors
   - Fix issues and push updates
   - Don't merge until all checks pass

### For Maintainers

1. **Merging PRs**:
   - Ensure all CI checks pass
   - Review code changes thoroughly
   - Squash commits if history is messy
   - Use clear merge commit messages

2. **Creating releases**:
   - Update CHANGELOG.md (if exists)
   - Bump version in package.json
   - Run `./build-release.sh` to sync versions
   - Commit version bump
   - Create and push tag
   - Monitor release workflow
   - Test downloaded artifacts

3. **Managing secrets**:
   - Rotate certificates before expiration
   - Use app-specific passwords (don't share main password)
   - Document secret updates in team notes
   - Test release workflow after updating secrets

---

## Workflow Comparison

| Feature | PR Checks | CI (Main) | Release |
|---------|-----------|-----------|---------|
| **Trigger** | Pull requests | Push to main | Version tags |
| **Purpose** | Validate before merge | Validate after merge | Create signed builds |
| **Platforms** | All three | All three | macOS + Windows |
| **Signing** | No | No | Yes |
| **Artifacts** | Temporary | Temporary | Published release |
| **Duration** | ~15-20 min | ~15-20 min | ~30-45 min |
| **Cost** | Free (2000 min/month) | Free | Free |

---

## GitHub Actions Usage

BoltPage uses GitHub Actions free tier:
- **2000 minutes/month** for private repos (10x multiplier for macOS)
- **Unlimited** for public repos

**Estimated usage per workflow:**
- PR checks: ~15 minutes (all platforms)
- CI: ~15 minutes (all platforms)
- Release: ~30 minutes (signed builds + notarization)

**With typical usage** (10 PRs/month, 20 commits to main, 2 releases):
- Public repo: ✅ No limits
- Private repo: ~700 minutes/month (within free tier)

---

## Future Improvements

Potential enhancements for the CI/CD pipeline:

- [ ] Add code coverage reporting (e.g., codecov)
- [ ] Add security scanning (e.g., cargo-audit)
- [ ] Add dependency updates bot (e.g., Dependabot)
- [ ] Add benchmarking for performance regressions
- [ ] Add Linux AppImage/DEB to release workflow
- [ ] Add automated changelog generation
- [ ] Add semantic versioning validation
- [ ] Add draft release support for testing
- [ ] Add release notes from commit messages

---

## Additional Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Tauri GitHub Actions Guide](https://tauri.app/v1/guides/building/cross-platform#github-actions)
- [Apple Notarization Guide](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Rust CI Best Practices](https://doc.rust-lang.org/cargo/guide/continuous-integration.html)

---

## Support

If you encounter issues with CI/CD:

1. Check workflow logs in GitHub Actions tab
2. Review this documentation
3. Check [PACKAGING.md](../boltpage/PACKAGING.md) for build requirements
4. Open an issue with:
   - Workflow name and run URL
   - Error messages from logs
   - What you've tried already

---

*Last updated: November 2025*
