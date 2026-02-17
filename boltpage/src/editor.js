import {
    SCROLL_SYNC_DEBOUNCE_MS,
    PROGRAMMATIC_SCROLL_TIMEOUT_MS,
    MIN_SCROLL_DELTA_LINES,
    MIN_SCROLL_DELTA_PERCENT,
    LINE_HEIGHT_FALLBACK_MULTIPLIER,
    parsePx,
    updateLinkScrollButton as updateLinkBtn,
    createFindOverlay,
    updateFindCount,
} from './shared.js';

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

// Track last synced position to filter micro-scrolls
let lastSyncedLine = null;
let lastSyncedPercent = null;

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
    updateLinkBtn(document.getElementById('link-scroll-btn'), scrollLinkEnabled);
}

function getEditorLineHeight() {
    const ta = document.getElementById('editor-textarea');
    const cs = window.getComputedStyle(ta);
    let lh = parsePx(cs.lineHeight);
    if (!lh) lh = LINE_HEIGHT_FALLBACK_MULTIPLIER * parsePx(cs.fontSize || '14');
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
    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
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
  try {
    await initialize();

    const textarea = document.getElementById('editor-textarea');

    // Track changes
    textarea.addEventListener('input', () => {
        markDirty();
        scheduleAutoSave();
    });

    // Close button just triggers close -- onCloseRequested handles the save
    document.getElementById('close-btn').addEventListener('click', () => {
        appWindow.close();
    });

    // Handle keyboard shortcuts
    document.addEventListener('keydown', async (e) => {
        const ctrl = e.ctrlKey || e.metaKey;

        if (ctrl && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            openFindOverlay();
        } else if (ctrl && e.key === 's') {
            e.preventDefault();
            await saveFile();
        } else if (ctrl && e.key === 'w') {
            e.preventDefault();
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
        if (scrollDebounce) clearTimeout(scrollDebounce);
        scrollDebounce = setTimeout(async () => {
            const lower = currentFilePath.toLowerCase();
            const isJson = lower.endsWith('.json');
            const isYaml = lower.endsWith('.yaml') || lower.endsWith('.yml');
            const isTxt = lower.endsWith('.txt');
            let payload;
            if (isJson || isYaml || isTxt) {
                const line = getTopLineForEditor();
                // Filter micro-scrolls: only broadcast if line changed significantly
                if (lastSyncedLine !== null && Math.abs(line - lastSyncedLine) < MIN_SCROLL_DELTA_LINES) {
                    return;
                }
                lastSyncedLine = line;
                const kind = isJson ? 'json' : (isYaml ? 'yaml' : 'txt');
                payload = { source: appWindow.label, file_path: currentFilePath, kind, line, percent: null };
            } else {
                const ta = document.getElementById('editor-textarea');
                const scrollableHeight = ta.scrollHeight - ta.clientHeight;
                if (scrollableHeight <= 0) {
                    // Content fits in viewport, no scroll sync needed
                    return;
                }
                const percent = Math.max(0, Math.min(1, ta.scrollTop / scrollableHeight));
                // Filter micro-scrolls: only broadcast if percent changed significantly
                if (lastSyncedPercent !== null && Math.abs(percent - lastSyncedPercent) < MIN_SCROLL_DELTA_PERCENT) {
                    return;
                }
                lastSyncedPercent = percent;
                payload = { source: appWindow.label, file_path: currentFilePath, kind: 'markdown', line: null, percent };
            }
            try {
                await invoke('broadcast_scroll_sync', { payload });
            } catch (e) {
                // ignore
            }
        }, SCROLL_SYNC_DEBOUNCE_MS);
    });

    // Listen for scroll sync events
    await listen('scroll-sync', (event) => {
        const p = event.payload || {};
        if (!currentFilePath || !scrollLinkEnabled) return;
        if (p.source === appWindow.label) return;
        if (p.file_path !== currentFilePath) return;
        if (typeof p.line === 'number') {
            scrollEditorToLine(p.line);
            lastSyncedLine = p.line;
        } else if (typeof p.percent === 'number') {
            // Map percent to scroll position
            const ta = document.getElementById('editor-textarea');
            const scrollableHeight = ta.scrollHeight - ta.clientHeight;
            if (scrollableHeight <= 0) return;
            isProgrammaticScroll = true;
            ta.scrollTop = p.percent * scrollableHeight;
            lastSyncedPercent = p.percent;
            setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
        }
    });

    // Listen for global scroll-link toggle
    await listen('scroll-link-changed', (event) => {
        scrollLinkEnabled = !!event.payload;
        updateLinkScrollButton();
    });

    // Listen for menu find requests
    await listen('menu-find', () => {
        openFindOverlay();
    });

    // Listen for edit menu actions
    await listen('menu-edit', async (event) => {
        if (!document.hasFocus()) return;
        const action = String(event.payload || '');
        performEditAction(action);
    });

    // Listen for theme changes
    await listen('theme-changed', (event) => {
        document.documentElement.setAttribute('data-theme', event.payload);
    });

    // Listen for close menu action -- onCloseRequested handles the save
    await listen('menu-close', async () => {
        if (!document.hasFocus()) return;
        appWindow.close();
    });

    // Listen for print menu action
    await listen('menu-print', () => {
        if (!document.hasFocus()) return;
        window.print();
    });

    // Listen for open menu action (editor ignores; only preview handles it)
    await listen('menu-open', () => {
        // No-op in editor window — open is handled by preview windows
    });

    // Link scroll button
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

    // Use Tauri's onCloseRequested so we can reliably await the async save
    // before allowing the window to close (beforeunload cannot await).
    let closePending = false;
    await appWindow.onCloseRequested(async (event) => {
        if (closePending) return; // second pass after save, allow close
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }
        if (isDirty) {
            event.preventDefault();
            closePending = true;
            await saveFile();
            appWindow.close();
        }
    });

  } catch (error) {
    console.error('[CRITICAL ERROR] Editor initialization failed:', error);
  }
});

// Edit command helpers using modern Clipboard API
async function performEditAction(action) {
    try {
        const textarea = document.getElementById('editor-textarea');
        if (!textarea) return;

        switch (action) {
            case 'undo':
                textarea.focus();
                document.execCommand('undo');
                break;
            case 'redo':
                textarea.focus();
                document.execCommand('redo');
                break;
            case 'copy':
                if (textarea.selectionStart !== textarea.selectionEnd) {
                    const text = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
                    await navigator.clipboard.writeText(text);
                }
                break;
            case 'cut':
                if (textarea.selectionStart !== textarea.selectionEnd) {
                    const cutText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
                    await navigator.clipboard.writeText(cutText);
                    const cutStart = textarea.selectionStart;
                    textarea.value = textarea.value.slice(0, cutStart) + textarea.value.slice(textarea.selectionEnd);
                    textarea.setSelectionRange(cutStart, cutStart);
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
                break;
            case 'paste':
                try {
                    const clipText = await navigator.clipboard.readText();
                    if (clipText) {
                        textarea.focus();
                        const start = textarea.selectionStart;
                        const end = textarea.selectionEnd;
                        const val = textarea.value;
                        textarea.value = val.slice(0, start) + clipText + val.slice(end);
                        const pos = start + clipText.length;
                        textarea.setSelectionRange(pos, pos);
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                } catch (pasteErr) {
                    console.error('Paste failed:', pasteErr);
                }
                break;
            case 'select-all':
                textarea.select();
                break;
        }
    } catch (err) {
        console.error('Edit action failed:', err);
    }
}

// --- Find overlay (editor) ---
let findResults = [];
let currentFindIndex = -1;
let lastSearchQuery = '';

function ensureFindOverlay() {
    if (findOverlay) return;
    const els = createFindOverlay();
    findOverlay = els.overlay;
    findInput = els.input;

    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) findPrevious(); else findNext();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeFindOverlay();
        }
    });

    findOverlay.querySelector('#find-prev').addEventListener('click', findPrevious);
    findOverlay.querySelector('#find-next').addEventListener('click', findNext);
    findOverlay.querySelector('#find-close').addEventListener('click', closeFindOverlay);
}

function performFind(query) {
    if (!query.trim()) {
        clearFindResults();
        return;
    }
    
    lastSearchQuery = query;
    findResults = [];
    currentFindIndex = -1;
    
    const ta = document.getElementById('editor-textarea');
    const value = ta.value;
    const lowerValue = value.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let index = 0;
    
    // Find all instances
    while ((index = lowerValue.indexOf(lowerQuery, index)) !== -1) {
        findResults.push({
            start: index,
            end: index + query.length
        });
        index += 1;
    }
    
    updateFindCountDisplay();
    
    if (findResults.length > 0) {
        currentFindIndex = 0;
        highlightCurrentFind();
    }
}

function findNext() {
    const currentQuery = findInput.value;
    
    // If query changed, perform new search
    if (currentQuery !== lastSearchQuery) {
        performFind(currentQuery);
        return;
    }
    
    // If no results, perform search
    if (findResults.length === 0) {
        performFind(currentQuery);
        return;
    }
    
    currentFindIndex = (currentFindIndex + 1) % findResults.length;
    highlightCurrentFind();
    updateFindCountDisplay();
}

function findPrevious() {
    const currentQuery = findInput.value;
    
    // If query changed, perform new search
    if (currentQuery !== lastSearchQuery) {
        performFind(currentQuery);
        return;
    }
    
    // If no results, perform search
    if (findResults.length === 0) {
        performFind(currentQuery);
        return;
    }
    
    currentFindIndex = currentFindIndex <= 0 ? findResults.length - 1 : currentFindIndex - 1;
    highlightCurrentFind();
    updateFindCountDisplay();
}

function highlightCurrentFind() {
    if (currentFindIndex < 0 || currentFindIndex >= findResults.length) return;
    
    const result = findResults[currentFindIndex];
    const ta = document.getElementById('editor-textarea');
    
    // Don't focus the textarea - keep focus in the find input
    ta.setSelectionRange(result.start, result.end);
    
    // Scroll into view
    const lh = getEditorLineHeight();
    const before = ta.value.slice(0, result.start);
    const line = (before.match(/\n/g) || []).length + 1;
    isProgrammaticScroll = true;
    ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2);
    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
}

function clearFindResults() {
    findResults = [];
    currentFindIndex = -1;
    updateFindCountDisplay();
}

function updateFindCountDisplay() {
    updateFindCount(findOverlay, findResults, currentFindIndex);
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
    clearFindResults();
}

