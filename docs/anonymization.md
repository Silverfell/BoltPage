# Open-Sourcing BoltPage Safely (Privacy & Signing Guide)

This guide documents how to open-source BoltPage without exposing your personal identity or credentials, and how to produce signed, notarized builds for macOS (and iOS, if/when you add mobile) using secure practices.

## Objectives
- Remove any hard‑coded credentials or personal identifiers from the repo.
- Parameterize signing and notarization so they run only with local env vars or CI secrets.
- Keep a clean public history (no leaked secrets), and a clear release process.

## 1) Inventory: Where secrets and identifiers can hide
- `boltpage/build-release.sh`: Look for hardcoded `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, etc.
- `boltpage/src-tauri/tauri.conf.json`: Signing fields, bundle metadata (names, homepage, license).
- `boltpage/src-tauri/Info.plist`: Any personal names, emails, or Team IDs.
- `.github/workflows/*`: Environment variables, signing steps, debugging echos.
- Any `.env*` files, logs, temporary scripts, or local caches mistakenly committed.

Action: Remove/neutralize anything personal or secret from versioned files. Store values only in your local environment or CI secrets.

## 2) Remove secrets from the repo (and history)
- Stop committing secrets:
  - Delete fallback defaults from `build-release.sh` (require env vars only).
  - Don’t commit `.env*` files, certificates, or private keys.
- Scrub past commits if secrets were already pushed:
  - Using git-filter-repo (recommended):
    ```bash
    pipx install git-filter-repo  # or use your package manager
    git filter-repo --path-glob 'boltpage/build-release.sh' --replace-text replacements.txt
    # or remove files entirely:
    git filter-repo --invert-paths --path .env --path-glob '*.pfx' --path-glob '*.p12'
    ```
  - Using BFG Repo-Cleaner (alternative):
    ```bash
    java -jar bfg.jar --delete-files .env --delete-files '*.pfx' --delete-files '*.p12'
    ```
- After scrubbing, rotate all exposed credentials (Apple app‑specific password, API keys, cert passwords).

## 3) Parameterize signing & notarization (no secrets in code)
Prefer Apple’s App Store Connect API Key (notarytool) over Apple ID password. Use CI/Keychain to supply secrets at build time.

### macOS (Developer ID Application + Notarization)
Prereqs:
- Xcode + Command Line Tools installed.
- A “Developer ID Application” certificate in your login Keychain (downloaded from Apple Developer portal).
- App Store Connect API Key (.p8), with Key ID and Issuer ID.

Signing & Notarization (local, stable approach):
1) Build the app with Tauri (unsigned or signed by identity from Keychain):
   ```bash
   npm run tauri build
   # or directly build the app bundle then sign via codesign
   ```
2) Codesign (if not fully handled by Tauri):
   ```bash
   codesign \
     --deep --force --options runtime --timestamp \
     --sign "Developer ID Application: Your Company (TEAMID)" \
     path/to/BoltPage.app
   ```
3) Notarize with notarytool (API key recommended):
   ```bash
   # Option A: Store credentials profile once
   xcrun notarytool store-credentials BoltPageNotary \
     --key /path/to/AuthKey_ABC123XYZ.p8 \
     --key-id ABC123XYZ \
     --issuer 00112233-4455-6677-8899-aabbccddeeff

   # Option B: Provide inline each time (CI-friendly)
   xcrun notarytool submit BoltPage.app \
     --key /path/to/AuthKey_ABC123XYZ.p8 \
     --key-id ABC123XYZ \
     --issuer 00112233-4455-6677-8899-aabbccddeeff \
     --wait
   ```
4) Staple the ticket:
   ```bash
   xcrun stapler staple BoltPage.app
   # If you ship a DMG:
   xcrun stapler staple BoltPage.dmg
   ```

Notes:
- You can also notarize the DMG directly after signing its contents.
- For CI, store the `.p8` as an encrypted/secret artifact or convert to base64 and reconstruct at runtime.

### iOS (when/if you add mobile)
Tauri 2 supports iOS, but the current project is desktop-focused. High-level steps:
1) Initialize iOS target:
   ```bash
   npm run tauri ios init
   # or: tauri ios init
   ```
2) Create an App ID and Provisioning Profiles in Apple Developer account.
3) Open the generated Xcode project (under `src-tauri/gen/apple/ios`), set the Team, Bundle ID, and signing.
4) Build & sign from Xcode (or `xcodebuild`) using your iOS signing identities and profiles.
5) Distribute via TestFlight/App Store Connect as needed.

Keep iOS signing strictly in Xcode/Keychain or CI secrets. Do not commit profiles, certs, or developer info.

## 4) Secure CI (GitHub Actions)
- Store secrets in GitHub Actions Secrets:
  - macOS: `APPLE_API_KEY_BASE64` (or secure file), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, optional keychain passwords.
  - Windows: `WIN_CERT_BASE64`, `WIN_CERT_PASSWORD` (if signing on Windows).
- Never `echo` secrets; mask env; avoid dumping environment.
- Separate workflows:
  - PR builds: unsigned artifacts only.
  - Protected branch/tag builds: signed + notarized using secrets.
- Restrict who can trigger release workflows (required reviewers/environments).

## 5) Remove personal identifiers
- `Info.plist`: Keep generic names; avoid personal email/name. Don’t commit team‑specific signing fields.
- `tauri.conf.json`: Replace “Proprietary” with your open-source license; avoid embedding personal email.
- README/Docs: Scrub personal contact data you don’t want public.

## 6) App identifiers & associations
- Bundle Identifier (macOS): Keep stable if you want users to upgrade seamlessly. You do not need to commit the signing identity.
- File associations (PDF/JSON/YAML/TXT): Safe to keep public. They are not secrets and are applied only from installed builds.

## 7) Local dev vs. public builds
- Local dev: Unsigned builds are fine. Sign only when producing public releases.
- Public releases: Build via CI with secrets; produce signed/notarized DMG for macOS and (optionally) signed Windows installers.

## 8) Example: macOS signed & notarized release (CI outline)
```yaml
name: Release macOS
on:
  workflow_dispatch:
  push:
    tags: [ 'v*' ]
jobs:
  mac:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - uses: dtolnay/rust-toolchain@stable
      - name: Install deps
        run: npm ci --prefix boltpage
      - name: Build (unsigned or signed by Keychain identity)
        run: npm run tauri build --prefix boltpage
      - name: Notarize app
        env:
          APPLE_API_KEY_BASE64: ${{ secrets.APPLE_API_KEY_BASE64 }}
          APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
        run: |
          echo "$APPLE_API_KEY_BASE64" | base64 --decode > AuthKey.p8
          xcrun notarytool submit boltpage/target/release/bundle/macos/BoltPage.app \
            --key AuthKey.p8 \
            --key-id "$APPLE_API_KEY_ID" \
            --issuer "$APPLE_API_ISSUER" \
            --wait
          xcrun stapler staple boltpage/target/release/bundle/macos/BoltPage.app
          # staple DMG if created
          if ls boltpage/target/release/bundle/dmg/*.dmg >/dev/null 2>&1; then
            xcrun stapler staple boltpage/target/release/bundle/dmg/*.dmg
          fi
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: macos-signed
          path: |
            boltpage/target/release/bundle/macos/BoltPage.app
            boltpage/target/release/bundle/dmg/*.dmg
```

## 9) Licensing & public metadata
- Choose a license: MIT or Apache‑2.0 are common. Add `LICENSE` at repo root.
- Update `tauri.conf.json` `bundle.license` and `homepage` to non‑personal values.
- Consider a `SECURITY.md` explaining how to report vulnerabilities.

## 10) Final checklist before making the repo public
- [ ] Remove all secret defaults from scripts/configs; rely on env/CI.
- [ ] Add `.gitignore` for `.env*`, certs, and OS junk.
- [ ] Scrub history if any secrets were ever committed; rotate credentials.
- [ ] Update license and metadata (no personal emails/names unless intended).
- [ ] Validate signed & notarized macOS build using local env or CI secrets.
- [ ] Validate Windows build (optional signing) and associations.
- [ ] Re‑audit `Info.plist` and workflows for identifiers.

---

If you want, I can apply these changes in the repo next (strip defaults, sanitize configs, and add a clean macOS notary flow in CI), then guide you through history scrubbing before flipping the repo public.
