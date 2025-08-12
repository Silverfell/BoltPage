# STRICT BUILD INSTRUCTIONS - CLEAN LAUNCH SERVICES CORRECTLY

## CRITICAL RULES - FOLLOW EXACTLY:

### THE CORRECT SEQUENCE:

### 1. BUILD FIRST (pollution will happen - that's expected):
- Run: `APPLE_ID="igor@danceinpalemoonlight.com" APPLE_PASSWORD="ggsn-xche-bjzl-hzyh" APPLE_TEAM_ID="U59VVNHDJC" npm run tauri build`
- Build process will create pollution in Launch Services (target/release path + DMG mounts)
- This pollution is unavoidable and expected

### 2. INSTALL TO APPLICATIONS:
- Run: `rm -rf /Applications/BoltPage.app && cp -r target/release/bundle/macos/BoltPage.app /Applications/`

### 3. CLEAN UP POLLUTION AFTER BUILD:
- Clean ALL Launch Services: `lsregister -kill -r -domain local -domain system -domain user`
- Register ONLY the Applications version: `lsregister -f /Applications/BoltPage.app`
- Verify single registration: `lsregister -dump | grep -c "path.*BoltPage.app"` must equal 1

### 4. VERIFICATION COMMANDS:
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