const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();
let currentFilePath = null;
let isDirty = false;
let saveTimeout = null;
let previewWindow = null;
let isProgrammaticScroll = false;
let scrollDebounce = null;
let scrollLinkEnabled = true;

// Suppress noisy [DEBUG] logs in production unless window.__DEV__ is true
(function () {
  try {
    const orig = console.log;
    console.log = function (...args) {
      if (!window.__DEV__ && String(args[0] || '').includes('[DEBUG]')) return;
      return orig.apply(console, args);
    };
  } catch {}
})();

// Get file path from window
async function initialize() {
    // Get file path from initialization script
    currentFilePath = window.__INITIAL_FILE_PATH__;
    previewWindow = window.__PREVIEW_WINDOW__;
    
    // Load file content
    if (currentFilePath) {
        try {
            const raw = await invoke('read_file', { path: currentFilePath });
            let content = raw;
            const lower = currentFilePath.toLowerCase();
            if (lower.endsWith('.json')) {
                try {
                    content = await invoke('format_json_pretty', { content: raw });
                } catch (e) {
                    console.warn('JSON pretty formatting failed; showing raw:', e);
                }
            }
            document.getElementById('editor-textarea').value = content;
            updateStatus('Loaded');

            // Update window title
            const filename = currentFilePath.split(/[/\\]/).pop();
            appWindow.setTitle(`BoltPage Editor - ${filename}`);
        } catch (err) {
            console.error('Failed to load file:', err);
            updateStatus('Error loading file');
        }
    }
    
    // Load theme preference
    try {
        const prefs = await invoke('get_preferences');
        document.documentElement.setAttribute('data-theme', prefs.theme);
    } catch (err) {
        console.error('Failed to load preferences:', err);
    }
}

function updateStatus(status) {
    document.getElementById('editor-status').textContent = status;
}

function markDirty() {
    if (!isDirty) {
        isDirty = true;
        updateStatus('Modified');
    }
}

async function saveFile() {
    if (!currentFilePath || !isDirty) return;
    
    let content = document.getElementById('editor-textarea').value;
    
    // For JSON files, normalize to the same pretty-sorted format as preview
    const lower = currentFilePath.toLowerCase();
    if (lower.endsWith('.json')) {
        try {
            content = await invoke('format_json_pretty', { content });
            // Update editor with normalized content to keep lines in sync
            document.getElementById('editor-textarea').value = content;
        } catch (e) {
            console.warn('JSON pretty formatting failed on save; saving raw content:', e);
        }
    }
    
    try {
        await invoke('write_file', { path: currentFilePath, content });
        isDirty = false;
        updateStatus('Saved');
        
        // Notify preview window to refresh (fire-and-forget; don't steal focus)
        if (previewWindow) {
            invoke('refresh_preview', { window: previewWindow }).catch(() => {});
        }
    } catch (err) {
        console.error('Failed to save file:', err);
        updateStatus('Error saving');
    }
}

function updateLinkScrollButton() {
    const btn = document.getElementById('link-scroll-btn');
    if (!btn) return;
    btn.classList.toggle('active', scrollLinkEnabled);
    btn.setAttribute('aria-pressed', String(scrollLinkEnabled));
}

function parsePx(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

function getEditorLineHeight() {
    const ta = document.getElementById('editor-textarea');
    const cs = window.getComputedStyle(ta);
    let lh = parsePx(cs.lineHeight);
    if (!lh) lh = 1.4 * parsePx(cs.fontSize || '14');
    return lh || 18;
}

function getTopLineForEditor() {
    const ta = document.getElementById('editor-textarea');
    const lh = getEditorLineHeight();
    const line = Math.floor(ta.scrollTop / lh) + 1;
    return line;
}

function scrollEditorToLine(line) {
    const ta = document.getElementById('editor-textarea');
    const lh = getEditorLineHeight();
    isProgrammaticScroll = true;
    ta.scrollTop = (Math.max(1, line) - 1) * lh;
    setTimeout(() => { isProgrammaticScroll = false; }, 0);
}

function scheduleAutoSave() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    
    saveTimeout = setTimeout(() => {
        saveFile();
    }, 700); // Slightly longer debounce for smoother typing
}

// Set up event listeners
document.addEventListener('DOMContentLoaded', async () => {
    await initialize();
    
    const textarea = document.getElementById('editor-textarea');
    
    // Track changes
    textarea.addEventListener('input', () => {
        markDirty();
        scheduleAutoSave();
    });
    
    // Handle close button
    document.getElementById('close-btn').addEventListener('click', async () => {
        if (isDirty) {
            await saveFile();
        }
        appWindow.close();
    });
    
    // Handle keyboard shortcuts
    document.addEventListener('keydown', async (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        
        if (ctrl && e.key === 's') {
            e.preventDefault();
            await saveFile();
        } else if (ctrl && e.key === 'w') {
            e.preventDefault();
            if (isDirty) {
                await saveFile();
            }
            appWindow.close();
        } else if (ctrl && e.key === 'l') {
            e.preventDefault();
            const btn = document.getElementById('link-scroll-btn');
            if (btn) btn.click();
        }
    });
    
    // Sync: send scroll position to preview
    textarea.addEventListener('scroll', () => {
        if (!currentFilePath || isProgrammaticScroll || !scrollLinkEnabled) return;
        if (scrollDebounce) cancelAnimationFrame(scrollDebounce);
        scrollDebounce = requestAnimationFrame(async () => {
            const lower = currentFilePath.toLowerCase();
            const isJson = lower.endsWith('.json');
            let payload;
            if (isJson) {
                const line = getTopLineForEditor();
                payload = { source: appWindow.label, file_path: currentFilePath, kind: 'json', line, percent: null };
            } else {
                const ta = document.getElementById('editor-textarea');
                const maxScroll = Math.max(1, ta.scrollHeight - ta.clientHeight);
                const percent = Math.max(0, Math.min(1, ta.scrollTop / maxScroll));
                payload = { source: appWindow.label, file_path: currentFilePath, kind: 'markdown', line: null, percent };
            }
            try {
                await invoke('broadcast_scroll_sync', { payload });
            } catch (e) {
                // ignore
            }
        });
    });

    // Listen for scroll sync events
    listen('scroll-sync', (event) => {
        const p = event.payload || {};
        if (!currentFilePath || !scrollLinkEnabled) return;
        if (p.source === appWindow.label) return;
        if (p.file_path !== currentFilePath) return;
        if (typeof p.line === 'number') {
            scrollEditorToLine(p.line);
        } else if (typeof p.percent === 'number') {
            // Map percent to line based on total scroll height
            const ta = document.getElementById('editor-textarea');
            const maxScroll = Math.max(1, ta.scrollHeight - ta.clientHeight);
            isProgrammaticScroll = true;
            ta.scrollTop = p.percent * maxScroll;
            setTimeout(() => { isProgrammaticScroll = false; }, 0);
        }
    });

    // Listen for global scroll-link toggle
    listen('scroll-link-changed', (event) => {
        scrollLinkEnabled = !!event.payload;
        updateLinkScrollButton();
    });

    // Save on window close
    window.addEventListener('beforeunload', async (e) => {
        if (isDirty) {
            e.preventDefault();
            await saveFile();
        }
    });
});

// Listen for theme changes
listen('theme-changed', (event) => {
    document.documentElement.setAttribute('data-theme', event.payload);
});

// Link scroll button click handler
document.addEventListener('DOMContentLoaded', () => {
    const linkBtn = document.getElementById('link-scroll-btn');
    if (linkBtn) {
        linkBtn.addEventListener('click', async () => {
            scrollLinkEnabled = !scrollLinkEnabled;
            updateLinkScrollButton();
            try { await invoke('broadcast_scroll_link', { enabled: scrollLinkEnabled }); } catch {}
        });
        updateLinkScrollButton();
    }
});
