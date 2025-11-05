# STRICT BUILD INSTRUCTIONS - CLEAN LAUNCH SERVICES CORRECTLY

## CRITICAL RULES - FOLLOW EXACTLY:

### THE CORRECT SEQUENCE:

### 1. CONFIGURE CREDENTIALS (FIRST TIME ONLY):
- **Recommended**: Use the `.env` file approach:
  ```bash
  # Copy the template
  cp .env.example .env

  # Edit .env with your Apple Developer credentials:
  # APPLE_ID=your-apple-id@example.com
  # APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx
  # APPLE_TEAM_ID=XXXXXXXXXX
  ```
- **Alternative**: Export environment variables in your shell:
  ```bash
  export APPLE_ID="your-apple-id@example.com"
  export APPLE_PASSWORD="your-app-specific-password"
  export APPLE_TEAM_ID="YOUR_TEAM_ID"
  ```
- **Security Note**: The `.env` file is gitignored and will never be committed.

### 2. BUILD (pollution will happen - that's expected):
- Run: `./build-release.sh` (automatically loads credentials from `.env`)
- Or: `npm run tauri build`
- Build process will create pollution in Launch Services (target/release path + DMG mounts)
- This pollution is unavoidable and expected

### 3. INSTALL TO APPLICATIONS:
- Run: `rm -rf /Applications/BoltPage.app && cp -r target/release/bundle/macos/BoltPage.app /Applications/`

### 4. CLEAN UP POLLUTION AFTER BUILD:
- Clean ALL Launch Services: `lsregister -kill -r -domain local -domain system -domain user`
- Register ONLY the Applications version: `lsregister -f /Applications/BoltPage.app`
- Verify single registration: `lsregister -dump | grep -c "path.*BoltPage.app"` must equal 1

### 5. VERIFICATION COMMANDS:
```bash
# Check registrations (must be exactly 1):
lsregister -dump | grep -c "path.*BoltPage.app"

# Test double-click works and loads content:
open test-file.md && sleep 3 && ps aux | grep boltpage

# Check no launch-disabled flags:
lsregister -dump | grep -A20 BoltPage | grep "launch-disabled"
```

### KEY INSIGHT:
- `lsregister -f` ADDS registrations, doesn't replace them
- Clean Launch Services AFTER build when pollution already exists
- Don't try to prevent pollution - clean it up after it happens

## NEVER FORGET: CLEANUP AFTER POLLUTION, NOT BEFORE