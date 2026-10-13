cask "boltpage" do
  version "3.0.0"

  name "BoltPage"
  desc "Fast, lightweight Markdown viewer and editor"
  homepage "https://github.com/Silverfell/BoltPage"

  # Update these URLs with your GitHub releases or hosting location
  on_arm do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-arm64.dmg"
    sha256 "26a42ab6af7b6d877fb9a50d96fcb944d5d674bac67a0418e6f94893ba50f643"
  end

  on_intel do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-x64.dmg"
    sha256 "5074d7df9081a3e82b346bb94189718efa18c14c22f109e491e63bee7fea9ed0"
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
