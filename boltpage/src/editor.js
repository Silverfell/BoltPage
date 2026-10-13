import {
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    EDITOR_FONT_SIZE_OFFSET,
    setBadgeState,
    applyThemeToDocument,
    applyFontFamily,
    setupKeyboardShortcuts,
    setupChordShortcuts,
    createCommandPalette,
    isUrlLike,
    kindFromPath,
} from './shared.js';
import {
    EVENT_FILE_CHANGED,
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
    KIND_TXT,
} from './constants.js';
import { createScrollSync } from './scroll-sync.js';
import { createDocumentSession } from './document-session.js';
import { createAppearance } from './appearance.js';
import { createFindBar } from './find-bar.js';
import { createCommands } from './commands.js';
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
    vim,
} from '/assets/vendor/codemirror/codemirror.min.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();
let currentFilePath = null;
let currentFileKind = KIND_MARKDOWN;
let editorView = null;
// Owns load, dirty state, saves and external reloads; null without a file.
let session = null;
let previewWindow = null;
let wordWrapEnabled = false;
let showLineNumbers = true;
let closeEventSent = false;
let inspectorRafId = null;
let commandPalette = null;
// On-type preview: debounce + size guard for buffer broadcasts.
const BUFFER_BROADCAST_DEBOUNCE_MS = 150;
const BUFFER_BROADCAST_MAX_CHARS = 2_000_000;
let bufferBroadcastTimer = null;
let bufferSizeWarned = false;

// CM compartments for the togglable bits.
const gutterCompartment = new Compartment();
const wrapCompartment = new Compartment();
const vimCompartment = new Compartment();
let vimModeEnabled = false;

// === Editor view =================================================

function buildEditorExtensions() {
    return [
        // vim() must precede every other keymap or its Normal-mode bindings
        // lose to them (per @replit/codemirror-vim docs).
        vimCompartment.of(vimModeEnabled ? vim() : []),
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
        if (session && session.edited()) scheduleBufferBroadcast();
        findBar.contentChanged();
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
    editorView.scrollDOM.addEventListener('scroll', scrollSync.onScroll);
}

/**
 * Buffer writes the document session asks for. 'format' is the JSON rewrite
 * on save: a full-document change, so CM maps the selection through it and
 * the caret stays put. 'reload' is fresh disk content: it replaces the editor
 * state, which intentionally drops undo history (undoing across an external
 * reload would resurrect a stale file), preserving caret and scroll
 * best-effort. The new state has no search query, so the find bar's is put
 * back and counted again.
 */
function setBufferText(text, why) {
    if (why === 'format') {
        editorView.dispatch({
            changes: { from: 0, to: editorView.state.doc.length, insert: text },
        });
        return;
    }
    const prevHead = editorView.state.selection.main.head;
    const prevScroll = editorView.scrollDOM.scrollTop;
    scrollSync.programmatic(() => {
        editorView.setState(EditorState.create({ doc: text, extensions: buildEditorExtensions() }));
        const pos = Math.min(prevHead, editorView.state.doc.length);
        editorView.dispatch({ selection: { anchor: pos } });
        editorView.scrollDOM.scrollTop = prevScroll;
    });
    if (currentQuery) editorView.dispatch({ effects: setSearchQuery.of(currentQuery) });
    findBar.contentChanged();
    scheduleInspectorUpdate();
}

// === Chrome: font size, density, inspector ======================

function updateFontSizeControls() {
    const indicator = document.getElementById('editor-font-size-indicator');
    const decreaseBtn = document.getElementById('editor-font-size-decrease-btn');
    const increaseBtn = document.getElementById('editor-font-size-increase-btn');
    const fontSize = appearance.get('fontSize');
    if (indicator) indicator.textContent = `${fontSize}px`;
    if (decreaseBtn) decreaseBtn.disabled = fontSize <= MIN_FONT_SIZE;
    if (increaseBtn) increaseBtn.disabled = fontSize >= MAX_FONT_SIZE;
}

function editorFontSizePx(fontSize) {
    return Math.max(12, fontSize - EDITOR_FONT_SIZE_OFFSET);
}

// Theme, font size, fonts and toolbar density, synced across windows (see
// appearance.js). Each effect is what this window does to show a value.
const appearance = createAppearance({ invoke, listen, effects: {
    theme: applyThemeToDocument,
    fontSize: (fontSize) => {
        const anchorLine = editorView && currentFilePath ? getTopLineForEditor() : null;

        document.documentElement.style.setProperty('--editor-font-size', `${editorFontSizePx(fontSize)}px`);
        document.documentElement.style.setProperty('--editor-gutter-font-size', `${Math.max(11, editorFontSizePx(fontSize) - 1)}px`);
        if (editorView) editorView.requestMeasure();

        updateFontSizeControls();

        if (typeof anchorLine === 'number') {
            requestAnimationFrame(() => scrollSync.programmatic(() => scrollEditorToLine(anchorLine)));
        }
    },
    toolbarDensity: (density) => {
        document.documentElement.dataset.toolbarDensity = density;
    },
    documentFont: (id) => {
        applyFontFamily({ documentId: id });
        if (editorView) editorView.requestMeasure();
    },
    editorFont: (id) => {
        applyFontFamily({ editorId: id });
        if (editorView) editorView.requestMeasure();
    },
} });

function changeFontSize(delta) {
    appearance.set('fontSize', appearance.get('fontSize') + delta);
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

// --- Readability (prose files only) ---
const READING_WPM = 220;
// REASON: the syllable pass is O(doc) and runs on every rAF-coalesced
// inspector update; beyond this size show "–" instead of stuttering typing.
const MAX_READABILITY_CHARS = 500_000;
// Below this many words the score swings wildly; not worth showing.
const MIN_READABILITY_WORDS = 20;

function estimateSyllables(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, '');
    if (!w) return 0;
    if (w.length <= 3) return 1;
    const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
    return Math.max(1, groups ? groups.length : 1);
}

/** Flesch-Kincaid grade level over raw text (markdown syntax counts as prose;
 *  the score is a gauge, not a citation). */
function fleschKincaidGrade(text, words) {
    if (!words.length) return null;
    const sentences = (text.match(/[.!?]+(\s|$)/g) || []).length || 1;
    let syllables = 0;
    for (const w of words) syllables += estimateSyllables(w);
    const grade = 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
    return Math.max(0, grade);
}

function updateInspector() {
    const inspectorEl = document.getElementById('editor-inspector');
    if (!inspectorEl || inspectorEl.hasAttribute('hidden')) return;
    if (!editorView) return;
    const state = editorView.state;
    const text = state.doc.toString();
    const wordList = text.trim().match(/\S+/g) || [];
    const words = wordList.length;
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
    if (elEol) elEol.textContent = session ? session.eol : 'LF';

    // Reading time and Flesch-Kincaid grade only make sense for prose.
    const isProse = currentFileKind === KIND_MARKDOWN || currentFileKind === KIND_TXT;
    const elReading = el('inspector-reading');
    const elGrade = el('inspector-grade');
    const elReadingLabel = el('inspector-reading-label');
    const elGradeLabel = el('inspector-grade-label');
    for (const n of [elReading, elReadingLabel, elGrade, elGradeLabel]) {
        if (n) n.hidden = !isProse;
    }
    if (isProse) {
        if (elReading) {
            elReading.textContent = words === 0
                ? '–'
                : `${Math.max(1, Math.round(words / READING_WPM))} min`;
        }
        if (elGrade) {
            if (words < MIN_READABILITY_WORDS || chars > MAX_READABILITY_CHARS) {
                elGrade.textContent = '–';
            } else {
                const grade = fleschKincaidGrade(text, wordList);
                elGrade.textContent = grade === null ? '–' : grade.toFixed(1);
            }
        }
    }
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

function toggleVimMode() {
    vimModeEnabled = !vimModeEnabled;
    if (editorView) {
        editorView.dispatch({
            effects: vimCompartment.reconfigure(vimModeEnabled ? vim() : []),
        });
        editorView.focus();
    }
    updateStatus(vimModeEnabled ? 'Vim mode on' : 'Vim mode off');
    invoke('save_preference_key', { key: 'editor_vim_mode', value: vimModeEnabled })
        .catch(err => console.error('Failed to save editor_vim_mode preference:', err));
}

// === Status, buffer broadcast ====================================

function updateStatus(status) {
    const statusBadge = document.getElementById('editor-status-badge');
    let tone = null;
    if (/saved|loaded/i.test(status)) tone = 'success';
    if (/modified/i.test(status)) tone = 'warning';
    if (/changed/i.test(status)) tone = 'warning';
    if (/error/i.test(status)) tone = 'warning';
    setBadgeState(statusBadge, status, tone, false);
}

// Resolves to 'persisted' when the buffer is on disk (or there is no file),
// 'failed' when the write failed. Callers that close the window must honor it.
function saveEditor() {
    return session ? session.save() : Promise.resolve('persisted');
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

/** Read a pasted image, save it to assets/ beside the doc, insert the link. */
async function insertPastedImage(view, blob) {
    try {
        const buf = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
        }
        const rel = await invoke('save_clipboard_image', {
            docPath: currentFilePath,
            dataB64: btoa(binary),
        });
        const range = view.state.selection.main;
        view.dispatch({
            changes: { from: range.from, to: range.to, insert: `![](${rel})` },
            // Caret lands in the alt-text slot: ![|](assets/…)
            selection: EditorSelection.cursor(range.from + 2),
        });
        view.focus();
        updateStatus(`Image saved to ${rel}`);
    } catch (err) {
        console.error('Failed to paste image:', err);
        updateStatus('Error pasting image');
    }
}

/** Paste image → save to assets/; paste URL over a non-empty selection → auto-link. */
function handleEditorPaste(e, view) {
    if (currentFileKind === KIND_MARKDOWN && currentFilePath && e.clipboardData) {
        const pastableTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        for (const item of e.clipboardData.items) {
            if (item.kind === 'file' && pastableTypes.includes(item.type)) {
                const blob = item.getAsFile();
                if (blob) {
                    e.preventDefault();
                    insertPastedImage(view, blob);
                    return true;
                }
            }
        }
    }
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
    if (!editorView) return false;
    const doc = editorView.state.doc;
    const n = Math.max(1, Math.min(doc.lines, Math.round(line)));
    editorView.dispatch({
        effects: EditorView.scrollIntoView(doc.line(n).from, { y: 'start' }),
    });
}

const scrollSync = createScrollSync({
    adapter: {
        label: appWindow.label,
        filePath: () => currentFilePath,
        kind: () => currentFileKind,
        topLine: getTopLineForEditor,
        topPercent() {
            const scrollableHeight = editorScrollableHeight();
            // Content fits in viewport, no scroll sync needed
            if (scrollableHeight <= 0) return null;
            return Math.max(0, Math.min(1, editorView.scrollDOM.scrollTop / scrollableHeight));
        },
        scrollToLine: scrollEditorToLine,
        scrollToPercent(percent) {
            if (!editorView) return false;
            const scrollableHeight = editorScrollableHeight();
            if (scrollableHeight <= 0) return false;
            editorView.scrollDOM.scrollTop = Math.max(0, percent * scrollableHeight);
        },
    },
    emit: (payload) => invoke('broadcast_scroll_sync', { payload }).catch(() => {}),
    listen,
    clock: window,
});

// === Init ========================================================

async function initialize() {
    // Get file path from initialization script
    currentFilePath = window.__INITIAL_FILE_PATH__;
    previewWindow = window.__PREVIEW_WINDOW__;
    currentFileKind = kindFromPath(currentFilePath) || KIND_MARKDOWN;

    // Load preferences before the view exists so the first paint uses the
    // right gutter/wrap/typography configuration.
    const prefs = await appearance.start();
    if (prefs) {
        wordWrapEnabled = prefs.word_wrap === true;
        showLineNumbers = prefs.show_line_numbers !== false;
        vimModeEnabled = prefs.editor_vim_mode === true;
        applyInspectorVisibility(prefs.editor_inspector_visible === true);
    }

    // Load file content into a fresh editor state.
    let initialDoc = '';
    let loadStatus = 'Ready';
    if (currentFilePath) {
        session = createDocumentSession({
            kind: currentFileKind,
            read: () => invoke('read_file', { path: currentFilePath }),
            write: (content) => invoke('write_file', { path: currentFilePath, content }),
            formatJson: (content) => invoke('format_json_pretty', { content }),
            buffer: {
                getText: () => editorView.state.doc.toString(),
                setText: setBufferText,
            },
            clock: window,
            onStatus: updateStatus,
            // Notify preview window to refresh (fire-and-forget; don't steal focus)
            onWrite: () => {
                if (previewWindow) invoke('refresh_preview', { window: previewWindow }).catch(() => {});
            },
        });
        try {
            initialDoc = await session.load();
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
            session.externalChange();
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

    setupKeyboardShortcuts(commands.shortcuts);
    setupChordShortcuts(commands.chords);

    // Listen for scroll sync events
    await scrollSync.listening;

    // Menu events that run commands (only while this editor window has focus)
    await commands.listenMenu(listen);

    const findBtn = document.getElementById('find-btn');
    if (findBtn) findBtn.addEventListener('click', findBar.toggle);

    const inspectorToggle = document.getElementById('editor-inspector-toggle');
    if (inspectorToggle) {
        inspectorToggle.addEventListener('click', toggleInspector);
    }

    // Use Tauri's onCloseRequested so we can reliably await the async save
    // before allowing the window to close (beforeunload cannot await).
    await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        // Save failed (disk full, permission, file replaced): keep the window
        // and the unsaved buffer rather than discarding edits. The session
        // already set the "Error saving" badge.
        // An edit typed while the preview is being notified makes the
        // session dirty again, so save until nothing is left to write.
        do {
            if ((await saveEditor()) !== 'persisted') return;
            await notifyPreviewEditorClosed();
        } while (session && session.dirty);
        appWindow.destroy();
    });

  } catch (error) {
    console.error('[CRITICAL ERROR] Editor initialization failed:', error);
  }
});

// --- Find bar (CM-driven) ---
let currentQuery = null;

/** Count the matches and locate the one equal to the main selection (-1 when none). */
function recountMatches() {
    let index = -1;
    if (!currentQuery) return { count: 0, index };
    const sel = editorView.state.selection.main;
    const cursor = currentQuery.getCursor(editorView.state);
    let i = 0;
    let item;
    while (!(item = cursor.next()).done) {
        if (item.value.from === sel.from && item.value.to === sel.to) index = i;
        i++;
        if (i >= 10000) break; // cap pathological documents
    }
    return { count: i, index };
}

function selectFirstMatch() {
    const first = currentQuery.getCursor(editorView.state).next();
    if (first.done) return;
    scrollSync.programmatic(() => editorView.dispatch({
        selection: EditorSelection.range(first.value.from, first.value.to),
        effects: EditorView.scrollIntoView(first.value.from, { y: 'center' }),
    }));
}

/** Put the replace text into CM's search state, where replaceNext/replaceAll read it. */
function setReplaceText(text) {
    currentQuery = new SearchQuery({
        search: currentQuery.search,
        caseSensitive: currentQuery.caseSensitive,
        wholeWord: currentQuery.wholeWord,
        replace: text,
    });
    editorView.dispatch({ effects: setSearchQuery.of(currentQuery) });
}

function selectionText() {
    if (!editorView) return '';
    const sel = editorView.state.selection.main;
    return editorView.state.sliceDoc(sel.from, sel.to);
}

const findBar = createFindBar({
    document,
    parent: document.getElementById('find-bar-slot'),
    adapter: {
        available: () => !!editorView,
        search(query, { matchCase, wholeWord, keepPosition }) {
            const next = new SearchQuery({
                search: query,
                caseSensitive: matchCase,
                wholeWord,
                replace: currentQuery ? currentQuery.replace : '',
            });
            // The re-run after an edit arrives inside CM's update, where a
            // dispatch is rejected; the query is unchanged then, so skip it.
            if (!(keepPosition && currentQuery && next.eq(currentQuery))) {
                currentQuery = next;
                editorView.dispatch({ effects: setSearchQuery.of(currentQuery) });
            }
            if (!keepPosition) selectFirstMatch();
            return recountMatches().count;
        },
        // cmFindNext/cmFindPrevious open CM's own search panel when no valid
        // query is set; the bar only steps while a query has matches.
        step(direction) {
            if (direction === 1) scrollSync.programmatic(() => cmFindNext(editorView));
            else if (direction === -1) scrollSync.programmatic(() => cmFindPrevious(editorView));
            return recountMatches().index;
        },
        clear() {
            currentQuery = null;
            editorView.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: '' })) });
        },
        replace(text) {
            setReplaceText(text);
            scrollSync.programmatic(() => cmReplaceNext(editorView));
            return recountMatches().count;
        },
        replaceAll(text) {
            setReplaceText(text);
            scrollSync.programmatic(() => cmReplaceAll(editorView));
            return recountMatches().count;
        },
        selectionText,
        focus: () => editorView.focus(),
    },
});

// --- Commands (editor): keys, menu events and palette entries ---
// Palette order is table order. Cmd+K is reserved as the chord prefix
// (Cmd+K Cmd+P); Insert Link binds to Cmd+Shift+U to avoid the 400ms
// chord-timeout latency.
const commands = createCommands([
    { id: 'save',      keys: 'Mod+S',                                           label: 'Save',                   action: () => saveEditor() },
    // onCloseRequested handles the save
    { id: 'close',     keys: 'Mod+W',       menu: EVENT_MENU_CLOSE,              label: 'Close Window',           action: () => appWindow.close() },
    { id: 'find',      keys: 'Mod+F',       menu: EVENT_MENU_FIND,               label: 'Find…',                  action: () => findBar.open() },
    { id: 'find-next', keys: 'Mod+G',       menu: EVENT_MENU_FIND_NEXT,          label: 'Find Next',              action: () => findBar.next() },
    { id: 'find-prev', keys: 'Mod+Shift+G', menu: EVENT_MENU_FIND_PREV,          label: 'Find Previous',          action: () => findBar.previous() },
    { id: 'replace',   keys: 'Mod+Alt+F',   menu: EVENT_MENU_FIND_REPLACE,       label: 'Find and Replace…',      action: () => findBar.openReplace() },
    { id: 'use-sel',   keys: 'Mod+E',       menu: EVENT_MENU_FIND_USE_SELECTION, label: 'Use Selection for Find', action: () => findBar.useSelection() },
    { id: 'bold',      keys: 'Mod+B',       menu: EVENT_MENU_FORMAT_BOLD,        label: 'Bold',                   action: () => cmToggleWrap(editorView, '**', '**') },
    { id: 'italic',    keys: 'Mod+I',       menu: EVENT_MENU_FORMAT_ITALIC,      label: 'Italic',                 action: () => cmToggleWrap(editorView, '*', '*') },
    { id: 'link',      keys: 'Mod+Shift+U', menu: EVENT_MENU_FORMAT_LINK,        label: 'Insert Link…',           action: () => cmInsertLink(editorView) },
    { id: 'strike',    keys: 'Mod+Shift+K', menu: EVENT_MENU_FORMAT_STRIKE,      label: 'Strikethrough',          action: () => cmToggleWrap(editorView, '~~', '~~') },
    { id: 'inspector', keys: 'Mod+Shift+I',                                      label: 'Toggle Inspector',       action: () => toggleInspector() },
    { id: 'line-nums',     label: 'Toggle Line Numbers', action: () => toggleLineNumbers() },
    { id: 'word-wrap',     label: 'Toggle Word Wrap',    action: () => toggleWordWrap() },
    { id: 'vim-mode',      label: () => `Vim Mode: ${vimModeEnabled ? 'Off' : 'On'}`, action: () => toggleVimMode() },
    { id: 'fold-all',      label: 'Fold All Headings',   action: () => { if (editorView) foldAll(editorView); } },
    { id: 'unfold-all',    label: 'Unfold All',          action: () => { if (editorView) unfoldAll(editorView); } },
    // The native menu accelerators serve these two bindings.
    { id: 'new-window', keys: 'Mod+Shift+N', native: true, label: 'New Window', action: () => invoke('create_new_window_command').catch(console.error) },
    { id: 'new-file',   keys: 'Mod+N',       native: true, label: 'New File…',  action: () => invoke('create_new_markdown_file').catch(console.error) },
    { id: 'theme-light',   label: 'Theme: Light',        action: () => appearance.set('theme', 'light') },
    { id: 'theme-dark',    label: 'Theme: Dark',         action: () => appearance.set('theme', 'dark') },
    { id: 'theme-drac',    label: 'Theme: Drac',         action: () => appearance.set('theme', 'drac') },
    { id: 'font-size-inc', label: 'Text Size: Increase', action: () => changeFontSize(1) },
    { id: 'font-size-dec', label: 'Text Size: Decrease', action: () => changeFontSize(-1) },
    // Not in the palette.
    { id: 'print',   menu: EVENT_MENU_PRINT, action: () => window.print() },
    { id: 'palette', keys: 'Mod+K Mod+P', menu: EVENT_MENU_COMMAND_PALETTE, action: () => openPalette() },
], { mac: true, hasFocus: () => document.hasFocus() });

function ensureCommandPalette() {
    if (commandPalette) return commandPalette;
    commandPalette = createCommandPalette(document.body, commands.paletteActions);
    return commandPalette;
}

function openPalette() {
    ensureCommandPalette().open();
}
