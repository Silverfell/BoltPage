use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use url::Url;

const DENIED: &str = "Access denied: path not authorized";

/// The paths file I/O commands may touch: files the user explicitly opened
/// (file dialog, CLI, macOS Launch Services, recents/menu) and user-picked
/// workspace folders. Prevents a compromised webview from reading / writing
/// arbitrary files. Per-process; nothing here is persisted.
#[derive(Default)]
pub(crate) struct Grants {
    /// Canonical path strings, or the raw string for a file that did not
    /// exist when it was granted.
    /// Uses std::sync::RwLock (not tokio) so sync commands can read it.
    paths: RwLock<HashSet<String>>,

    /// Canonicalized workspace folders; any canonicalizable path under one of
    /// these is allowed (folder picks are user intent).
    dirs: RwLock<HashSet<PathBuf>>,
}

impl Grants {
    /// Verify that `path` is covered by a grant and return the canonical path
    /// to read or write. Callers use the returned path, not `path`, for I/O.
    pub(crate) fn authorize(&self, path: &str) -> Result<PathBuf, String> {
        match fs::canonicalize(path) {
            Ok(canonical) => {
                if self.covers(&canonical) {
                    Ok(canonical)
                } else {
                    Err(DENIED.to_string())
                }
            }
            Err(_) => self.authorize_not_yet_existing(path),
        }
    }

    /// A path that cannot be canonicalized (the file does not exist yet) is
    /// matched by its raw string against explicit path grants only. It never
    /// dir-matches, so `..` segments and dangling symlinks cannot ride the
    /// prefix comparison.
    fn authorize_not_yet_existing(&self, path: &str) -> Result<PathBuf, String> {
        if self
            .paths
            .read()
            .expect("grants paths lock poisoned")
            .contains(path)
        {
            Ok(PathBuf::from(path))
        } else {
            Err(DENIED.to_string())
        }
    }

    fn covers(&self, canonical: &Path) -> bool {
        self.paths
            .read()
            .expect("grants paths lock poisoned")
            .contains(canonical.to_string_lossy().as_ref())
            || self
                .dirs
                .read()
                .expect("grants dirs lock poisoned")
                .iter()
                .any(|dir| canonical.starts_with(dir))
    }

    /// Authorize `href` (a link or image source inside the document at `doc`)
    /// and return its canonical target. The document itself must be
    /// authorized. Resolution goes through a file URL join so percent-encoded
    /// paths (`my%20img.png`) decode exactly once, here. Escaping targets
    /// (`../…`, absolute paths) are only usable when an existing grant already
    /// covers them; staying under the doc's directory is treated as user
    /// intent, like a recents click.
    pub(crate) fn authorize_relative(
        &self,
        doc: &str,
        href: &str,
        allowed_exts: &[&str],
    ) -> Result<PathBuf, String> {
        self.authorize(doc)?;
        if href.trim().is_empty() {
            return Err("Empty link".to_string());
        }
        let doc_dir = Path::new(doc)
            .parent()
            .ok_or_else(|| "Document has no parent directory".to_string())?;
        let doc_dir_url = Url::from_directory_path(doc_dir)
            .map_err(|_| "Document directory is not resolvable".to_string())?;
        let joined = doc_dir_url
            .join(href)
            .map_err(|_| "Malformed link".to_string())?;
        if joined.scheme() != "file" {
            return Err("Only local file links can be opened".to_string());
        }
        let target = joined
            .to_file_path()
            .map_err(|_| "Only local file links can be opened".to_string())?;
        let canonical =
            fs::canonicalize(&target).map_err(|_| "Linked file not found".to_string())?;
        if !canonical.is_file() {
            return Err("Link target is not a file".to_string());
        }
        let ext = canonical
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        if !allowed_exts.contains(&ext.as_str()) {
            return Err(format!("Unsupported link target: .{ext}"));
        }
        let in_doc_dir = fs::canonicalize(doc_dir)
            .map(|cd| canonical.starts_with(cd))
            .unwrap_or(false);
        if !in_doc_dir && !self.covers(&canonical) {
            return Err(DENIED.to_string());
        }
        Ok(canonical)
    }

    /// Grant a single file. Stored canonical, or as the raw string when the
    /// file does not exist yet (see authorize_not_yet_existing).
    pub(crate) fn grant_path(&self, path: &str) {
        let key = fs::canonicalize(path)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string());
        self.paths
            .write()
            .expect("grants paths lock poisoned")
            .insert(key);
    }

    /// Grant a user-picked folder: any canonicalizable path under it passes
    /// authorize.
    pub(crate) fn grant_dir(&self, dir: &str) -> Result<(), String> {
        let canonical =
            fs::canonicalize(dir).map_err(|e| format!("Failed to resolve folder: {e}"))?;
        if !canonical.is_dir() {
            return Err("Not a directory".to_string());
        }
        self.dirs
            .write()
            .expect("grants dirs lock poisoned")
            .insert(canonical);
        Ok(())
    }

    /// Revoke a previously granted folder (e.g. when the user closes the
    /// workspace), so backend commands stop passing its prefix check.
    /// Best-effort: a non-canonicalizable path matches nothing in the set and
    /// is a no-op.
    pub(crate) fn revoke_dir(&self, dir: &str) {
        let Ok(canonical) = fs::canonicalize(dir) else {
            return;
        };
        self.dirs
            .write()
            .expect("grants dirs lock poisoned")
            .remove(&canonical);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn unique_temp_dir() -> PathBuf {
        let dir = env::temp_dir().join(format!("boltpage-grants-tests-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn dir_grant_allows_inside_denies_escapes() {
        let root = unique_temp_dir();
        let inside = root.join("doc.md");
        fs::write(&inside, "x").unwrap();
        let outside_dir = unique_temp_dir();
        let outside = outside_dir.join("secret.md");
        fs::write(&outside, "x").unwrap();

        let grants = Grants::default();
        assert!(grants.authorize(&s(&inside)).is_err());
        grants.grant_dir(&s(&root)).unwrap();

        // Inside the granted dir: allowed, and the canonical path comes back.
        assert_eq!(
            grants.authorize(&s(&inside)).unwrap(),
            fs::canonicalize(&inside).unwrap()
        );

        // `..` escape canonicalizes to a path outside the grant: denied.
        let escape = root
            .join("..")
            .join(outside_dir.file_name().unwrap())
            .join("secret.md");
        assert!(grants.authorize(&s(&escape)).is_err());

        // Symlink inside the root pointing outside resolves outside: denied.
        #[cfg(unix)]
        {
            let link = root.join("link.md");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(grants.authorize(&s(&link)).is_err());
        }

        // Non-canonicalizable paths never dir-match.
        assert!(grants
            .authorize(&s(&root.join("does-not-exist.md")))
            .is_err());

        // A file is not a folder grant.
        assert!(grants.grant_dir(&s(&inside)).is_err());

        // Revoking the folder ends access to everything under it.
        grants.revoke_dir(&s(&root));
        assert!(grants.authorize(&s(&inside)).is_err());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside_dir).unwrap();
    }

    #[test]
    fn path_grant_authorizes_to_canonical_path() {
        let root = unique_temp_dir();
        let file = root.join("doc.md");
        fs::write(&file, "x").unwrap();
        let other = root.join("other.md");
        fs::write(&other, "x").unwrap();

        let grants = Grants::default();
        grants.grant_path(&s(&file));

        // A non-canonical spelling of the granted file resolves to it.
        let dotted = root.join(".").join("doc.md");
        assert_eq!(
            grants.authorize(&s(&dotted)).unwrap(),
            fs::canonicalize(&file).unwrap()
        );
        // Path grants do not extend to siblings.
        assert!(grants.authorize(&s(&other)).is_err());

        // A symlink to the granted file authorizes to the file itself.
        #[cfg(unix)]
        {
            let link = root.join("link.md");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert_eq!(
                grants.authorize(&s(&link)).unwrap(),
                fs::canonicalize(&file).unwrap()
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn not_yet_existing_file_matches_by_raw_string_only() {
        let root = unique_temp_dir();
        let pending = s(&root.join("new.md"));

        let grants = Grants::default();
        assert!(grants.authorize(&pending).is_err());
        grants.grant_path(&pending);
        assert_eq!(grants.authorize(&pending).unwrap(), PathBuf::from(&pending));

        // A different spelling of the same missing file is not the grant.
        let respelled = s(&root.join("sub").join("..").join("new.md"));
        assert!(grants.authorize(&respelled).is_err());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn authorize_relative_rules() {
        let root = unique_temp_dir();
        let doc = root.join("doc.md");
        fs::write(&doc, "x").unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub").join("child.md"), "x").unwrap();
        fs::write(root.join("sibling.md"), "x").unwrap();
        fs::write(root.join("image.exe"), "x").unwrap();
        let outside = unique_temp_dir();
        fs::write(outside.join("esc.md"), "x").unwrap();

        let doc_str = s(&doc);
        let exts = &["md"];
        let grants = Grants::default();

        // The document itself must be authorized first.
        assert!(grants
            .authorize_relative(&doc_str, "sibling.md", exts)
            .is_err());
        grants.grant_path(&doc_str);

        // Same-dir and subdir targets need no grant of their own.
        let p = grants
            .authorize_relative(&doc_str, "sibling.md", exts)
            .unwrap();
        assert_eq!(p, fs::canonicalize(root.join("sibling.md")).unwrap());
        assert!(grants
            .authorize_relative(&doc_str, "sub/child.md", exts)
            .is_ok());
        // Resolving a link grants nothing by itself.
        assert!(grants.authorize(&s(&root.join("sibling.md"))).is_err());

        // Percent-encoded names decode exactly once during resolution.
        fs::write(root.join("my img.md"), "x").unwrap();
        let p = grants
            .authorize_relative(&doc_str, "my%20img.md", exts)
            .unwrap();
        assert!(p.ends_with("my img.md"));

        // Empty link, missing target and unsupported extension: refused.
        assert!(grants.authorize_relative(&doc_str, " ", exts).is_err());
        assert!(grants
            .authorize_relative(&doc_str, "nope.md", exts)
            .is_err());
        assert!(grants
            .authorize_relative(&doc_str, "image.exe", exts)
            .is_err());

        // `..` escape: denied until an existing grant covers the target.
        let esc_href = format!(
            "../{}/esc.md",
            outside.file_name().unwrap().to_string_lossy()
        );
        assert!(grants
            .authorize_relative(&doc_str, &esc_href, exts)
            .is_err());

        // An absolute POSIX href resolves; containment still applies. (On
        // Windows `C:\…` parses as a `c:` URL scheme and is refused outright,
        // which is also safe.)
        #[cfg(unix)]
        {
            assert!(grants.authorize_relative(&doc_str, &doc_str, exts).is_ok());
            let esc_abs = s(&outside.join("esc.md"));
            assert!(grants.authorize_relative(&doc_str, &esc_abs, exts).is_err());
        }

        grants.grant_dir(&s(&outside)).unwrap();
        assert_eq!(
            grants
                .authorize_relative(&doc_str, &esc_href, exts)
                .unwrap(),
            fs::canonicalize(outside.join("esc.md")).unwrap()
        );

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
