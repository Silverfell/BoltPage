# GitHub Actions Secrets Setup

This guide explains how to set up the required secrets for automated builds with code signing.

## Required Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions, then add these secrets:

### macOS Code Signing Secrets

1. **APPLE_CERTIFICATE**
   - Export your Developer ID Application certificate from Keychain Access
   - Convert to base64: `base64 -i certificate.p12`
   - Paste the base64 string as the secret value

2. **APPLE_CERTIFICATE_PASSWORD**
   - The password you used when exporting the certificate

3. **APPLE_SIGNING_IDENTITY**
   - Your signing identity (e.g., "Developer ID Application: Your Name (TEAM_ID)")
   - Found in your `tauri.conf.json` under `bundle.macOS.signingIdentity`

4. **APPLE_TEAM_ID**
   - Your Apple Developer Team ID (10 alphanumeric characters)
   - Found in Apple Developer account or in your certificate

5. **APPLE_ID**
   - Your Apple ID email address

6. **APPLE_PASSWORD**
   - Your Apple ID password (or app-specific password if 2FA is enabled)

### Windows Code Signing Secrets (Optional)

1. **WINDOWS_CERTIFICATE**
   - Export your Windows code signing certificate as PFX
   - Convert to base64: `base64 -i certificate.pfx`
   - Paste the base64 string as the secret value

2. **WINDOWS_CERTIFICATE_PASSWORD**
   - The password for your Windows certificate

## How to Export Certificates

### macOS Certificate Export
1. Open Keychain Access
2. Find your "Developer ID Application" certificate
3. Right-click → Export
4. Choose .p12 format
5. Set a password
6. Convert to base64: `base64 -i exported_certificate.p12`

### Windows Certificate Export
1. Open Certificate Manager (certmgr.msc)
2. Find your code signing certificate
3. Right-click → All Tasks → Export
4. Choose "Yes, export the private key"
5. Choose .pfx format
6. Set a password
7. Convert to base64: `base64 -i exported_certificate.pfx`

## Testing the Workflows

1. **Create a test tag**: `git tag v1.4.0-test && git push origin v1.4.0-test`
2. **Check Actions tab**: Go to your repository's Actions tab to see the build progress
3. **Download artifacts**: Once complete, download the built applications from the Actions run

## Troubleshooting

- **macOS notarization fails**: Check that your Apple ID has the correct permissions
- **Windows signing fails**: Ensure your certificate is valid and not expired
- **Build fails**: Check the Actions logs for specific error messages

## Security Notes

- Never commit certificates or passwords to your repository
- Use app-specific passwords for Apple ID if 2FA is enabled
- Regularly rotate your certificates and update the secrets

