cask "boltpage" do
  version "2.2.1"

  name "BoltPage"
  desc "Fast, lightweight Markdown viewer and editor"
  homepage "https://github.com/Silverfell/BoltPage"

  # Update these URLs with your GitHub releases or hosting location
  on_arm do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-arm64.dmg"
    sha256 "0f78d8c98452a11e97f5ac163e207c7d3f15464b963c0bd57708df309ae0d539"
  end

  on_intel do
    url "https://github.com/Silverfell/BoltPage/releases/download/v#{version}/BoltPage-#{version}-x64.dmg"
    sha256 "bd149007a59e3788eae8aac8722fc583bbafef239eb109c26a32d953744edef3"
  end

  auto_updates false
  # Matches bundle.macOS.minimumSystemVersion (10.13) in tauri.conf.json,
  # which is also Tauri 2's default deployment target.
  depends_on macos: :high_sierra

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
