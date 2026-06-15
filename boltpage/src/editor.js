import {
    SCROLL_SYNC_DEBOUNCE_MS,
    PROGRAMMATIC_SCROLL_TIMEOUT_MS,
    MIN_SCROLL_DELTA_LINES,
    MIN_SCROLL_DELTA_PERCENT,
    DEFAULT_FONT_SIZE,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    EDITOR_FONT_SIZE_OFFSET,
    FIND_TYPE_DEBOUNCE_MS,
    clampFontSize,
    setBadgeState,
    createFindOverlay,
    updateFindCount,
    applyThemeToDocument,
    applyFontFamily,
    DEFAULT_DOCUMENT_FONT_ID,
    DEFAULT_EDITOR_FONT_ID,
    setupKeyboardShortcuts,
    setupChordShortcuts,
    createCommandPalette,
    isUrlLike,
} from './shared.js';
import {
    EVENT_FILE_CHANGED,
    EVENT_THEME_CHANGED,
    EVENT_FONT_SIZE_CHANGED,
    EVENT_FONT_FAMILY_CHANGED,
    EVENT_TOOLBAR_DENSITY_CHANGED,
    EVENT_SCROLL_SYNC,
    EVENT_MENU_CLOSE,
    EVENT_MENU_FIND,
    EVENT_MENU_FIND_NEXT,
    EVENT_MENU_FIND_PREV,
    EVENT_MENU_FIND_USE_SELECTION,
    EVENT_MENU_FIND_REPLACE,
    EVENT_MENU_FORMAT_BOLD,
    EVENT_MENU_FORMAT_ITALIC,
    EVENT_MENU_FORMAT_LINK,
    EVENT_MENU_FORMAT_STRIKE,
    EVENT_MENU_COMMAND_PALETTE,
    EVENT_MENU_PRINT,
    KIND_MARKDOWN,
    KIND_JSON,
    KIND_YAML,
    KIND_TXT,
} from './constants.js';
// Vendored CodeMirror 6 (pinned build, see scripts/vendor-codemirror.sh).
// Assembled from explicit extensions; basicSetup is deliberately not used
// because its searchKeymap (Mod-F) would conflict with the docked find bar.
import {
    EditorView,
    keymap,
    lineNumbers,
    drawSelection,
    placeholder,
    rectangularSelection,
    crosshairCursor,
    highlightActiveLine,
    highlightActiveLineGutter,
    scrollPastEnd,
    EditorState,
    Compartment,
    EditorSelection,
    history,
    defaultKeymap,
    historyKeymap,
    indentWithTab,
    codeFolding,
    foldGutter,
    foldKeymap,
    foldAll,
    unfoldAll,
    syntaxHighlighting,
    markdown,
    markdownLanguage,
    markdownKeymap,
    search,
    SearchQuery,
    setSearchQuery,
    findNext as cmFindNext,
    findPrevious as cmFindPrevious,
    replaceNext as cmReplaceNext,
    replaceAll as cmReplaceAll,
    highlightSelectionMatches,
    classHighlighter,
} from '/assets/vendor/codemirror/codemirror.min.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();
let currentFilePath = null;
let currentFileKind = KIND_MARKDOWN;
let editorView = null;
let isDirty = false;
let saveTimeout = null;
// Serialize saves: a save in flight defers the next request via pendingSave so
// two write_file calls never overlap (which could land out of order).
let isSaving = false;
let pendingSave = false;
let previewWindow = null;
let isProgrammaticScroll = false;
let scrollDebounce = null;
let wordWrapEnabled = false;
let showLineNumbers = true;
let currentFontSize = 18;
let currentToolbarDensity = 'icon-label';
let closeEventSent = false;
let inspectorRafId = null;
let inspectorEol = 'LF';
let commandPalette = null;
// Last known on-disk content, LF-normalized. Used to tell our own save echo
// (and no-op rewrites) apart from genuine external modifications.
let lastKnownDiskText = '';
// True while a programmatic dispatch loads/normalizes content, so the update
// listener doesn't mark the buffer dirty or schedule saves for it.
let programmaticChange = false;
// On-type preview: debounce + size guard for buffer broadcasts.
const BUFFER_BROADCAST_DEBOUNCE_MS = 150;
const BUFFER_BROADCAST_MAX_CHARS = 2_000_000;
let bufferBroadcastTimer = null;
let bufferSizeWarned = false;

// CM compartments for the togglable bits.
const gutterCompartment = new Compartment();
const wrapCompartment = new Compartment();

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

// === Editor view =================================================

function buildEditorExtensions() {
    return [
        history(),
        drawSelection(),
        // Multi-cursor: Alt+click adds carets, Alt+drag column-selects.
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        // Other occurrences of the selected text get .cm-selectionMatch.
        highlightSelectionMatches(),
        // Last line can scroll to eye level; percent scroll-sync compensates
        // for the virtual bottom padding via documentPadding (see
        // editorScrollableHeight).
        scrollPastEnd(),
        codeFolding(),
        gutterCompartment.of(showLineNumbers ? [lineNumbers(), foldGutter()] : []),
        wrapCompartment.of(wordWrapEnabled ? EditorView.lineWrapping : []),
        // GFM-flavored base so strikethrough/tables/task lists highlight.
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(classHighlighter),
        search(),
        placeholder('Start typing...'),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences' }),
        EditorView.domEventHandlers({ paste: handleEditorPaste }),
        // markdownKeymap must precede defaultKeymap: its Enter (continue
        // list/quote marker) and Backspace (delete empty marker) lose to
        // insertNewlineAndIndent otherwise. indentWithTab is a single binding.
        keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
        EditorView.updateListener.of(onEditorUpdate),
    ];
}

function onEditorUpdate(update) {
    if (update.docChanged) {
        if (!programmaticChange) {
            markDirty();
            scheduleAutoSave();
            scheduleBufferBroadcast();
        }
        scheduleInspectorUpdate();
    } else if (update.selectionSet) {
        scheduleInspectorUpdate();
    }
}

function createEditorView(doc) {
    const host = document.getElementById('editor-host');
    editorView = new EditorView({
        state: EditorState.create({ doc, extensions: buildEditorExtensions() }),
        parent: host,
    });
    editorView.scrollDOM.addEventListener('scroll', onEditorScroll);
}

/**
 * Normalize raw file content for the buffer. The buffer is kept LF-normalized
 * (matching what the old textarea enforced); the on-disk EOL mode is
 * remembered in `inspectorEol` and re-applied by saveFile.
 */
async function prepareContent(raw) {
    inspectorEol = raw.includes('\r\n') ? 'CRLF' : 'LF';
    const normalized = raw.replace(/\r\n/g, '\n');
    lastKnownDiskText = normalized;
    let content = normalized;
    if (currentFilePath && currentFilePath.toLowerCase().endsWith('.json')) {
        try {
            content = await invoke('format_json_pretty', { content });
        } catch (e) {
            console.warn('JSON pretty formatting failed; showing raw:', e);
        }
    }
    return content;
}

/**
 * Replace the whole buffer with fresh disk content (external reload).
 * Replaces the editor state, which intentionally drops undo history: undoing
 * across an external reload would resurrect a stale file.
 */
async function applyFileContent(raw, statusLabel) {
    const content = await prepareContent(raw);
    editorView.setState(EditorState.create({ doc: content, extensions: buildEditorExtensions() }));
    updateStatus(statusLabel);
}

// === Chrome: font size, density, inspector ======================

function updateFontSizeControls() {
    const indicator = document.getElementById('editor-font-size-indicator');
    const decreaseBtn = document.getElementById('editor-font-size-decrease-btn');
    const increaseBtn = document.getElementById('editor-font-size-increase-btn');
    if (indicator) indicator.textContent = `${currentFontSize}px`;
    if (decreaseBtn) decreaseBtn.disabled = currentFontSize <= MIN_FONT_SIZE;
    if (increaseBtn) increaseBtn.disabled = currentFontSize >= MAX_FONT_SIZE;
}

function editorFontSizePx(fontSize = currentFontSize) {
    return Math.max(12, clampFontSize(fontSize) - EDITOR_FONT_SIZE_OFFSET);
}

function applyFontSize(fontSize, options = {}) {
    const { save = false, broadcast = false } = options;
    const nextFontSize = clampFontSize(fontSize);
    const anchorLine = editorView && currentFilePath ? getTopLineForEditor() : null;
    currentFontSize = nextFontSize;

    document.documentElement.style.setProperty('--editor-font-size', `${editorFontSizePx(currentFontSize)}px`);
    document.documentElement.style.setProperty('--editor-gutter-font-size', `${Math.max(11, editorFontSizePx(currentFontSize) - 1)}px`);
    if (editorView) editorView.requestMeasure();

    updateFontSizeControls();

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

function normalizeDensity(v) {
    return v === 'icon' || v === 'label' ? v : 'icon-label';
}

function applyToolbarDensity(density) {
    currentToolbarDensity = normalizeDensity(density);
    document.documentElement.dataset.toolbarDensity = currentToolbarDensity;
}

function applyInspectorVisibility(visible) {
    const inspectorEl = document.getElementById('editor-inspector');
    const inspectorToggle = document.getElementById('editor-inspector-toggle');
    if (!inspectorEl || !inspectorToggle) return;
    if (visible) {
        inspectorEl.removeAttribute('hidden');
        inspectorToggle.classList.add('active');
        inspectorToggle.setAttribute('aria-pressed', 'true');
        scheduleInspectorUpdate();
    } else {
        inspectorEl.setAttribute('hidden', '');
        inspectorToggle.classList.remove('active');
        inspectorToggle.setAttribute('aria-pressed', 'false');
    }
}

function toggleInspector() {
    const inspectorEl = document.getElementById('editor-inspector');
    if (!inspectorEl) return;
    const next = inspectorEl.hasAttribute('hidden');
    applyInspectorVisibility(next);
    invoke('save_preference_key', { key: 'editor_inspector_visible', value: next })
        .catch(err => console.error('Failed to save editor_inspector_visible preference:', err));
}

function scheduleInspectorUpdate() {
    if (inspectorRafId) return;
    inspectorRafId = requestAnimationFrame(() => {
        inspectorRafId = null;
        updateInspector();
    });
}

function updateInspector() {
    const inspectorEl = document.getElementById('editor-inspector');
    if (!inspectorEl || inspectorEl.hasAttribute('hidden')) return;
    if (!editorView) return;
    const state = editorView.state;
    const text = state.doc.toString();
    const words = (text.trim().match(/\S+/g) || []).length;
    const chars = text.length;
    const lines = text === '' ? 0 : state.doc.lines;

    const sel = state.selection.main;
    const cursorLineObj = state.doc.lineAt(sel.head);
    const cursorLine = cursorLineObj.number;
    const cursorCol = sel.head - cursorLineObj.from + 1;
    const selLen = sel.to - sel.from;

    const el = (id) => document.getElementById(id);
    const elWords = el('inspector-words');
    const elChars = el('inspector-chars');
    const elLines = el('inspector-lines');
    const elCursor = el('inspector-cursor');
    const elSel = el('inspector-selection');
    const elEncoding = el('inspector-encoding');
    const elEol = el('inspector-eol');
    if (elWords) elWords.textContent = String(words);
    if (elChars) elChars.textContent = String(chars);
    if (elLines) elLines.textContent = String(lines);
    if (elCursor) elCursor.textContent = `${cursorLine}:${cursorCol}`;
    if (elSel) elSel.textContent = String(selLen);
    if (elEncoding) elEncoding.textContent = 'UTF-8';
    if (elEol) elEol.textContent = inspectorEol;
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
    const btn = document.getElementById('line-numbers-btn');
    if (editorView) {
        editorView.dispatch({
            effects: gutterCompartment.reconfigure(
                showLineNumbers ? [lineNumbers(), foldGutter()] : []
            ),
        });
    }
    if (btn) btn.classList.toggle('active', showLineNumbers);
}

function toggleLineNumbers() {
    showLineNumbers = !showLineNumbers;
    applyLineNumberVisibility();
    invoke('save_preference_key', { key: 'show_line_numbers', value: showLineNumbers })
        .catch(err => console.error('Failed to save show_line_numbers preference:', err));
}

function applyWordWrap() {
    const wrapBtn = document.getElementById('wrap-btn');
    if (editorView) {
        editorView.dispatch({
            effects: wrapCompartment.reconfigure(wordWrapEnabled ? EditorView.lineWrapping : []),
        });
    }
    if (wrapBtn) wrapBtn.classList.toggle('active', wordWrapEnabled);
}

function toggleWordWrap() {
    wordWrapEnabled = !wordWrapEnabled;
    applyWordWrap();
    invoke('save_preference_key', { key: 'word_wrap', value: wordWrapEnabled })
        .catch(err => console.error('Failed to save word_wrap preference:', err));
}

// === Status, save, external changes ==============================

function updateStatus(status) {
    const statusBadge = document.getElementById('editor-status-badge');
    let tone = null;
    if (/saved|loaded/i.test(status)) tone = 'success';
    if (/modified/i.test(status)) tone = 'warning';
    if (/changed/i.test(status)) tone = 'warning';
    if (/error/i.test(status)) tone = 'warning';
    setBadgeState(statusBadge, status, tone, false);
}

function markDirty() {
    if (!isDirty) {
        isDirty = true;
        updateStatus('Modified');
    }
}

// Returns true when the buffer is persisted (or there was nothing to save),
// false when the write failed. Callers that close the window must honor false.
async function saveFile() {
    if (!currentFilePath || !isDirty || !editorView) return true;
    // A save is already running: let it finish, then flush the newer buffer.
    if (isSaving) {
        pendingSave = true;
        return true;
    }
    isSaving = true;
    try {
        let content = editorView.state.doc.toString();

        // For JSON files, normalize to the same pretty-sorted format as preview
        const lower = currentFilePath.toLowerCase();
        if (lower.endsWith('.json')) {
            try {
                const formatted = await invoke('format_json_pretty', { content });
                // Rewrite the buffer only when formatting changed it; CM maps the
                // selection through the change, so the caret stays put.
                if (formatted !== content) {
                    programmaticChange = true;
                    try {
                        editorView.dispatch({
                            changes: { from: 0, to: editorView.state.doc.length, insert: formatted },
                        });
                    } finally {
                        programmaticChange = false;
                    }
                    content = formatted;
                }
            } catch (e) {
                console.warn('JSON pretty formatting failed on save; saving raw content:', e);
            }
        }

        try {
            // Buffer text is LF-normalized; re-apply the file's on-disk EOL mode.
            const onDisk = inspectorEol === 'CRLF' ? content.replace(/\n/g, '\r\n') : content;
            await invoke('write_file', { path: currentFilePath, content: onDisk });
            lastKnownDiskText = content;
            // Only clear the dirty flag when the buffer still matches what we
            // wrote; edits that landed during the write keep it set so the next
            // save persists them instead of seeing a falsely-clean buffer.
            isDirty = editorView.state.doc.toString() !== content;
            updateStatus(isDirty ? 'Modified' : 'Saved');

            // Notify preview window to refresh (fire-and-forget; don't steal focus)
            if (previewWindow) {
                invoke('refresh_preview', { window: previewWindow }).catch(() => {});
            }
            return true;
        } catch (err) {
            console.error('Failed to save file:', err);
            updateStatus('Error saving');
            return false;
        }
    } finally {
        isSaving = false;
        // Edits arrived while this save was in flight: schedule a flush.
        if (pendingSave) {
            pendingSave = false;
            scheduleAutoSave();
        }
    }
}

/**
 * The watched file changed on disk. Distinguish three cases:
 * - our own save echo / no-op rewrite (disk matches lastKnownDiskText): ignore;
 * - clean buffer: reload from disk, preserving caret and scroll best-effort;
 * - dirty buffer: keep the user's edits, surface a persistent warning badge.
 *   Autosave still wins on the next write (deliberate last-writer-wins, but
 *   now visible instead of a silent clobber).
 */
async function handleExternalFileChange() {
    if (!currentFilePath || !editorView) return;
    let raw;
    try {
        raw = await invoke('read_file', { path: currentFilePath });
    } catch (err) {
        console.error('Failed to re-read externally changed file:', err);
        return;
    }
    const normalized = raw.replace(/\r\n/g, '\n');
    if (normalized === lastKnownDiskText) return;
    if (isDirty) {
        lastKnownDiskText = normalized;
        updateStatus('File changed on disk');
        return;
    }
    const prevHead = editorView.state.selection.main.head;
    const prevScroll = editorView.scrollDOM.scrollTop;
    await applyFileContent(raw, 'Reloaded');
    const pos = Math.min(prevHead, editorView.state.doc.length);
    editorView.dispatch({ selection: { anchor: pos } });
    editorView.scrollDOM.scrollTop = prevScroll;
    scheduleInspectorUpdate();
}

/**
 * Broadcast the unsaved buffer so the preview renders on type instead of
 * waiting for the autosave + watcher roundtrip.
 */
function scheduleBufferBroadcast() {
    if (!currentFilePath) return;
    if (bufferBroadcastTimer) clearTimeout(bufferBroadcastTimer);
    bufferBroadcastTimer = setTimeout(() => {
        if (!editorView) return;
        const content = editorView.state.doc.toString();
        if (content.length > BUFFER_BROADCAST_MAX_CHARS) {
            if (!bufferSizeWarned) {
                bufferSizeWarned = true;
                console.info('Buffer too large for on-type preview; falling back to save-based refresh.');
            }
            return;
        }
        invoke('broadcast_editor_buffer', {
            payload: {
                source: appWindow.label,
                file_path: currentFilePath,
                kind: currentFileKind,
                content,
            },
        }).catch(err => console.error('Failed to broadcast buffer:', err));
    }, BUFFER_BROADCAST_DEBOUNCE_MS);
}

function scheduleAutoSave() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }

    saveTimeout = setTimeout(() => {
        saveFile();
    }, 700); // Slightly longer debounce for smoother typing
}

// === Markdown format commands ====================================

/**
 * Wrap the main selection in `before`/`after`; unwrap when the selection (or
 * its immediate surroundings) already carries the markers. Same semantics the
 * textarea-based toggleWrap had.
 */
function cmToggleWrap(view, before, after) {
    if (!view) return;
    const { state } = view;
    const range = state.selection.main;
    const selected = state.sliceDoc(range.from, range.to);

    const alreadyWrapped = selected.startsWith(before) && selected.endsWith(after)
        && selected.length >= before.length + after.length;
    if (alreadyWrapped) {
        const inner = selected.slice(before.length, selected.length - after.length);
        view.dispatch({
            changes: { from: range.from, to: range.to, insert: inner },
            selection: EditorSelection.range(range.from, range.from + inner.length),
        });
        view.focus();
        return;
    }

    const beforeStart = Math.max(0, range.from - before.length);
    const outsideBefore = state.sliceDoc(beforeStart, range.from);
    const outsideAfter = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + after.length));
    if (outsideBefore === before && outsideAfter === after && selected.length > 0) {
        view.dispatch({
            changes: { from: beforeStart, to: range.to + after.length, insert: selected },
            selection: EditorSelection.range(beforeStart, beforeStart + selected.length),
        });
        view.focus();
        return;
    }

    view.dispatch({
        changes: { from: range.from, to: range.to, insert: `${before}${selected}${after}` },
        selection: selected.length === 0
            ? EditorSelection.cursor(range.from + before.length)
            : EditorSelection.range(
                range.from + before.length,
                range.from + before.length + selected.length
            ),
    });
    view.focus();
}

/** Insert `[sel](url)` with "url" selected, or `[](url)` with the caret in the
 *  label slot when the selection is empty. */
function cmInsertLink(view) {
    if (!view) return;
    const { state } = view;
    const range = state.selection.main;
    const selected = state.sliceDoc(range.from, range.to);
    if (selected.length > 0) {
        const urlStart = range.from + 1 + selected.length + 2; // after "]("
        view.dispatch({
            changes: { from: range.from, to: range.to, insert: `[${selected}](url)` },
            selection: EditorSelection.range(urlStart, urlStart + 3),
        });
    } else {
        view.dispatch({
            changes: { from: range.from, to: range.to, insert: '[](url)' },
            selection: EditorSelection.cursor(range.from + 1),
        });
    }
    view.focus();
}

/** Paste URL over a non-empty selection → auto-link. */
function handleEditorPaste(e, view) {
    const text = (e.clipboardData && e.clipboardData.getData('text/plain') || '').trim();
    if (!isUrlLike(text)) return false;
    const range = view.state.selection.main;
    if (range.empty) return false;
    const selected = view.state.sliceDoc(range.from, range.to);
    view.dispatch({
        changes: { from: range.from, to: range.to, insert: `[${selected}](${text})` },
        selection: EditorSelection.cursor(range.from + selected.length + text.length + 4),
    });
    e.preventDefault();
    return true;
}

// === Scroll sync =================================================

function getTopLineForEditor() {
    if (!editorView) return null;
    const block = editorView.lineBlockAtHeight(editorView.scrollDOM.scrollTop);
    return editorView.state.doc.lineAt(block.from).number;
}

/**
 * Scrollable height for percent-based sync. scrollPastEnd inflates
 * scrollHeight with virtual bottom padding so the last line can reach the
 * top; percentages must be computed against the content's real end or
 * "bottom of document" syncs the preview to ~80%. Can be <= 0 for documents
 * shorter than the viewport (which can still scroll past their end): callers
 * skip sync then, matching the old content-fits behavior.
 */
function editorScrollableHeight() {
    const sd = editorView.scrollDOM;
    const padBottom = editorView.documentPadding ? editorView.documentPadding.bottom : 0;
    return sd.scrollHeight - sd.clientHeight - padBottom;
}

function scrollEditorToLine(line) {
    if (!editorView) return;
    const doc = editorView.state.doc;
    const n = Math.max(1, Math.min(doc.lines, Math.round(line)));
    isProgrammaticScroll = true;
    editorView.dispatch({
        effects: EditorView.scrollIntoView(doc.line(n).from, { y: 'start' }),
    });
    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
}

function onEditorScroll() {
    if (!currentFilePath || isProgrammaticScroll || !editorView) return;
    if (scrollDebounce) clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(async () => {
        const lower = currentFilePath.toLowerCase();
        const isJson = lower.endsWith('.json');
        const isYaml = lower.endsWith('.yaml') || lower.endsWith('.yml');
        const isTxt = lower.endsWith('.txt');
        let payload;
        if (isJson || isYaml || isTxt) {
            const line = getTopLineForEditor();
            if (line === null) return;
            // Filter micro-scrolls: only broadcast if line changed significantly
            if (lastSyncedLine !== null && Math.abs(line - lastSyncedLine) < MIN_SCROLL_DELTA_LINES) {
                return;
            }
            lastSyncedLine = line;
            const kind = isJson ? KIND_JSON : (isYaml ? KIND_YAML : KIND_TXT);
            payload = { source: appWindow.label, file_path: currentFilePath, kind, line, percent: null };
        } else {
            const scrollableHeight = editorScrollableHeight();
            if (scrollableHeight <= 0) {
                // Content fits in viewport, no scroll sync needed
                return;
            }
            const percent = Math.max(0, Math.min(1, editorView.scrollDOM.scrollTop / scrollableHeight));
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
}

// === Init ========================================================

async function initialize() {
    // Get file path from initialization script
    currentFilePath = window.__INITIAL_FILE_PATH__;
    previewWindow = window.__PREVIEW_WINDOW__;
    currentFileKind = detectFileKind(currentFilePath);

    // Load preferences before the view exists so the first paint uses the
    // right gutter/wrap/typography configuration.
    try {
        const prefs = await invoke('get_preferences');
        applyThemeToDocument(prefs.theme);
        applyFontSize(prefs.font_size);
        wordWrapEnabled = prefs.word_wrap === true;
        showLineNumbers = prefs.show_line_numbers !== false;
        applyToolbarDensity(prefs.toolbar_density);
        applyInspectorVisibility(prefs.editor_inspector_visible === true);
        applyFontFamily({
            documentId: prefs.document_font_family || DEFAULT_DOCUMENT_FONT_ID,
            editorId: prefs.editor_font_family || DEFAULT_EDITOR_FONT_ID,
        });
    } catch (err) {
        console.error('Failed to load preferences:', err);
        applyFontSize(DEFAULT_FONT_SIZE);
        applyToolbarDensity('icon-label');
        applyFontFamily({ documentId: DEFAULT_DOCUMENT_FONT_ID, editorId: DEFAULT_EDITOR_FONT_ID });
    }

    // Load file content into a fresh editor state.
    let initialDoc = '';
    let loadStatus = 'Ready';
    if (currentFilePath) {
        try {
            const raw = await invoke('read_file', { path: currentFilePath });
            initialDoc = await prepareContent(raw);
            loadStatus = 'Loaded';

            const filename = currentFilePath.split(/[/\\]/).pop();
            appWindow.setTitle(`BoltPage Editor - ${filename}`);
        } catch (err) {
            console.error('Failed to load file:', err);
            loadStatus = 'Error loading file';
        }
    }
    createEditorView(initialDoc);
    updateStatus(loadStatus);
    applyLineNumberVisibility();
    applyWordWrap();
}

// Set up event listeners
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initialize();

    // Watch the file so external edits surface in the editor too (the preview
    // already does this). The Rust CloseRequested handler unsubscribes this
    // window's watcher on close.
    if (currentFilePath) {
        try {
            await invoke('start_file_watcher', {
                filePath: currentFilePath,
                windowLabel: appWindow.label,
            });
        } catch (err) {
            console.error('Failed to start editor file watcher:', err);
        }
        await listen(EVENT_FILE_CHANGED, () => {
            handleExternalFileChange();
        });
    }

    // Close button just triggers close -- onCloseRequested handles the save
    document.getElementById('close-btn').addEventListener('click', () => {
        appWindow.close();
    });

    document.getElementById('editor-font-size-decrease-btn').addEventListener('click', () => changeFontSize(-1));
    document.getElementById('editor-font-size-increase-btn').addEventListener('click', () => changeFontSize(1));
    document.getElementById('line-numbers-btn').addEventListener('click', toggleLineNumbers);
    document.getElementById('wrap-btn').addEventListener('click', toggleWordWrap);

    // Keyboard shortcuts (table-driven; more-specific variants must precede less-specific)
    setupKeyboardShortcuts([
        { key: 'i', ctrl: true, shift: true, action: () => toggleInspector() },
        { key: 'f', ctrl: true, alt: true, action: () => openFindAndReplace() },
        { key: 'f', ctrl: true, action: () => openFindOverlay() },
        { key: 'g', ctrl: true, shift: true, action: () => findPrevious() },
        { key: 'g', ctrl: true, action: () => findNext() },
        { key: 'e', ctrl: true, action: () => useSelectionForFindFromEditor() },
        { key: 's', ctrl: true, action: () => saveFile() },
        { key: 'w', ctrl: true, action: () => appWindow.close() },
        // Format shortcuts. Cmd+K is reserved as the chord prefix (Cmd+K Cmd+P);
        // Insert Link binds to Cmd+Shift+U to avoid the 400ms chord-timeout latency.
        { key: 'b', ctrl: true, action: () => cmToggleWrap(editorView, '**', '**') },
        { key: 'i', ctrl: true, action: () => cmToggleWrap(editorView, '*', '*') },
        { key: 'k', ctrl: true, shift: true, action: () => cmToggleWrap(editorView, '~~', '~~') },
        { key: 'u', ctrl: true, shift: true, action: () => cmInsertLink(editorView) },
    ]);

    // Chord shortcut: Cmd+K Cmd+P opens the command palette.
    setupChordShortcuts([{
        key1: 'k', ctrl1: true,
        secondKeys: [
            { key2: 'p', ctrl2: true, action: () => openPalette() },
        ],
    }]);

    // Listen for scroll sync events
    await listen(EVENT_SCROLL_SYNC, (event) => {
        const p = event.payload || {};
        if (!currentFilePath || !editorView) return;
        if (p.source === appWindow.label) return;
        if (p.file_path !== currentFilePath) return;
        if (typeof p.line === 'number') {
            scrollEditorToLine(p.line);
            lastSyncedLine = p.line;
        } else if (typeof p.percent === 'number') {
            const scrollableHeight = editorScrollableHeight();
            if (scrollableHeight <= 0) return;
            isProgrammaticScroll = true;
            editorView.scrollDOM.scrollTop = Math.max(0, p.percent * scrollableHeight);
            lastSyncedPercent = p.percent;
            setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
        }
    });

    // Listen for menu find requests
    await listen(EVENT_MENU_FIND, () => {
        if (!document.hasFocus()) return;
        openFindOverlay();
    });

    await listen(EVENT_MENU_FIND_NEXT, () => {
        if (!document.hasFocus()) return;
        findNext();
    });

    await listen(EVENT_MENU_FIND_PREV, () => {
        if (!document.hasFocus()) return;
        findPrevious();
    });

    await listen(EVENT_MENU_FIND_USE_SELECTION, () => {
        if (!document.hasFocus()) return;
        useSelectionForFindFromEditor();
    });

    await listen(EVENT_MENU_FIND_REPLACE, () => {
        if (!document.hasFocus()) return;
        openFindAndReplace();
    });

    // Format menu listeners (fire only when this editor window has focus)
    await listen(EVENT_MENU_FORMAT_BOLD, () => {
        if (!document.hasFocus()) return;
        cmToggleWrap(editorView, '**', '**');
    });
    await listen(EVENT_MENU_FORMAT_ITALIC, () => {
        if (!document.hasFocus()) return;
        cmToggleWrap(editorView, '*', '*');
    });
    await listen(EVENT_MENU_FORMAT_LINK, () => {
        if (!document.hasFocus()) return;
        cmInsertLink(editorView);
    });
    await listen(EVENT_MENU_FORMAT_STRIKE, () => {
        if (!document.hasFocus()) return;
        cmToggleWrap(editorView, '~~', '~~');
    });

    await listen(EVENT_MENU_COMMAND_PALETTE, () => {
        if (!document.hasFocus()) return;
        openPalette();
    });

    await listen(EVENT_FONT_FAMILY_CHANGED, (event) => {
        const p = event.payload || {};
        applyFontFamily({
            documentId: p.document || undefined,
            editorId: p.editor || undefined,
        });
        if (editorView) editorView.requestMeasure();
    });

    // Listen for theme changes
    await listen(EVENT_THEME_CHANGED, (event) => {
        applyThemeToDocument(event.payload);
    });

    await listen(EVENT_FONT_SIZE_CHANGED, (event) => {
        if (Number(event.payload) === currentFontSize) return;
        applyFontSize(event.payload);
    });

    await listen(EVENT_TOOLBAR_DENSITY_CHANGED, (event) => {
        if (event.payload === currentToolbarDensity) return;
        applyToolbarDensity(event.payload);
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

    const inspectorToggle = document.getElementById('editor-inspector-toggle');
    if (inspectorToggle) {
        inspectorToggle.addEventListener('click', toggleInspector);
    }

    // Use Tauri's onCloseRequested so we can reliably await the async save
    // before allowing the window to close (beforeunload cannot await).
    await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (saveTimeout) {
            clearTimeout(saveTimeout);
            saveTimeout = null;
        }
        if (isDirty) {
            const ok = await saveFile();
            if (!ok) {
                // Save failed (disk full, permission, file replaced): keep the
                // window and the unsaved buffer rather than discarding edits.
                // saveFile already set the "Error saving" badge.
                return;
            }
        }
        await notifyPreviewEditorClosed();
        appWindow.destroy();
    });

  } catch (error) {
    console.error('[CRITICAL ERROR] Editor initialization failed:', error);
  }
});

// --- Find overlay (CM-driven) ---
let findOverlay = null;
let findInput = null;
let replaceInput = null;
let findVisible = false;
let findMatchCase = false;
let findWholeWord = false;
let findReplaceVisible = false;
let findTypeTimer = null;
let currentQuery = null;
let findMatchCount = 0;
let findMatchIndex = -1;
let findCaseBtn = null;
let findWordBtn = null;

function ensureFindOverlay() {
    if (findOverlay) return;
    const slot = document.getElementById('find-bar-slot');
    const els = createFindOverlay(slot);
    findOverlay = els.overlay;
    findInput = els.input;
    findCaseBtn = els.caseBtn;
    findWordBtn = els.wordBtn;

    // Add replace row (hidden until the user requests Find-and-Replace)
    const replaceRow = document.createElement('div');
    replaceRow.className = 'replace-row';
    replaceRow.hidden = true;
    replaceRow.innerHTML = `
        <input id="replace-input" class="find-input replace-input" type="text" placeholder="Replace..." aria-label="Replace with" />
        <button class="find-btn replace-btn-text" id="replace-one" type="button" title="Replace current match">Replace</button>
        <button class="find-btn replace-btn-text" id="replace-all" type="button" title="Replace all matches">All</button>
    `;
    findOverlay.appendChild(replaceRow);
    replaceInput = replaceRow.querySelector('#replace-input');

    findInput.addEventListener('input', () => {
        if (findTypeTimer) clearTimeout(findTypeTimer);
        findTypeTimer = setTimeout(() => runFindFromInput(), FIND_TYPE_DEBOUNCE_MS);
    });
    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) findPrevious(); else findNext();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeFindOverlay();
        } else if (e.key === 'Tab' && !e.shiftKey && findReplaceVisible) {
            e.preventDefault();
            replaceInput.focus();
        }
    });

    // Keep the query's replace text current so replaceNext/replaceAll use it.
    replaceInput.addEventListener('input', () => applySearchQuery());
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

    const toggle = (btn, setter) => {
        const next = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        btn.classList.toggle('active', next);
        setter(next);
        runFindFromInput();
        findInput.focus();
    };
    findCaseBtn.addEventListener('click', () => toggle(findCaseBtn, v => { findMatchCase = v; }));
    findWordBtn.addEventListener('click', () => toggle(findWordBtn, v => { findWholeWord = v; }));

    findOverlay.querySelector('#find-prev').addEventListener('click', findPrevious);
    findOverlay.querySelector('#find-next').addEventListener('click', findNext);
    findOverlay.querySelector('#find-close').addEventListener('click', closeFindOverlay);
    findOverlay.querySelector('#replace-one').addEventListener('click', replaceCurrent);
    findOverlay.querySelector('#replace-all').addEventListener('click', replaceAllMatches);
}

function setReplaceRowVisible(visible) {
    findReplaceVisible = visible;
    const row = findOverlay && findOverlay.querySelector('.replace-row');
    if (row) row.hidden = !visible;
}

/** Push the find/replace inputs into CM's search state (highlights all matches). */
function applySearchQuery() {
    if (!editorView) return;
    currentQuery = new SearchQuery({
        search: findInput ? findInput.value : '',
        caseSensitive: findMatchCase,
        wholeWord: findWholeWord,
        replace: replaceInput ? replaceInput.value : '',
    });
    editorView.dispatch({ effects: setSearchQuery.of(currentQuery) });
    recountMatches();
}

function recountMatches() {
    findMatchCount = 0;
    findMatchIndex = -1;
    if (!editorView || !currentQuery || !currentQuery.search) {
        updateFindCountDisplay();
        return;
    }
    const sel = editorView.state.selection.main;
    const cursor = currentQuery.getCursor(editorView.state);
    let i = 0;
    let item;
    while (!(item = cursor.next()).done) {
        if (item.value.from === sel.from && item.value.to === sel.to) findMatchIndex = i;
        i++;
        if (i >= 10000) break; // cap pathological documents
    }
    findMatchCount = i;
    updateFindCountDisplay();
}

function updateFindCountDisplay() {
    updateFindCount(findOverlay, { length: findMatchCount }, findMatchIndex);
}

function selectFirstMatch() {
    if (!editorView || !currentQuery || !currentQuery.search) return;
    const first = currentQuery.getCursor(editorView.state).next();
    if (first.done) return;
    isProgrammaticScroll = true;
    editorView.dispatch({
        selection: EditorSelection.range(first.value.from, first.value.to),
        effects: EditorView.scrollIntoView(first.value.from, { y: 'center' }),
    });
    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
}

function runFindFromInput() {
    if (!findInput) return;
    applySearchQuery();
    if (findMatchCount > 0) {
        selectFirstMatch();
        recountMatches();
    }
}

// Guard: cmFindNext/cmFindPrevious open CM's own search panel when no valid
// query is set; never call them without one.
function findNext() {
    if (!editorView) return;
    if (!currentQuery || !currentQuery.search) {
        runFindFromInput();
        return;
    }
    isProgrammaticScroll = true;
    cmFindNext(editorView);
    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
    recountMatches();
}

function findPrevious() {
    if (!editorView) return;
    if (!currentQuery || !currentQuery.search) {
        runFindFromInput();
        return;
    }
    isProgrammaticScroll = true;
    cmFindPrevious(editorView);
    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
    recountMatches();
}

function replaceCurrent() {
    if (!editorView || !currentQuery || !currentQuery.search) return;
    cmReplaceNext(editorView);
    recountMatches();
}

function replaceAllMatches() {
    if (!editorView || !currentQuery || !currentQuery.search) return;
    cmReplaceAll(editorView);
    recountMatches();
}

function clearFindState() {
    currentQuery = null;
    findMatchCount = 0;
    findMatchIndex = -1;
    if (editorView) {
        editorView.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
    }
    updateFindCountDisplay();
}

function selectionText() {
    if (!editorView) return '';
    const sel = editorView.state.selection.main;
    return editorView.state.sliceDoc(sel.from, sel.to);
}

function openFindOverlay() {
    ensureFindOverlay();
    setReplaceRowVisible(false);
    findOverlay.classList.add('show');
    findVisible = true;
    const sel = selectionText();
    if (sel) {
        findInput.value = sel;
        runFindFromInput();
    }
    findInput.focus();
    findInput.select();
}

function openFindAndReplace() {
    ensureFindOverlay();
    setReplaceRowVisible(true);
    findOverlay.classList.add('show');
    findVisible = true;
    const sel = selectionText();
    if (sel && !findInput.value) {
        findInput.value = sel;
        runFindFromInput();
    }
    findInput.focus();
    findInput.select();
}

function useSelectionForFindFromEditor() {
    const sel = selectionText();
    if (!sel) return;
    ensureFindOverlay();
    findInput.value = sel;
    applySearchQuery();
    // Stay in the document unless the bar is already visible.
    if (findVisible) {
        findInput.focus();
        findInput.select();
    }
}

function toggleFindOverlay() {
    if (findVisible) closeFindOverlay(); else openFindOverlay();
}

function closeFindOverlay() {
    if (!findOverlay) return;
    findOverlay.classList.remove('show');
    findVisible = false;
    if (findTypeTimer) { clearTimeout(findTypeTimer); findTypeTimer = null; }
    clearFindState();
    setReplaceRowVisible(false);
    if (replaceInput) replaceInput.value = '';
    if (editorView) editorView.focus();
}

// --- Command palette (editor) ---
function buildPaletteActions() {
    const actions = [
        { id: 'save',          label: 'Save',                      hint: '⌘S',     run: () => saveFile() },
        { id: 'close',         label: 'Close Window',              hint: '⌘W',     run: () => appWindow.close() },
        { id: 'find',          label: 'Find…',                     hint: '⌘F',     run: () => openFindOverlay() },
        { id: 'find-next',     label: 'Find Next',                 hint: '⌘G',     run: () => findNext() },
        { id: 'find-prev',     label: 'Find Previous',             hint: '⇧⌘G',    run: () => findPrevious() },
        { id: 'replace',       label: 'Find and Replace…',         hint: '⌘⌥F',    run: () => openFindAndReplace() },
        { id: 'use-sel',       label: 'Use Selection for Find',    hint: '⌘E',     run: () => useSelectionForFindFromEditor() },
        { id: 'bold',          label: 'Bold',                      hint: '⌘B',     run: () => cmToggleWrap(editorView, '**', '**') },
        { id: 'italic',        label: 'Italic',                    hint: '⌘I',     run: () => cmToggleWrap(editorView, '*', '*') },
        { id: 'link',          label: 'Insert Link…',              hint: '⌘⇧U',    run: () => cmInsertLink(editorView) },
        { id: 'strike',        label: 'Strikethrough',             hint: '⌘⇧K',    run: () => cmToggleWrap(editorView, '~~', '~~') },
        { id: 'inspector',     label: 'Toggle Inspector',          hint: '⌘⇧I',    run: () => toggleInspector() },
        { id: 'line-nums',     label: 'Toggle Line Numbers',                       run: () => toggleLineNumbers() },
        { id: 'word-wrap',     label: 'Toggle Word Wrap',                          run: () => toggleWordWrap() },
        { id: 'fold-all',      label: 'Fold All Headings',                         run: () => { if (editorView) foldAll(editorView); } },
        { id: 'unfold-all',    label: 'Unfold All',                                run: () => { if (editorView) unfoldAll(editorView); } },
        { id: 'new-window',    label: 'New Window',                hint: '⌘⇧N',    run: () => invoke('create_new_window_command').catch(console.error) },
        { id: 'new-file',      label: 'New File…',                 hint: '⌘N',     run: () => invoke('create_new_markdown_file').catch(console.error) },
        { id: 'theme-light',   label: 'Theme: Light',                              run: () => applyThemeBroadcast('light') },
        { id: 'theme-dark',    label: 'Theme: Dark',                               run: () => applyThemeBroadcast('dark') },
        { id: 'theme-drac',    label: 'Theme: Drac',                               run: () => applyThemeBroadcast('drac') },
        { id: 'font-size-inc', label: 'Text Size: Increase',                       run: () => changeFontSize(1) },
        { id: 'font-size-dec', label: 'Text Size: Decrease',                       run: () => changeFontSize(-1) },
    ];
    return actions;
}

function ensureCommandPalette() {
    if (commandPalette) return commandPalette;
    commandPalette = createCommandPalette(document.body, buildPaletteActions);
    return commandPalette;
}

function openPalette() {
    ensureCommandPalette().open();
}

function applyThemeBroadcast(theme) {
    applyThemeToDocument(theme);
    invoke('broadcast_theme_change', { theme })
        .catch(err => console.error('Failed to broadcast theme change:', err));
    invoke('save_preference_key', { key: 'theme', value: theme })
        .catch(err => console.error('Failed to save theme preference:', err));
}
