Homebrew Cask: BoltPage
=======================

This folder contains a cask template for distributing BoltPage via Homebrew.

Files
- `Casks/boltpage.rb`: Cask definition with per-arch URLs and placeholders for SHA256.

Steps to Publish
1) Host notarized DMGs
   - Publish macOS arm64 and x64 DMGs at stable HTTPS URLs, e.g. GitHub Releases:
     - arm64: https://github.com/<org>/<repo>/releases/download/v1.1.0/BoltPage-1.1.0-arm64.dmg
     - x64:   https://github.com/<org>/<repo>/releases/download/v1.1.0/BoltPage-1.1.0-x64.dmg

2) Compute checksums
   - Download each DMG locally and compute SHA256:
     shasum -a 256 BoltPage-1.1.0-arm64.dmg
     shasum -a 256 BoltPage-1.1.0-x64.dmg

3) Update the cask
   - Edit `Homebrew/Casks/boltpage.rb`:
     - Replace example URLs with your hosted URLs (per-arch blocks).
     - Uncomment and set the `sha256` lines for each arch.
     - Optionally enable `livecheck` if you host on GitHub Releases.

4) Test locally
   - From the project root:
     brew install --cask --no-quarantine Homebrew/Casks/boltpage.rb
   - Verify the app launches and file associations work.

5) Publish
   Option A: Your own tap (recommended initially)
   - Create a tap repo, e.g. `github.com/<org>/homebrew-tap`.
   - Put `Casks/boltpage.rb` under that repo and push.
   - Users can install via:
     brew tap <org>/tap
     brew install --cask boltpage

   Option B: Submit to Homebrew Cask main
   - Ensure the cask follows Homebrew style/conventions and popularity guidelines.
   - Open a PR to `Homebrew/homebrew-cask` with `Casks/boltpage.rb`.

Notes
- `auto_updates false` is correct (no in-app updater).
- Minimum macOS is set to Catalina (10.15). Adjust if you support older.
- The `zap` stanza removes app data and preferences; verify paths after first install/run.

