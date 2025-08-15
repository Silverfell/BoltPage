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
let findOverlay = null;
let findInput = null;
let findVisible = false;

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
        
        if (ctrl && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            openFindOverlay();
        } else if (ctrl && e.key.toLowerCase() === 'p') {
            e.preventDefault();
            // Print the PREVIEW window, not the editor
            if (previewWindow) {
                try { await invoke('print_window', { window: previewWindow }); } catch {}
            }
        } else if (ctrl && e.key === 's') {
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
        } else if (ctrl && e.key.toLowerCase() === 'z' && e.shiftKey) {
            // Redo (Shift+Cmd/Ctrl+Z)
            e.preventDefault();
            performEditAction('redo');
        } else if (ctrl && e.key.toLowerCase() === 'z') {
            // Undo
            e.preventDefault();
            performEditAction('undo');
        } else if (ctrl && e.key.toLowerCase() === 'y') {
            // Redo on Windows/Linux
            e.preventDefault();
            performEditAction('redo');
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

    // Listen for menu print requests; forward to preview window
    listen('menu-print', async () => {
        if (previewWindow) {
            try { await invoke('print_window', { window: previewWindow }); } catch {}
        }
    });

    // Listen for menu find requests
    listen('menu-find', () => {
        openFindOverlay();
    });

    // Listen for edit menu actions (cut/copy/paste/select-all)
    listen('menu-edit', async (event) => {
        if (!document.hasFocus()) return;
        const action = String(event.payload || '');
        performEditAction(action);
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
    const findBtn = document.getElementById('find-btn');
    if (findBtn) findBtn.addEventListener('click', toggleFindOverlay);
});

// Edit command helpers
async function tryPasteFallback() {
    try {
        const text = await navigator.clipboard.readText();
        const a = document.activeElement;
        if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel|password|email)$/i.test(a.type)))) {
            const start = a.selectionStart ?? 0;
            const end = a.selectionEnd ?? 0;
            const val = a.value ?? '';
            a.value = val.slice(0, start) + text + val.slice(end);
            const pos = start + text.length;
            a.setSelectionRange(pos, pos);
            a.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } catch {}
}

function performEditAction(action) {
    try {
        switch (action) {
            case 'undo':
                document.execCommand('undo');
                break;
            case 'redo':
                document.execCommand('redo');
                break;
            case 'copy':
                document.execCommand('copy');
                break;
            case 'cut':
                document.execCommand('cut');
                break;
            case 'paste':
                try { if (document.execCommand('paste')) break; } catch {}
                tryPasteFallback();
                break;
            case 'select-all':
                document.execCommand('selectAll');
                break;
        }
    } catch {}
}

// --- Find overlay (editor) ---
function ensureFindOverlay() {
    if (findOverlay) return;
    findOverlay = document.createElement('div');
    findOverlay.className = 'find-overlay';
    findOverlay.innerHTML = `
        <input id="find-input" class="find-input" type="text" placeholder="Find..." />
        <button class="find-btn" id="find-prev" title="Previous">&#8593;</button>
        <button class="find-btn" id="find-next" title="Next">&#8595;</button>
        <button class="find-btn" id="find-close" title="Close">&#10005;</button>
    `;
    document.body.appendChild(findOverlay);
    findInput = findOverlay.querySelector('#find-input');

    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const backwards = !!e.shiftKey;
            findInTextarea(findInput.value, !backwards);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeFindOverlay();
        }
    });
    findOverlay.querySelector('#find-prev').addEventListener('click', () => findInTextarea(findInput.value, false));
    findOverlay.querySelector('#find-next').addEventListener('click', () => findInTextarea(findInput.value, true));
    findOverlay.querySelector('#find-close').addEventListener('click', closeFindOverlay);
}

function openFindOverlay() {
    ensureFindOverlay();
    findOverlay.classList.add('show');
    findVisible = true;
    const ta = document.getElementById('editor-textarea');
    const sel = ta && ta.value ? ta.value.substring(ta.selectionStart || 0, ta.selectionEnd || 0) : '';
    if (sel) findInput.value = sel;
    findInput.focus();
    findInput.select();
}

function toggleFindOverlay() {
    if (findVisible) closeFindOverlay(); else openFindOverlay();
}

function closeFindOverlay() {
    if (!findOverlay) return;
    findOverlay.classList.remove('show');
    findVisible = false;
}

function findInTextarea(q, forward) {
    if (!q) return;
    const ta = document.getElementById('editor-textarea');
    const value = ta.value;
    let start = ta.selectionStart ?? 0;
    let idx = -1;
    if (forward) {
        idx = value.indexOf(q, (ta.selectionEnd ?? start));
        if (idx === -1) {
            // wrap
            idx = value.indexOf(q, 0);
        }
    } else {
        // search backwards from selectionStart-1
        idx = value.lastIndexOf(q, Math.max(0, start - 1));
        if (idx === -1) {
            // wrap to end
            idx = value.lastIndexOf(q);
        }
    }
    if (idx !== -1) {
        const end = idx + q.length;
        ta.focus();
        ta.setSelectionRange(idx, end);
        // Scroll into view
        const lh = getEditorLineHeight();
        const before = value.slice(0, idx);
        const line = (before.match(/\n/g) || []).length + 1;
        isProgrammaticScroll = true;
        ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2);
        setTimeout(() => { isProgrammaticScroll = false; }, 0);
    }
}
