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
runs `release.yml`, which builds, notarizes, and uploads the arm64/x64 DMGs;
the tag must equal `v` + the `package.json` version or the workflow fails),
you **must** update the cask and push it to the tap. Otherwise existing users'
`brew upgrade --cask boltpage` never sees the new version.

The release flow is a `dev` -> `main` PR, then a lightweight tag on `main`.
From the pushed tag, `./release-build.sh` (repo root) runs the rest in order:
it checks that `v<version>` is on GitHub and its commit is on `main`, waits
(an hour by default) for the Release to be published with both DMGs and the
Windows installer, runs `update-cask.sh`, and reminds you to commit the cask on
`dev`. It builds nothing locally. `DRY_RUN=1 ./release-build.sh` does the same
checks and passes `DRY_RUN` on to `update-cask.sh`.

To run only the cask step, use the script from the repo root:

```sh
./update-cask.sh
```

It reads the version, tag and DMG names from
`boltpage/scripts/release-identity.sh` (version from `boltpage/package.json`),
downloads the published DMGs, computes their SHA256, rewrites
`Casks/boltpage.rb` (version + both checksums; the URLs interpolate
`#{version}`), and pushes the cask to the tap.
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
   (`BoltPage-<version>-arm64.dmg` / `BoltPage-<version>-x64.dmg`, as named by
   `boltpage/scripts/release-identity.sh`; `release.yml`'s rename step applies
   them). The cask spells these names itself, so update it by hand if the
   script's names ever change.
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
