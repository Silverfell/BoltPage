use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::io;
use crate::prefs;

/// Extensions surfaced in the workspace tree and quick switcher; matches the
/// render allowlist plus pdf (viewable).
const WORKSPACE_EXTENSIONS: &[&str] = &["md", "markdown", "json", "yaml", "yml", "txt", "pdf"];

/// Quick-switcher index caps; truncation is reported, never silent.
const MAX_WORKSPACE_FILES: usize = 2000;
const MAX_WORKSPACE_DEPTH: usize = 8;

fn is_supported_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| WORKSPACE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Debug, Serialize)]
pub(crate) struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkspaceFiles {
    pub files: Vec<DirEntryInfo>,
    pub truncated: bool,
}

fn list_dir_inner(dir: &Path) -> Result<Vec<DirEntryInfo>, String> {
    let rd = fs::read_dir(dir).map_err(|e| format!("Failed to read folder: {e}"))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = path.is_dir();
        if !is_dir && !is_supported_file(&path) {
            continue;
        }
        out.push(DirEntryInfo {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn walk_workspace(
    dir: &Path,
    root: &Path,
    canonical_root: &Path,
    depth: usize,
    out: &mut Vec<DirEntryInfo>,
    truncated: &mut bool,
) {
    if depth > MAX_WORKSPACE_DEPTH {
        *truncated = true;
        return;
    }
    let Ok(entries) = list_dir_inner(dir) else {
        return;
    };
    for entry in entries {
        if out.len() >= MAX_WORKSPACE_FILES {
            *truncated = true;
            return;
        }
        let path = PathBuf::from(&entry.path);
        if entry.is_dir {
            // Don't follow directory symlinks that escape the workspace: only
            // recurse when the canonical target stays under the granted root,
            // so the index can't disclose paths outside the folder.
            match fs::canonicalize(&path) {
                Ok(canon) if canon.starts_with(canonical_root) => {
                    walk_workspace(&path, root, canonical_root, depth + 1, out, truncated);
                }
                _ => continue,
            }
        } else {
            // Join components with '/' explicitly so switcher labels are
            // identical across platforms (Windows would otherwise emit '\').
            let rel = path
                .strip_prefix(root)
                .map(|p| {
                    p.components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/")
                })
                .unwrap_or(entry.name.clone());
            out.push(DirEntryInfo {
                name: rel,
                path: entry.path,
                is_dir: false,
            });
        }
    }
}

// --- Tauri commands ---

#[tauri::command]
pub(crate) async fn open_folder_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let app_clone = app.clone();
    let folder = tauri::async_runtime::spawn_blocking(move || {
        app_clone.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    let Some(folder) = folder else {
        return Ok(None);
    };
    let folder_str = folder.to_string();
    io::allow_dir(&app, &folder_str)?;
    prefs::save_preference_key_inner(
        &app,
        "workspace_folder",
        serde_json::Value::String(folder_str.clone()),
    )
    .await?;
    Ok(Some(folder_str))
}

/// Returns the persisted workspace folder, re-granting directory access (the
/// allow set is per-process; the pref carries the user's pick across
/// launches). None when unset or no longer a directory.
#[tauri::command]
pub(crate) async fn get_workspace_folder(app: AppHandle) -> Result<Option<String>, String> {
    let Some(folder) = prefs::read_string_pref(&app, "workspace_folder") else {
        return Ok(None);
    };
    if !Path::new(&folder).is_dir() {
        return Ok(None);
    }
    io::allow_dir(&app, &folder)?;
    Ok(Some(folder))
}

#[tauri::command]
pub(crate) async fn clear_workspace_folder(app: AppHandle) -> Result<(), String> {
    // Revoke the directory grant, not just the preference: otherwise the folder
    // stays in allowed_dirs and backend commands keep read/write access to it
    // until the process exits.
    if let Some(folder) = prefs::read_string_pref(&app, "workspace_folder") {
        io::revoke_dir(&app, &folder);
    }
    prefs::save_preference_key_inner(&app, "workspace_folder", serde_json::Value::Null).await
}

/// One lazy level of the tree: directories plus supported files, hidden
/// entries skipped, dirs-first case-insensitive sort.
#[tauri::command]
pub(crate) async fn list_dir(app: AppHandle, path: String) -> Result<Vec<DirEntryInfo>, String> {
    io::check_path_allowed(&app, &path)?;
    let dir = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || list_dir_inner(&dir))
        .await
        .map_err(|e| format!("Join error: {e}"))?
}

/// Recursive name index for the quick switcher (depth/count capped).
#[tauri::command]
pub(crate) async fn list_workspace_files(app: AppHandle) -> Result<WorkspaceFiles, String> {
    let Some(folder) = prefs::read_string_pref(&app, "workspace_folder") else {
        return Ok(WorkspaceFiles {
            files: Vec::new(),
            truncated: false,
        });
    };
    io::check_path_allowed(&app, &folder)?;
    let root = PathBuf::from(folder);
    let canonical_root =
        fs::canonicalize(&root).map_err(|e| format!("Failed to resolve workspace: {e}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        let mut truncated = false;
        walk_workspace(&root, &root, &canonical_root, 0, &mut files, &mut truncated);
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(WorkspaceFiles { files, truncated })
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
}

// --- Tests ---

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn unique_temp_dir() -> PathBuf {
        let dir = env::temp_dir().join(format!("boltpage-ws-tests-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_dir_filters_and_sorts() {
        let root = unique_temp_dir();
        fs::create_dir(root.join("zsub")).unwrap();
        fs::write(root.join("b.md"), "x").unwrap();
        fs::write(root.join("A.txt"), "x").unwrap();
        fs::write(root.join("skip.exe"), "x").unwrap();
        fs::write(root.join(".hidden.md"), "x").unwrap();

        let entries = list_dir_inner(&root).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Dirs first, then files case-insensitively; unsupported + hidden skipped.
        assert_eq!(names, vec!["zsub", "A.txt", "b.md"]);
        assert!(entries[0].is_dir);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn walk_workspace_recurses_with_relative_names() {
        let root = unique_temp_dir();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("top.md"), "x").unwrap();
        fs::write(root.join("sub").join("nested.md"), "x").unwrap();

        let mut files = Vec::new();
        let mut truncated = false;
        let canonical_root = fs::canonicalize(&root).unwrap();
        walk_workspace(&root, &root, &canonical_root, 0, &mut files, &mut truncated);
        let mut names: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        names.sort();
        assert_eq!(
            names,
            vec!["sub/nested.md".to_string(), "top.md".to_string()]
        );
        assert!(!truncated);

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn walk_workspace_skips_symlink_escape() {
        let root = unique_temp_dir();
        let outside = unique_temp_dir();
        fs::write(outside.join("secret.md"), "x").unwrap();
        fs::write(root.join("inside.md"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();

        let mut files = Vec::new();
        let mut truncated = false;
        let canonical_root = fs::canonicalize(&root).unwrap();
        walk_workspace(&root, &root, &canonical_root, 0, &mut files, &mut truncated);
        let names: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        // The symlinked external dir must not be followed: only inside.md.
        assert_eq!(names, vec!["inside.md".to_string()]);

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
