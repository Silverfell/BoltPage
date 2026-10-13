cask "boltpage" do
  version "3.1.1"

  name "BoltPage"
  desc "Fast, lightweight Markdown viewer and editor"
  homepage "https://github.com/Silverfell/BoltPage"

  # Update these URLs with your GitHub releases or hosting location
  on_arm do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-arm64.dmg"
    sha256 "04e0f142c929ca5456e98ebbe727d7e7816be16b5b2ff1a21d1c753eb373bd61"
  end

  on_intel do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-x64.dmg"
    sha256 "369a1e8beb975dc07f28c29be489b7d849ac62c3327cc223a8d0b5ebd7636ea2"
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
