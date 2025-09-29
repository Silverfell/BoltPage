cask "boltpage" do
  version "1.4.4"
  sha256 :no_check # Replace with exact checksums per-arch below when URLs are final

  name "BoltPage"
  desc "Fast, lightweight Markdown viewer and editor"
  homepage "https://github.com/markrust/boltpage"

  # Provide separate URLs and sha256 for each architecture once hosted
  on_arm do
    url "https://example.com/downloads/BoltPage-#{version}-arm64.dmg",
        verified: "example.com/downloads/"
    # sha256 "REPLACE_WITH_SHA256_FOR_ARM64_DMG"
  end

  on_intel do
    url "https://example.com/downloads/BoltPage-#{version}-x64.dmg",
        verified: "example.com/downloads/"
    # sha256 "REPLACE_WITH_SHA256_FOR_X64_DMG"
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
