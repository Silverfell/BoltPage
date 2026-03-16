use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep, Duration};

use crate::constants::EVENT_FILE_CHANGED;
use crate::io;

// Global file watchers storage with dedup by file path and debounced emits
pub(crate) struct FileWatcherInner {
    watchers: HashMap<String, RecommendedWatcher>,
    /// Stored to keep the channel alive; dropping the sender closes the receiver.
    senders: HashMap<String, mpsc::UnboundedSender<()>>,
    debounce_tasks: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    subs: HashMap<String, Vec<String>>,
}

pub(crate) struct FileWatchers {
    pub inner: Arc<Mutex<FileWatcherInner>>,
}

impl Default for FileWatchers {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FileWatcherInner {
                watchers: HashMap::new(),
                senders: HashMap::new(),
                debounce_tasks: HashMap::new(),
                subs: HashMap::new(),
            })),
        }
    }
}

fn is_refresh_relevant_event(kind: &notify::EventKind) -> bool {
    matches!(
        kind,
        notify::EventKind::Modify(_)
            | notify::EventKind::Create(_)
            | notify::EventKind::Remove(_)
            | notify::EventKind::Any
    )
}

fn prune_orphaned_watchers(inner: &mut FileWatcherInner) {
    let mut to_remove = Vec::new();
    for (file, labels) in inner.subs.iter() {
        if labels.is_empty() {
            to_remove.push(file.clone());
        }
    }

    for file in to_remove {
        inner.subs.remove(&file);
        inner.watchers.remove(&file);
        inner.senders.remove(&file);
        if let Some(handle) = inner.debounce_tasks.remove(&file) {
            handle.abort();
        }
    }
}

pub(crate) fn unsubscribe_window_from_all(inner: &mut FileWatcherInner, window_label: &str) {
    for labels in inner.subs.values_mut() {
        labels.retain(|label| label != window_label);
    }
    prune_orphaned_watchers(inner);
}

#[tauri::command]
pub(crate) async fn start_file_watcher(
    app: AppHandle,
    file_path: String,
    window_label: String,
) -> Result<(), String> {
    io::check_path_allowed(&app, &file_path)?;
    let watchers = app.state::<FileWatchers>();
    let mut inner = watchers.inner.lock().await;
    unsubscribe_window_from_all(&mut inner, &window_label);

    // Register subscription
    let entry = inner.subs.entry(file_path.clone()).or_default();
    if !entry.iter().any(|w| w == &window_label) {
        entry.push(window_label.clone());
    }

    // If watcher already exists for this file, we're done
    if inner.watchers.contains_key(&file_path) {
        return Ok(());
    }

    // Create watcher while holding lock to prevent duplicate creation.
    // Watcher creation is fast (OS notification setup only).
    let (tx, mut rx) = mpsc::unbounded_channel();
    let target_path = PathBuf::from(&file_path);
    let watch_path = target_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| target_path.clone());

    let tx_for_watcher = tx.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                if is_refresh_relevant_event(&event.kind)
                    && io::event_targets_file(&event.paths, &target_path)
                {
                    let _ = tx_for_watcher.send(());
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    watcher
        .watch(&watch_path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch file: {e}"))?;

    // Spawn a debounced notifier for this file path
    let app_clone = app.clone();
    let file_key = file_path.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut pending_task: Option<tauri::async_runtime::JoinHandle<()>> = None;
        while rx.recv().await.is_some() {
            // Reset debounce timer
            if let Some(h) = pending_task.take() {
                h.abort();
            }
            let app2 = app_clone.clone();
            let file2 = file_key.clone();
            pending_task = Some(tauri::async_runtime::spawn(async move {
                sleep(Duration::from_millis(250)).await;
                // Invalidate any cached HTML for this file
                io::invalidate_cache_for_path(&app2, &file2).await;
                if let Some(state) = app2.try_state::<FileWatchers>() {
                    let guard = state.inner.lock().await;
                    if let Some(labels) = guard.subs.get(&file2) {
                        for label in labels.iter() {
                            if let Some(win) = app2.get_webview_window(label) {
                                let _ = win.emit(EVENT_FILE_CHANGED, ());
                            }
                        }
                    }
                }
            }));
        }
    });

    // Store watcher, sender, and debounce task (lock still held)
    inner.watchers.insert(file_path.clone(), watcher);
    inner.senders.insert(file_path.clone(), tx);
    inner.debounce_tasks.insert(file_path.clone(), handle);

    Ok(())
}

#[tauri::command]
pub(crate) async fn stop_file_watcher(app: AppHandle, window_label: String) -> Result<(), String> {
    let watchers = app.state::<FileWatchers>();
    let mut inner = watchers.inner.lock().await;
    unsubscribe_window_from_all(&mut inner, &window_label);
    Ok(())
}
