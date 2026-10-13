use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::prefs;
use crate::AppState;

/// Extensions surfaced in the workspace tree and quick switcher; matches the
/// render allowlist plus pdf (viewable). Also the allowlist for in-document
/// relative link targets (io::resolve_doc_link).
pub(crate) const WORKSPACE_EXTENSIONS: &[&str] =
    &["md", "markdown", "json", "yaml", "yml", "txt", "pdf"];

/// Quick-switcher index caps; truncation is reported, never silent.
const MAX_WORKSPACE_FILES: usize = 2000;
const MAX_WORKSPACE_DEPTH: usize = 8;

/// Full-text search caps; truncation is reported, never silent.
const MAX_SEARCH_RESULTS: usize = 500;
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
const SEARCH_PREVIEW_CHARS: usize = 200;
const MIN_SEARCH_QUERY_CHARS: usize = 2;

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

#[derive(Debug, Serialize)]
pub(crate) struct SearchHit {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub preview: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SearchResults {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

/// The workspace under one root directory: the lazy tree level, the
/// quick-switcher file list and full-text search. Every question walks the
/// folder fresh. Entries whose canonical target leaves the root (symlinks,
/// files and directories alike) are never listed, indexed or read.
struct WorkspaceIndex {
    root: PathBuf,
    canonical_root: PathBuf,
}

impl WorkspaceIndex {
    fn open(root: &Path) -> Result<Self, String> {
        let canonical_root =
            fs::canonicalize(root).map_err(|e| format!("Failed to read folder: {e}"))?;
        Ok(Self {
            root: root.to_path_buf(),
            canonical_root,
        })
    }

    /// One level of the tree: directories plus supported files, hidden
    /// entries skipped, dirs-first case-insensitive sort.
    fn level(&self, dir: &Path) -> Result<Vec<DirEntryInfo>, String> {
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
            // Containment: a symlink (file or directory) whose canonical
            // target leaves the root is skipped, so nothing outside the
            // folder is disclosed or read.
            match fs::canonicalize(&path) {
                Ok(canon) if canon.starts_with(&self.canonical_root) => {}
                _ => continue,
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

    /// Recursive file list, names relative to the root (depth/count capped).
    fn files(&self) -> WorkspaceFiles {
        let mut files = Vec::new();
        let mut truncated = false;
        self.walk(&self.root, 0, &mut files, &mut truncated);
        files.sort_by_key(|a| a.name.to_lowercase());
        WorkspaceFiles { files, truncated }
    }

    /// Case-insensitive substring search over the same walk as `files`. A
    /// short or empty query returns nothing rather than everything. PDFs are
    /// skipped (binary); oversized files are skipped rather than half-read.
    fn search(&self, query: &str) -> SearchResults {
        let mut hits = Vec::new();
        let mut truncated = false;
        let query = query.trim();
        if query.chars().count() < MIN_SEARCH_QUERY_CHARS {
            return SearchResults { hits, truncated };
        }
        let needle = query.to_lowercase();
        let mut files = Vec::new();
        self.walk(&self.root, 0, &mut files, &mut truncated);
        'outer: for f in files {
            let path = Path::new(&f.path);
            let is_pdf = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false);
            if is_pdf {
                continue;
            }
            let Ok(meta) = fs::metadata(path) else {
                continue;
            };
            if meta.len() > MAX_SEARCH_FILE_BYTES {
                continue;
            }
            let Ok(content) = fs::read_to_string(path) else {
                continue;
            };
            for (i, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&needle) {
                    if hits.len() >= MAX_SEARCH_RESULTS {
                        truncated = true;
                        break 'outer;
                    }
                    hits.push(SearchHit {
                        path: f.path.clone(),
                        name: f.name.clone(),
                        line: (i + 1) as u32,
                        preview: line.trim().chars().take(SEARCH_PREVIEW_CHARS).collect(),
                    });
                }
            }
        }
        SearchResults { hits, truncated }
    }

    fn walk(&self, dir: &Path, depth: usize, out: &mut Vec<DirEntryInfo>, truncated: &mut bool) {
        if depth > MAX_WORKSPACE_DEPTH {
            *truncated = true;
            return;
        }
        let Ok(entries) = self.level(dir) else {
            return;
        };
        for entry in entries {
            if out.len() >= MAX_WORKSPACE_FILES {
                *truncated = true;
                return;
            }
            let path = PathBuf::from(&entry.path);
            if entry.is_dir {
                self.walk(&path, depth + 1, out, truncated);
            } else {
                // Join components with '/' explicitly so switcher labels are
                // identical across platforms (Windows would otherwise emit '\').
                let rel = path
                    .strip_prefix(&self.root)
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
    app.state::<AppState>().grants.grant_dir(&folder_str)?;
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
    app.state::<AppState>().grants.grant_dir(&folder)?;
    Ok(Some(folder))
}

#[tauri::command]
pub(crate) async fn clear_workspace_folder(app: AppHandle) -> Result<(), String> {
    // Revoke the directory grant, not just the preference: otherwise the folder
    // stays granted and backend commands keep read/write access to it
    // until the process exits.
    if let Some(folder) = prefs::read_string_pref(&app, "workspace_folder") {
        app.state::<AppState>().grants.revoke_dir(&folder);
    }
    prefs::save_preference_key_inner(&app, "workspace_folder", serde_json::Value::Null).await
}

/// Opens the index on the persisted workspace folder and asks it one
/// question off the async runtime. None when no workspace folder is set.
async fn ask_index<T: Send + 'static>(
    app: &AppHandle,
    ask: impl FnOnce(&WorkspaceIndex) -> T + Send + 'static,
) -> Result<Option<T>, String> {
    let Some(folder) = prefs::read_string_pref(app, "workspace_folder") else {
        return Ok(None);
    };
    app.state::<AppState>().grants.authorize(&folder)?;
    tauri::async_runtime::spawn_blocking(move || {
        WorkspaceIndex::open(Path::new(&folder)).map(|index| Some(ask(&index)))
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
}

/// One lazy level of the workspace tree.
#[tauri::command]
pub(crate) async fn list_dir(app: AppHandle, path: String) -> Result<Vec<DirEntryInfo>, String> {
    app.state::<AppState>().grants.authorize(&path)?;
    let dir = PathBuf::from(path);
    ask_index(&app, move |index| index.level(&dir))
        .await?
        .unwrap_or(Ok(Vec::new()))
}

/// Recursive name index for the quick switcher.
#[tauri::command]
pub(crate) async fn list_workspace_files(app: AppHandle) -> Result<WorkspaceFiles, String> {
    Ok(ask_index(&app, WorkspaceIndex::files)
        .await?
        .unwrap_or(WorkspaceFiles {
            files: Vec::new(),
            truncated: false,
        }))
}

/// Case-insensitive full-text search across the workspace folder.
#[tauri::command]
pub(crate) async fn search_workspace(
    app: AppHandle,
    query: String,
) -> Result<SearchResults, String> {
    Ok(ask_index(&app, move |index| index.search(&query))
        .await?
        .unwrap_or(SearchResults {
            hits: Vec::new(),
            truncated: false,
        }))
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

    fn names(entries: &[DirEntryInfo]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn level_filters_and_sorts() {
        let root = unique_temp_dir();
        fs::create_dir(root.join("zsub")).unwrap();
        fs::write(root.join("b.md"), "x").unwrap();
        fs::write(root.join("A.txt"), "x").unwrap();
        fs::write(root.join("skip.exe"), "x").unwrap();
        fs::write(root.join(".hidden.md"), "x").unwrap();

        let entries = WorkspaceIndex::open(&root).unwrap().level(&root).unwrap();
        // Dirs first, then files case-insensitively; unsupported + hidden skipped.
        assert_eq!(names(&entries), vec!["zsub", "A.txt", "b.md"]);
        assert!(entries[0].is_dir);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn files_recurses_with_relative_names() {
        let root = unique_temp_dir();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("top.md"), "x").unwrap();
        fs::write(root.join("sub").join("nested.md"), "x").unwrap();

        let listed = WorkspaceIndex::open(&root).unwrap().files();
        assert_eq!(names(&listed.files), vec!["sub/nested.md", "top.md"]);
        assert!(!listed.truncated);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn files_reports_the_count_cap() {
        let root = unique_temp_dir();
        for i in 0..=MAX_WORKSPACE_FILES {
            fs::write(root.join(format!("f{i}.md")), "").unwrap();
        }

        let listed = WorkspaceIndex::open(&root).unwrap().files();
        assert_eq!(listed.files.len(), MAX_WORKSPACE_FILES);
        assert!(listed.truncated);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn files_reports_the_depth_cap() {
        let root = unique_temp_dir();
        let mut deepest_listed = root.clone();
        for _ in 0..MAX_WORKSPACE_DEPTH {
            deepest_listed.push("d");
        }
        let too_deep = deepest_listed.join("d");
        fs::create_dir_all(&too_deep).unwrap();
        fs::write(deepest_listed.join("kept.md"), "needle").unwrap();
        fs::write(too_deep.join("lost.md"), "needle").unwrap();

        let index = WorkspaceIndex::open(&root).unwrap();
        let listed = index.files();
        assert_eq!(listed.files.len(), 1);
        assert!(listed.files[0].name.ends_with("d/kept.md"));
        assert!(listed.truncated);
        let found = index.search("needle");
        assert_eq!(found.hits.len(), 1);
        assert!(found.truncated);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_matches_case_insensitive_with_lines() {
        let root = unique_temp_dir();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("a.md"), "Alpha\nthe NEEDLE here\nomega\n").unwrap();
        fs::write(root.join("sub").join("b.txt"), "needle on line one\n").unwrap();
        fs::write(root.join("c.md"), "nothing\n").unwrap();

        let found = WorkspaceIndex::open(&root).unwrap().search(" Needle ");
        assert!(!found.truncated);
        assert_eq!(found.hits.len(), 2);
        assert_eq!(found.hits[0].name, "sub/b.txt");
        assert_eq!(found.hits[0].line, 1);
        assert_eq!(found.hits[1].name, "a.md");
        assert_eq!(found.hits[1].line, 2);
        assert!(found.hits[1].preview.contains("NEEDLE"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_ignores_a_query_below_the_minimum_length() {
        let root = unique_temp_dir();
        fs::write(root.join("a.md"), "aaa\n").unwrap();

        let index = WorkspaceIndex::open(&root).unwrap();
        let short: String = std::iter::repeat_n('a', MIN_SEARCH_QUERY_CHARS - 1).collect();
        assert!(index.search(&short).hits.is_empty());
        assert!(index.search(&format!("  {short}  ")).hits.is_empty());
        assert!(index.search("").hits.is_empty());
        assert_eq!(
            index.search(&"a".repeat(MIN_SEARCH_QUERY_CHARS)).hits.len(),
            1
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_reports_the_result_cap() {
        let root = unique_temp_dir();
        fs::write(root.join("a.md"), "needle\n".repeat(MAX_SEARCH_RESULTS + 1)).unwrap();

        let found = WorkspaceIndex::open(&root).unwrap().search("needle");
        assert_eq!(found.hits.len(), MAX_SEARCH_RESULTS);
        assert!(found.truncated);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_skips_pdfs_and_oversized_files() {
        let root = unique_temp_dir();
        fs::write(root.join("doc.PDF"), "needle\n").unwrap();
        let mut big = "needle\n".to_string();
        big.push_str(&"x".repeat(MAX_SEARCH_FILE_BYTES as usize));
        fs::write(root.join("big.txt"), big).unwrap();
        fs::write(root.join("small.txt"), "needle\n").unwrap();

        let index = WorkspaceIndex::open(&root).unwrap();
        assert_eq!(
            names(&index.files().files),
            vec!["big.txt", "doc.PDF", "small.txt"]
        );
        let found = index.search("needle");
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].name, "small.txt");
        assert!(!found.truncated);

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_resolving_outside_the_root_are_skipped() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir();
        let outside = unique_temp_dir();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(outside.join("secret.md"), "needle").unwrap();
        fs::write(root.join("inside.md"), "needle").unwrap();
        symlink(&outside, root.join("dirlink")).unwrap();
        symlink(outside.join("secret.md"), root.join("filelink.md")).unwrap();
        // A link that stays inside the root is still followed.
        symlink(root.join("inside.md"), root.join("sub").join("alias.md")).unwrap();

        let index = WorkspaceIndex::open(&root).unwrap();
        assert_eq!(
            names(&index.files().files),
            vec!["inside.md", "sub/alias.md"]
        );
        let found = index.search("needle");
        let hit_names: Vec<&str> = found.hits.iter().map(|h| h.name.as_str()).collect();
        assert_eq!(hit_names, vec!["sub/alias.md", "inside.md"]);
        assert_eq!(
            names(&index.level(&root).unwrap()),
            vec!["sub", "inside.md"]
        );

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
