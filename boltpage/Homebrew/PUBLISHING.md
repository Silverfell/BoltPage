Homebrew Cask: BoltPage
=======================

BoltPage is distributed via a Homebrew **tap**: [`Silverfell/homebrew-tap`](https://github.com/Silverfell/homebrew-tap)
(`brew tap Silverfell/tap`). It is **not** in Homebrew core, so it does not
appear on brew.sh and a bare `brew install --cask boltpage` will not find it
until the tap is added.

Files
- `Casks/boltpage.rb`: the canonical cask (source of truth). The same file is
  mirrored into the tap repo under `Casks/boltpage.rb`.

Required on every release
-------------------------

After the GitHub Release for `v<version>` is published (pushing the `v*` tag
runs `release.yml`, which builds, notarizes, and uploads the arm64/x64 DMGs),
you **must** update the cask and push it to the tap. Otherwise existing users'
`brew upgrade --cask boltpage` never sees the new version.

Use the script from the repo root:

```sh
./update-cask.sh
```

It reads the version from `boltpage/package.json`, downloads the published
DMGs, computes their SHA256, rewrites `Casks/boltpage.rb` (version + both
checksums; the URLs interpolate `#{version}`), and pushes the cask to the tap.
Then commit the updated `Casks/boltpage.rb` in this repo so the source stays in
sync (the script prints the exact command). Use `DRY_RUN=1 ./update-cask.sh` to
rewrite the cask locally without pushing.

Manual fallback (if not using the script)
------------------------------------------

1. Download each released DMG and compute SHA256:
   ```sh
   shasum -a 256 BoltPage-<version>-arm64.dmg
   shasum -a 256 BoltPage-<version>-x64.dmg
   ```
2. Edit `Casks/boltpage.rb`: bump `version`, and replace the per-arch `sha256`
   values. Verify the interpolated URLs match the released asset names
   (`BoltPage-<version>-arm64.dmg` / `BoltPage-<version>-x64.dmg`, produced by
   `release.yml`'s rename step).
3. Copy the file into the tap repo's `Casks/boltpage.rb`, commit, and push.

Install (for users)
--------------------

```sh
brew tap Silverfell/tap
brew trust --cask Silverfell/tap/boltpage   # third-party tap casks must be trusted before install
brew install --cask boltpage
```

Notes
- `auto_updates false` is correct (no in-app updater).
- The cask intentionally has no `depends_on macos:` minimum: current Homebrew
  has disabled that stanza ("no replacement"). The app enforces its 10.13 floor
  (`bundle.macOS.minimumSystemVersion` in `tauri.conf.json`) at runtime.
- The `zap` stanza removes app data and preferences; verify paths after a run.

Promoting to Homebrew core (later)
----------------------------------

`Homebrew/homebrew-cask` enforces a notability bar (GitHub stars/forks/watchers)
plus `brew audit --new --cask`. Revisit once the project has real traction; at
that point run `brew audit --new --cask`, fix what it flags, and open a PR.
