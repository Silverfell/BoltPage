cask "boltpage" do
  version "1.4.4"
  sha256 :no_check # Replace with exact checksums per-arch below when URLs are final

  name "BoltPage"
  desc "Fast, lightweight Markdown viewer and editor"
  homepage "https://github.com/YOUR_USERNAME/BoltPage"

  # Update these URLs with your GitHub releases or hosting location
  on_arm do
    url "https://github.com/YOUR_USERNAME/BoltPage/releases/download/v#{version}/BoltPage-#{version}-arm64.dmg"
    sha256 "REPLACE_WITH_ACTUAL_SHA256_FOR_ARM64_DMG"
  end

  on_intel do
    url "https://github.com/YOUR_USERNAME/BoltPage/releases/download/v#{version}/BoltPage-#{version}-x64.dmg"
    sha256 "REPLACE_WITH_ACTUAL_SHA256_FOR_X64_DMG"
  end

  auto_updates false
  depends_on macos: ">= :catalina"

  app "BoltPage.app"

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
