import {
    SCROLL_SYNC_DEBOUNCE_MS,
    PROGRAMMATIC_SCROLL_TIMEOUT_MS,
    MIN_SCROLL_DELTA_LINES,
    MIN_SCROLL_DELTA_PERCENT,
    LINE_HEIGHT_FALLBACK_MULTIPLIER,
    DEFAULT_FONT_SIZE,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    EDITOR_FONT_SIZE_OFFSET,
    parsePx,
    escapeHtml,
    clampFontSize,
    setBadgeState,
    createFindOverlay,
    updateFindCount,
    nextFindIndex,
    applyThemeToDocument,
    setupKeyboardShortcuts,
} from './shared.js';
import {
    EVENT_THEME_CHANGED,
    EVENT_FONT_SIZE_CHANGED,
    EVENT_SCROLL_SYNC,
    EVENT_MENU_CLOSE,
    EVENT_MENU_FIND,
    EVENT_MENU_EDIT,
    EVENT_MENU_PRINT,
    ACTION_UNDO,
    ACTION_REDO,
    ACTION_CUT,
    ACTION_COPY,
    ACTION_PASTE,
    ACTION_SELECT_ALL,
    KIND_MARKDOWN,
    KIND_JSON,
    KIND_YAML,
    KIND_TXT,
} from './constants.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();
let currentFilePath = null;
let currentFileKind = KIND_MARKDOWN;
let isDirty = false;
let saveTimeout = null;
let previewWindow = null;
let isProgrammaticScroll = false;
let scrollDebounce = null;
let findOverlay = null;
let findInput = null;
let replaceInput = null;
let findVisible = false;
let findHighlightOverlay = null;
let lineGutter = null;
let lineMirror = null;
let lastLineCount = 0;
let wordWrapEnabled = false;
let showLineNumbers = true;
let lineNumberRafId = null;
let prevLines = [];
let mirrorDivs = [];
let gutterDivs = [];
let lineHeights = [];
let currentFontSize = 18;
let closeEventSent = false;

// Track last synced position to filter micro-scrolls
let lastSyncedLine = null;
let lastSyncedPercent = null;

function detectFileKind(filePath) {
    const lower = String(filePath || '').toLowerCase();
    if (lower.endsWith('.json')) return KIND_JSON;
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return KIND_YAML;
    if (lower.endsWith('.txt')) return KIND_TXT;
    return KIND_MARKDOWN;
}

function updateFontSizeControls() {
    const indicator = document.getElementById('editor-font-size-indicator');
    const decreaseBtn = document.getElementById('editor-font-size-decrease-btn');
    const increaseBtn = document.getElementById('editor-font-size-increase-btn');
    if (indicator) indicator.textContent = `${currentFontSize}px`;
    if (decreaseBtn) decreaseBtn.disabled = currentFontSize <= MIN_FONT_SIZE;
    if (increaseBtn) increaseBtn.disabled = currentFontSize >= MAX_FONT_SIZE;
}

function renderEditorHeader() {
    // Compact header: no document identity display
}

function editorFontSizePx(fontSize = currentFontSize) {
    return Math.max(12, clampFontSize(fontSize) - EDITOR_FONT_SIZE_OFFSET);
}

function applyFontSize(fontSize, options = {}) {
    const { save = false, broadcast = false } = options;
    const nextFontSize = clampFontSize(fontSize);
    const anchorLine = currentFilePath ? getTopLineForEditor() : null;
    currentFontSize = nextFontSize;

    document.documentElement.style.setProperty('--editor-font-size', `${editorFontSizePx(currentFontSize)}px`);
    document.documentElement.style.setProperty('--editor-gutter-font-size', `${Math.max(11, editorFontSizePx(currentFontSize) - 1)}px`);

    prevLines = [];
    mirrorDivs = [];
    gutterDivs = [];
    lineHeights = [];
    lastLineCount = -1;
    updateFontSizeControls();
    if (showLineNumbers) updateLineNumbers();

    if (typeof anchorLine === 'number') {
        requestAnimationFrame(() => scrollEditorToLine(anchorLine));
    }

    if (save) {
        invoke('save_preference_key', { key: 'font_size', value: currentFontSize })
            .catch(err => console.error('Failed to save font_size preference:', err));
    }
    if (broadcast) {
        invoke('broadcast_font_size_change', { fontSize: currentFontSize })
            .catch(err => console.error('Failed to broadcast font size change:', err));
    }
}

function changeFontSize(delta) {
    applyFontSize(currentFontSize + delta, { save: true, broadcast: true });
}

async function notifyPreviewEditorClosed() {
    if (closeEventSent || !previewWindow || !currentFilePath) return;
    closeEventSent = true;
    try {
        await invoke('broadcast_editor_window_closed', {
            payload: {
                preview_window: previewWindow,
                file_path: currentFilePath,
            }
        });
    } catch (err) {
        closeEventSent = false;
        console.error('Failed to broadcast editor close event:', err);
    }
}

function applyLineNumberVisibility() {
    const wrapBtn = document.getElementById('line-numbers-btn');
    document.body.classList.toggle('line-numbers-hidden', !showLineNumbers);
    if (lineGutter) {
        lineGutter.style.display = showLineNumbers ? '' : 'none';
    }
    if (wrapBtn) wrapBtn.classList.toggle('active', showLineNumbers);
    if (showLineNumbers) {
        prevLines = [];
        mirrorDivs = [];
        gutterDivs = [];
        lineHeights = [];
        lastLineCount = -1;
        updateLineNumbers();
    }
}

function toggleLineNumbers() {
    showLineNumbers = !showLineNumbers;
    applyLineNumberVisibility();
    invoke('save_preference_key', { key: 'show_line_numbers', value: showLineNumbers })
        .catch(err => console.error('Failed to save show_line_numbers preference:', err));
}

async function initialize() {
    // Get file path from initialization script
    currentFilePath = window.__INITIAL_FILE_PATH__;
    previewWindow = window.__PREVIEW_WINDOW__;
    currentFileKind = detectFileKind(currentFilePath);
    renderEditorHeader();
    
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
        applyThemeToDocument(prefs.theme);
        applyFontSize(prefs.font_size);
        wordWrapEnabled = prefs.word_wrap === true;
        showLineNumbers = prefs.show_line_numbers !== false;
        applyWordWrap();
    } catch (err) {
        console.error('Failed to load preferences:', err);
        applyFontSize(DEFAULT_FONT_SIZE);
    }
}

function updateStatus(status) {
    const statusBadge = document.getElementById('editor-status-badge');
    let tone = null;
    if (/saved|loaded/i.test(status)) tone = 'success';
    if (/modified/i.test(status)) tone = 'warning';
    if (/error/i.test(status)) tone = 'warning';
    setBadgeState(statusBadge, status, tone, false);
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

function setupEditorWrapper() {
    const ta = document.getElementById('editor-textarea');
    const wrapper = ta.closest('.editor-textarea-wrapper');
    lineGutter = wrapper.querySelector('.line-number-gutter');
    lineMirror = wrapper.querySelector('.line-mirror');
}

function scheduleLineNumberUpdate() {
    if (lineNumberRafId) return;
    lineNumberRafId = requestAnimationFrame(() => {
        lineNumberRafId = null;
        updateLineNumbers();
    });
}

function fullRebuildLineNumbers(newLines) {
    lineMirror.innerHTML = newLines
        .map(line => `<div>${escapeHtml(line) || '&nbsp;'}</div>`)
        .join('');
    mirrorDivs = Array.from(lineMirror.children);

    lineHeights = mirrorDivs.map(d => d.offsetHeight);

    lineGutter.innerHTML = lineHeights
        .map((h, i) => `<div class="line-num" style="height:${h}px">${i + 1}</div>`)
        .join('');
    gutterDivs = Array.from(lineGutter.children);

    prevLines = newLines;
    lastLineCount = newLines.length;
}

function updateLineNumbers() {
    if (!lineGutter) return;
    if (!showLineNumbers) return;
    const ta = document.getElementById('editor-textarea');
    const count = ta.value.split('\n').length;
    if (count === lastLineCount && !wordWrapEnabled) return;
    lastLineCount = count;

    if (!wordWrapEnabled) {
        const lines = [];
        for (let i = 1; i <= count; i++) lines.push(i);
        lineGutter.textContent = lines.join('\n');
        return;
    }

    // Wrapped mode
    const cs = window.getComputedStyle(ta);
    const textWidth = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    lineMirror.style.width = textWidth + 'px';

    const newLines = ta.value.split('\n');

    // Differential update: same line count and existing mirror divs
    if (newLines.length === prevLines.length && mirrorDivs.length === newLines.length) {
        for (let i = 0; i < newLines.length; i++) {
            if (newLines[i] !== prevLines[i]) {
                mirrorDivs[i].textContent = newLines[i] || '\u00A0';
                const newHeight = mirrorDivs[i].offsetHeight;
                if (newHeight !== lineHeights[i]) {
                    lineHeights[i] = newHeight;
                    gutterDivs[i].style.height = newHeight + 'px';
                }
            }
        }
        prevLines = newLines;
        lastLineCount = newLines.length;
        return;
    }

    // Full rebuild: line count changed or first render in wrap mode
    fullRebuildLineNumbers(newLines);
}

function toggleWordWrap() {
    wordWrapEnabled = !wordWrapEnabled;
    applyWordWrap();
    invoke('save_preference_key', { key: 'word_wrap', value: wordWrapEnabled })
        .catch(err => console.error('Failed to save word_wrap preference:', err));
}

function applyWordWrap() {
    const ta = document.getElementById('editor-textarea');
    const wrapBtn = document.getElementById('wrap-btn');
    if (ta) {
        ta.style.whiteSpace = wordWrapEnabled ? 'pre-wrap' : 'pre';
        ta.style.overflowX = wordWrapEnabled ? 'hidden' : 'auto';
        ta.style.wordBreak = wordWrapEnabled ? 'break-word' : 'normal';
    }
    if (findHighlightOverlay) {
        findHighlightOverlay.style.whiteSpace = wordWrapEnabled ? 'pre-wrap' : 'pre';
        findHighlightOverlay.style.overflowX = wordWrapEnabled ? 'hidden' : 'auto';
        findHighlightOverlay.style.wordBreak = wordWrapEnabled ? 'break-word' : 'normal';
    }
    if (wrapBtn) wrapBtn.classList.toggle('active', wordWrapEnabled);
    prevLines = [];
    mirrorDivs = [];
    gutterDivs = [];
    lineHeights = [];
    lastLineCount = -1;
    updateLineNumbers();
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

    setupEditorWrapper();
    const textarea = document.getElementById('editor-textarea');
    updateLineNumbers();
    applyLineNumberVisibility();

    // Track changes
    textarea.addEventListener('input', () => {
        markDirty();
        scheduleAutoSave();
        scheduleLineNumberUpdate();
    });

    // Close button just triggers close -- onCloseRequested handles the save
    document.getElementById('close-btn').addEventListener('click', () => {
        appWindow.close();
    });

    document.getElementById('editor-font-size-decrease-btn').addEventListener('click', () => changeFontSize(-1));
    document.getElementById('editor-font-size-increase-btn').addEventListener('click', () => changeFontSize(1));
    document.getElementById('line-numbers-btn').addEventListener('click', toggleLineNumbers);
    document.getElementById('wrap-btn').addEventListener('click', toggleWordWrap);

    new ResizeObserver(() => {
        if (wordWrapEnabled) {
            prevLines = [];
            mirrorDivs = [];
            gutterDivs = [];
            lineHeights = [];
            scheduleLineNumberUpdate();
        }
    }).observe(textarea);

    // Keyboard shortcuts (table-driven)
    setupKeyboardShortcuts([
        { key: 'f', ctrl: true, action: () => openFindOverlay() },
        { key: 'h', ctrl: true, action: () => { openFindOverlay(); if (replaceInput) replaceInput.focus(); } },
        { key: 's', ctrl: true, action: () => saveFile() },
        { key: 'w', ctrl: true, action: () => appWindow.close() },
    ]);
    
    // Sync: send scroll position to preview
    textarea.addEventListener('scroll', () => {
        if (lineGutter) lineGutter.scrollTop = textarea.scrollTop;
        if (!currentFilePath || isProgrammaticScroll) return;
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
                const kind = isJson ? KIND_JSON : (isYaml ? KIND_YAML : KIND_TXT);
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
                payload = { source: appWindow.label, file_path: currentFilePath, kind: KIND_MARKDOWN, line: null, percent };
            }
            try {
                await invoke('broadcast_scroll_sync', { payload });
            } catch (e) {
                // ignore
            }
        }, SCROLL_SYNC_DEBOUNCE_MS);
    });

    // Listen for scroll sync events
    await listen(EVENT_SCROLL_SYNC, (event) => {
        const p = event.payload || {};
        if (!currentFilePath) return;
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

    // Listen for menu find requests
    await listen(EVENT_MENU_FIND, () => {
        openFindOverlay();
    });

    // Listen for edit menu actions
    await listen(EVENT_MENU_EDIT, async (event) => {
        if (!document.hasFocus()) return;
        const action = String(event.payload || '');
        performEditAction(action);
    });

    // Listen for theme changes
    await listen(EVENT_THEME_CHANGED, (event) => {
        applyThemeToDocument(event.payload);
    });

    await listen(EVENT_FONT_SIZE_CHANGED, (event) => {
        if (Number(event.payload) === currentFontSize) return;
        applyFontSize(event.payload);
    });

    // Listen for close menu action -- onCloseRequested handles the save
    await listen(EVENT_MENU_CLOSE, async () => {
        if (!document.hasFocus()) return;
        appWindow.close();
    });

    // Listen for print menu action
    await listen(EVENT_MENU_PRINT, () => {
        if (!document.hasFocus()) return;
        window.print();
    });

    const findBtn = document.getElementById('find-btn');
    if (findBtn) findBtn.addEventListener('click', toggleFindOverlay);

    // Use Tauri's onCloseRequested so we can reliably await the async save
    // before allowing the window to close (beforeunload cannot await).
    await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }
        if (isDirty) {
            await saveFile();
        }
        await notifyPreviewEditorClosed();
        appWindow.destroy();
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
            case ACTION_UNDO:
                textarea.focus();
                document.execCommand('undo');
                break;
            case ACTION_REDO:
                textarea.focus();
                document.execCommand('redo');
                break;
            case ACTION_COPY:
                if (textarea.selectionStart !== textarea.selectionEnd) {
                    const text = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
                    await navigator.clipboard.writeText(text);
                }
                break;
            case ACTION_CUT:
                if (textarea.selectionStart !== textarea.selectionEnd) {
                    const cutText = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
                    await navigator.clipboard.writeText(cutText);
                    const cutStart = textarea.selectionStart;
                    textarea.value = textarea.value.slice(0, cutStart) + textarea.value.slice(textarea.selectionEnd);
                    textarea.setSelectionRange(cutStart, cutStart);
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
                break;
            case ACTION_PASTE:
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
            case ACTION_SELECT_ALL:
                textarea.select();
                break;
        }
    } catch (err) {
        console.error('Edit action failed:', err);
    }
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

    // Add replace row
    const replaceRow = document.createElement('div');
    replaceRow.className = 'replace-row';
    replaceRow.innerHTML = `
        <input id="replace-input" class="find-input replace-input" type="text" placeholder="Replace..." />
        <button class="find-btn replace-btn-text" id="replace-one" title="Replace current match">Replace</button>
        <button class="find-btn replace-btn-text" id="replace-all" title="Replace all matches">All</button>
    `;
    findOverlay.appendChild(replaceRow);
    replaceInput = replaceRow.querySelector('#replace-input');

    findInput.addEventListener('input', () => performFind(findInput.value));
    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) findPrevious(); else findNext();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeFindOverlay();
        } else if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            replaceInput.focus();
        }
    });

    replaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            replaceCurrent();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeFindOverlay();
        } else if (e.key === 'Tab' && e.shiftKey) {
            e.preventDefault();
            findInput.focus();
        }
    });

    findOverlay.querySelector('#find-prev').addEventListener('click', findPrevious);
    findOverlay.querySelector('#find-next').addEventListener('click', findNext);
    findOverlay.querySelector('#find-close').addEventListener('click', closeFindOverlay);
    findOverlay.querySelector('#replace-one').addEventListener('click', replaceCurrent);
    findOverlay.querySelector('#replace-all').addEventListener('click', replaceAll);

    // Create highlight overlay that sits on top of the textarea (wrapper already exists)
    if (!findHighlightOverlay) {
        const ta = document.getElementById('editor-textarea');
        const wrapper = ta.closest('.editor-textarea-wrapper');

        findHighlightOverlay = document.createElement('div');
        findHighlightOverlay.className = 'find-highlight-overlay';
        wrapper.appendChild(findHighlightOverlay);

        // Sync textarea scroll to overlay
        ta.addEventListener('scroll', () => {
            if (findHighlightOverlay) findHighlightOverlay.scrollTop = ta.scrollTop;
        });
    }
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
    if (currentQuery !== lastSearchQuery || findResults.length === 0) {
        performFind(currentQuery);
        return;
    }
    currentFindIndex = nextFindIndex(currentFindIndex, findResults.length, 1);
    highlightCurrentFind();
    updateFindCountDisplay();
}

function findPrevious() {
    const currentQuery = findInput.value;
    if (currentQuery !== lastSearchQuery || findResults.length === 0) {
        performFind(currentQuery);
        return;
    }
    currentFindIndex = nextFindIndex(currentFindIndex, findResults.length, -1);
    highlightCurrentFind();
    updateFindCountDisplay();
}

function highlightCurrentFind() {
    if (currentFindIndex < 0 || currentFindIndex >= findResults.length) {
        if (findHighlightOverlay) findHighlightOverlay.innerHTML = '';
        return;
    }

    const result = findResults[currentFindIndex];
    const ta = document.getElementById('editor-textarea');
    const text = ta.value;

    // Update highlight overlay with current match marked
    if (findHighlightOverlay) {
        const before = escapeHtml(text.slice(0, result.start));
        const match = escapeHtml(text.slice(result.start, result.end));
        const after = escapeHtml(text.slice(result.end));
        findHighlightOverlay.innerHTML = before + '<mark>' + match + '</mark>' + after;
        findHighlightOverlay.scrollTop = ta.scrollTop;

        // Use the mark element's rendered position for accurate scrolling
        const mark = findHighlightOverlay.querySelector('mark');
        if (mark) {
            const overlayTop = findHighlightOverlay.getBoundingClientRect().top;
            const markTop = mark.getBoundingClientRect().top;
            const offset = markTop - overlayTop + findHighlightOverlay.scrollTop;
            isProgrammaticScroll = true;
            ta.scrollTop = Math.max(0, offset - ta.clientHeight / 2);
            findHighlightOverlay.scrollTop = ta.scrollTop;
            setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
        }
    }
}

function replaceCurrent() {
    if (currentFindIndex < 0 || currentFindIndex >= findResults.length) return;
    if (!replaceInput) return;

    const ta = document.getElementById('editor-textarea');
    const result = findResults[currentFindIndex];
    const oldStart = result.start;
    const replacement = replaceInput.value;

    ta.value = ta.value.slice(0, result.start) + replacement + ta.value.slice(result.end);
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    const savedIndex = currentFindIndex;
    performFind(findInput.value);

    if (findResults.length > 0) {
        currentFindIndex = Math.min(savedIndex, findResults.length - 1);
        // If the replacement itself matches, skip past it to the next match
        if (findResults[currentFindIndex] && findResults[currentFindIndex].start === oldStart) {
            currentFindIndex = (currentFindIndex + 1) % findResults.length;
        }
        highlightCurrentFind();
        updateFindCountDisplay();
    }
}

function replaceAll() {
    if (findResults.length === 0) return;
    if (!replaceInput) return;

    const ta = document.getElementById('editor-textarea');
    const replacement = replaceInput.value;
    const query = findInput.value;
    const regex = new RegExp(escapeRegex(query), 'gi');

    ta.value = ta.value.replace(regex, replacement);
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    performFind(query);
}

function clearFindResults() {
    findResults = [];
    currentFindIndex = -1;
    if (findHighlightOverlay) findHighlightOverlay.innerHTML = '';
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
    if (replaceInput) replaceInput.value = '';
}
