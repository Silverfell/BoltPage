cask "boltpage" do
  version "2.2.3"

  name "BoltPage"
  desc "Fast, lightweight Markdown viewer and editor"
  homepage "https://github.com/Silverfell/BoltPage"

  # Update these URLs with your GitHub releases or hosting location
  on_arm do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-arm64.dmg"
    sha256 "338a913434d2f7734840b3835ba483d75083b79d87bdf1c68c6711b71695ca4e"
  end

  on_intel do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-x64.dmg"
    sha256 "58f71933508d64a4de01d300addebcfae9462982ed4e8a90e488c4f0ce8e777e"
  end

  auto_updates false

  # No `depends_on macos:` minimum: Homebrew disabled that cask stanza ("no
  # replacement"). The app enforces its 10.13 floor (tauri.conf.json
  # bundle.macOS.minimumSystemVersion) at runtime instead.
  app "BoltPage.app"

  binary "#{appdir}/BoltPage.app/Contents/MacOS/BoltPage", target: "boltpage"

  # If you host releases on GitHub, uncomment this livecheck
  # livecheck do
  #   url :url
  #   strategy :github_latest
  # end

  zap trash: [
    "~/Library/Application Support/BoltPage",
    "~/Library/Application Support/com.dpm.boltpage",
    "~/Library/Application Support/com.dpm.boltpage/.boltpage.dat",
    "~/Library/Preferences/com.dpm.boltpage.plist",
    "~/Library/Saved Application State/com.dpm.boltpage.savedState",
    "~/Library/Logs/BoltPage",
  ]
end
