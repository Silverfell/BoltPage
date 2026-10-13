use std::sync::Mutex;

/// What a registry transition changed: the file the window now shows, and the
/// files no viewer window shows any more.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Change {
    pub shown: Option<String>,
    pub dropped: Vec<String>,
}

struct Viewer {
    label: String,
    path: String,
}

struct Editor {
    label: String,
    path: String,
    preview: String,
}

#[derive(Default)]
struct Inner {
    /// In open order; blank windows are absent until they open a file.
    viewers: Vec<Viewer>,
    editors: Vec<Editor>,
}

impl Inner {
    /// `path` as a dropped file, unless a viewer still shows it.
    fn dropped(&self, path: String) -> Vec<String> {
        if self.viewers.iter().any(|v| v.path == path) {
            Vec::new()
        } else {
            vec![path]
        }
    }
}

/// The only answer to "which file does this window show", for viewer and
/// editor windows. Pure in-memory state: the caller applies what a transition
/// changed (see window::apply_transition).
#[derive(Default)]
pub(crate) struct Registry {
    inner: Mutex<Inner>,
}

/// A window label carries no meaning beyond its prefix (viewer or editor).
pub(crate) fn new_label(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4())
}

impl Registry {
    /// Register a new viewer window for `path`. Err carries the label of the
    /// viewer already showing it; nothing changes then.
    pub(crate) fn open_viewer(&self, label: &str, path: &str) -> Result<Change, String> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(existing) = inner.viewers.iter().find(|v| v.path == path) {
            return Err(existing.label.clone());
        }
        inner.viewers.push(Viewer {
            label: label.to_string(),
            path: path.to_string(),
        });
        Ok(Change {
            shown: Some(path.to_string()),
            dropped: Vec::new(),
        })
    }

    /// The viewer `label` now shows `path` in place of whatever it showed.
    pub(crate) fn switch_file(&self, label: &str, path: &str) -> Change {
        let mut inner = self.inner.lock().unwrap();
        let old = match inner.viewers.iter_mut().find(|v| v.label == label) {
            Some(viewer) => Some(std::mem::replace(&mut viewer.path, path.to_string())),
            None => {
                inner.viewers.push(Viewer {
                    label: label.to_string(),
                    path: path.to_string(),
                });
                None
            }
        };
        Change {
            shown: Some(path.to_string()),
            dropped: old.map(|p| inner.dropped(p)).unwrap_or_default(),
        }
    }

    /// Register a new editor window for `path`, paired with the viewer
    /// `preview`. Err carries the label of the editor already open on it.
    pub(crate) fn open_editor(&self, label: &str, path: &str, preview: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        if let Some(existing) = inner.editors.iter().find(|e| e.path == path) {
            return Err(existing.label.clone());
        }
        inner.editors.push(Editor {
            label: label.to_string(),
            path: path.to_string(),
            preview: preview.to_string(),
        });
        Ok(())
    }

    /// Forget the window `label`, viewer or editor.
    pub(crate) fn close(&self, label: &str) -> Change {
        let mut inner = self.inner.lock().unwrap();
        inner.editors.retain(|e| e.label != label);
        let dropped = match inner.viewers.iter().position(|v| v.label == label) {
            Some(i) => {
                let path = inner.viewers.remove(i).path;
                inner.dropped(path)
            }
            None => Vec::new(),
        };
        Change {
            shown: None,
            dropped,
        }
    }

    /// The file the window `label` shows; None for a blank or unknown window.
    pub(crate) fn file_of(&self, label: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner
            .viewers
            .iter()
            .find(|v| v.label == label)
            .map(|v| v.path.clone())
            .or_else(|| {
                inner
                    .editors
                    .iter()
                    .find(|e| e.label == label)
                    .map(|e| e.path.clone())
            })
    }

    /// The viewer window the editor `label` was opened from.
    pub(crate) fn preview_of(&self, label: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner
            .editors
            .iter()
            .find(|e| e.label == label)
            .map(|e| e.preview.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{WINDOW_PREFIX_EDITOR, WINDOW_PREFIX_FILE};

    fn shown(path: &str) -> Change {
        Change {
            shown: Some(path.to_string()),
            dropped: Vec::new(),
        }
    }

    #[test]
    fn labels_are_unique_and_keep_their_prefix() {
        let a = new_label(WINDOW_PREFIX_FILE);
        let b = new_label(WINDOW_PREFIX_FILE);
        assert_ne!(a, b);
        assert!(a.starts_with(WINDOW_PREFIX_FILE));
        assert!(new_label(WINDOW_PREFIX_EDITOR).starts_with(WINDOW_PREFIX_EDITOR));
    }

    #[test]
    fn open_viewer_registers_once_per_file() {
        let reg = Registry::default();
        assert_eq!(reg.open_viewer("v1", "/a.md"), Ok(shown("/a.md")));
        assert_eq!(reg.file_of("v1"), Some("/a.md".to_string()));

        // A second open of the same file is answered with the first window.
        assert_eq!(reg.open_viewer("v2", "/a.md"), Err("v1".to_string()));
        assert_eq!(reg.file_of("v2"), None);
    }

    #[test]
    fn switch_file_drops_the_old_file() {
        let reg = Registry::default();
        reg.open_viewer("v1", "/a.md").unwrap();

        assert_eq!(
            reg.switch_file("v1", "/b.md"),
            Change {
                shown: Some("/b.md".to_string()),
                dropped: vec!["/a.md".to_string()],
            }
        );
        assert_eq!(reg.file_of("v1"), Some("/b.md".to_string()));

        // Re-opening the file already shown drops nothing.
        assert_eq!(reg.switch_file("v1", "/b.md"), shown("/b.md"));

        // A blank window is unknown until its first file.
        assert_eq!(reg.switch_file("blank", "/c.md"), shown("/c.md"));
        assert_eq!(reg.file_of("blank"), Some("/c.md".to_string()));
    }

    /// The label used to be derived from the file, so re-opening a file whose
    /// first window had moved on to another file collided on that label.
    #[test]
    fn file_can_reopen_after_its_window_switched_away() {
        let reg = Registry::default();
        reg.open_viewer("v1", "/a.md").unwrap();
        reg.switch_file("v1", "/b.md");

        assert_eq!(reg.open_viewer("v2", "/a.md"), Ok(shown("/a.md")));
        assert_eq!(reg.file_of("v1"), Some("/b.md".to_string()));
        assert_eq!(reg.file_of("v2"), Some("/a.md".to_string()));
    }

    #[test]
    fn file_is_dropped_only_when_its_last_viewer_leaves() {
        let reg = Registry::default();
        reg.open_viewer("v1", "/a.md").unwrap();
        reg.open_viewer("v2", "/b.md").unwrap();
        // v2 switches to the file v1 shows: /b.md is dropped, /a.md is shared.
        assert_eq!(
            reg.switch_file("v2", "/a.md").dropped,
            vec!["/b.md".to_string()]
        );

        assert_eq!(reg.close("v1"), Change::default());
        assert_eq!(
            reg.close("v2"),
            Change {
                shown: None,
                dropped: vec!["/a.md".to_string()],
            }
        );
        assert_eq!(reg.file_of("v2"), None);
        // Closing an unknown window changes nothing.
        assert_eq!(reg.close("v2"), Change::default());
    }

    #[test]
    fn editor_is_tracked_per_file_with_its_preview() {
        let reg = Registry::default();
        reg.open_viewer("v1", "/a.md").unwrap();

        assert_eq!(reg.open_editor("e1", "/a.md", "v1"), Ok(()));
        assert_eq!(reg.open_editor("e2", "/a.md", "v1"), Err("e1".to_string()));
        assert_eq!(reg.file_of("e1"), Some("/a.md".to_string()));
        assert_eq!(reg.preview_of("e1"), Some("v1".to_string()));
        assert_eq!(reg.preview_of("v1"), None);

        // An editor closing drops no file: the viewer still shows it.
        assert_eq!(reg.close("e1"), Change::default());
        assert_eq!(reg.file_of("e1"), None);
        assert_eq!(reg.open_editor("e2", "/a.md", "v1"), Ok(()));
    }
}
