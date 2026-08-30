cask "boltpage" do
  version "2.2.5"

  name "BoltPage"
  desc "Fast, lightweight Markdown viewer and editor"
  homepage "https://github.com/Silverfell/BoltPage"

  # Update these URLs with your GitHub releases or hosting location
  on_arm do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-arm64.dmg"
    sha256 "0a6eb743fdbec90c5de10e35829b741d444350875ad874363ce157c68ea44221"
  end

  on_intel do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-x64.dmg"
    sha256 "487739078215583fba96715e8dd48a2b1fc793f17e625b11c8711c6d782ddcb0"
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
