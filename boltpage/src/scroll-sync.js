// Scroll sync between the windows showing one file (preview and editor).
//
// A window builds one instance at boot and routes all of its scrolling
// through it:
//
//   const sync = createScrollSync({ adapter, emit, listen, clock });
//   scroller.addEventListener('scroll', sync.onScroll);
//   sync.programmatic(() => { /* any scroll the window makes itself */ });
//   const anchor = sync.top();  /* ...re-render... */  sync.scrollTo(anchor);
//
// adapter - the window's side of the contract:
//   label              own window label
//   filePath()         current file path, or null when no file is open
//   kind()             KIND_* of the current document, or null when it is not
//                      synced (the preview's PDF mode)
//   topLine()          1-based line at the top, or null when unknown
//   topPercent()       scroll fraction 0..1, or null when nothing can scroll
//   scrollToLine(n)    both scroll calls return false when they did not scroll
//   scrollToPercent(p)
// emit(payload)        broadcasts to the other windows; owns its own failures
// listen(event, cb)    Tauri-shaped: cb receives { payload }
// clock                { setTimeout, clearTimeout }
//
// JSON, YAML and text documents sync by line, everything else by percent.

import {
    EVENT_SCROLL_SYNC,
    KIND_MARKDOWN,
    KIND_JSON,
    KIND_YAML,
    KIND_TXT,
} from './constants.js';

const SCROLL_SYNC_DEBOUNCE_MS = 50;
const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 100;
const MIN_SCROLL_DELTA_LINES = 0.5;
const MIN_SCROLL_DELTA_PERCENT = 0.01;

function isLineKind(kind) {
    return kind === KIND_JSON || kind === KIND_YAML || kind === KIND_TXT;
}

export function createScrollSync({ adapter, emit, listen, clock }) {
    // Called bare: the webview's timer functions reject a foreign `this`.
    const { setTimeout, clearTimeout } = clock;
    // Non-null while scroll events are the echo of a programmatic scroll.
    let guardTimer = null;
    let debounceTimer = null;
    // Last synced position, sent or received, to filter micro-scrolls
    let lastSyncedLine = null;
    let lastSyncedPercent = null;

    /** Run a scroll the window makes itself, so its scroll events are not broadcast. */
    function programmatic(scroll) {
        if (guardTimer !== null) clearTimeout(guardTimer);
        guardTimer = setTimeout(() => { guardTimer = null; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
        return scroll();
    }

    /** Top position as { line } or { percent } by document kind, or null when unknown. */
    function top() {
        if (isLineKind(adapter.kind())) {
            const line = adapter.topLine();
            return line === null ? null : { line };
        }
        const percent = adapter.topPercent();
        return percent === null ? null : { percent };
    }

    /** Scroll to a position from top(). Returns false when nothing scrolled. */
    function scrollTo(position) {
        if (!position) return false;
        return programmatic(() => (typeof position.line === 'number'
            ? adapter.scrollToLine(position.line)
            : adapter.scrollToPercent(position.percent)));
    }

    function send() {
        debounceTimer = null;
        const position = top();
        if (!position) return;
        const byLine = typeof position.line === 'number';
        if (byLine) {
            if (lastSyncedLine !== null && Math.abs(position.line - lastSyncedLine) < MIN_SCROLL_DELTA_LINES) return;
            lastSyncedLine = position.line;
        } else {
            if (lastSyncedPercent !== null && Math.abs(position.percent - lastSyncedPercent) < MIN_SCROLL_DELTA_PERCENT) return;
            lastSyncedPercent = position.percent;
        }
        emit({
            source: adapter.label,
            file_path: adapter.filePath(),
            kind: byLine ? adapter.kind() : KIND_MARKDOWN,
            line: byLine ? position.line : null,
            percent: byLine ? null : position.percent,
        });
    }

    /** The window's scroll listener. */
    function onScroll() {
        if (guardTimer !== null || !adapter.filePath() || !adapter.kind()) return;
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(send, SCROLL_SYNC_DEBOUNCE_MS);
    }

    function receive(payload) {
        const filePath = adapter.filePath();
        if (!filePath) return;
        if (payload.source === adapter.label) return; // ignore self
        if (payload.file_path !== filePath) return;
        if (isLineKind(adapter.kind()) && typeof payload.line === 'number') {
            if (scrollTo({ line: payload.line }) !== false) lastSyncedLine = payload.line;
        } else if (typeof payload.percent === 'number') {
            if (scrollTo({ percent: payload.percent }) !== false) lastSyncedPercent = payload.percent;
        }
    }

    const listening = listen(EVENT_SCROLL_SYNC, (event) => receive(event.payload || {}));

    return { onScroll, programmatic, top, scrollTo, listening };
}
