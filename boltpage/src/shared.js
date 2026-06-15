// Shared constants and utilities for preview (main.js) and editor (editor.js)

import {
    KIND_JSON,
    KIND_YAML,
    KIND_TXT,
} from './constants.js';

// Scroll sync configuration
export const SCROLL_SYNC_DEBOUNCE_MS = 50;
export const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 100;
export const MIN_SCROLL_DELTA_LINES = 0.5;
export const MIN_SCROLL_DELTA_PERCENT = 0.01;
export const LINE_HEIGHT_FALLBACK_MULTIPLIER = 1.4;

// Font size boundaries (shared between preview and editor windows)
export const DEFAULT_FONT_SIZE = 18;
export const MIN_FONT_SIZE = 14;
export const MAX_FONT_SIZE = 24;

// Editor textarea font is this many px smaller than the synced preview font size
export const EDITOR_FONT_SIZE_OFFSET = 4;

// Debounce window for find-as-you-type
export const FIND_TYPE_DEBOUNCE_MS = 80;

export function parsePx(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

export function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function baseNameFromPath(filePath) {
    if (!filePath) return 'No Document Loaded';
    return String(filePath).split(/[/\\]/).pop() || filePath;
}

export function directoryFromPath(filePath) {
    if (!filePath) return '';
    const normalized = String(filePath).replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    return idx > 0 ? normalized.slice(0, idx) : normalized;
}

export function kindLabel(kind) {
    switch (kind) {
        case 'pdf': return 'PDF';
        case KIND_JSON: return 'JSON';
        case KIND_YAML: return 'YAML';
        case KIND_TXT: return 'Text';
        default: return 'Markdown';
    }
}

export function clampFontSize(fontSize) {
    const parsed = Number.parseInt(fontSize, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_FONT_SIZE;
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parsed));
}

export function setBadgeState(element, text, tone = null, hidden = false) {
    if (!element) return;
    element.hidden = hidden;
    if (hidden) return;
    element.textContent = text;
    element.classList.remove('badge-tone-accent', 'badge-tone-success', 'badge-tone-warning');
    if (tone) {
        element.classList.add(`badge-tone-${tone}`);
    }
}

export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a RegExp for find queries honoring the match-case and whole-word toggles.
 * Returns null for an empty/whitespace-only query.
 */
export function buildFindRegex(query, { matchCase = false, wholeWord = false } = {}) {
    if (!query || !query.trim()) return null;
    let pattern = escapeRegex(query);
    if (wholeWord) {
        pattern = `(?:^|\\W)(${pattern})(?=$|\\W)`;
    }
    const flags = matchCase ? 'gd' : 'gid';
    try {
        return new RegExp(pattern, flags);
    } catch (_) {
        return null;
    }
}

/**
 * Run a regex produced by buildFindRegex across a string and return
 * [{start, end}, ...]. Correctly locates the captured word even when
 * whole-word mode adds a non-word-character lookbehind surrogate.
 */
export function collectFindMatches(text, regex) {
    if (!text || !regex) return [];
    const results = [];
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
        let start;
        let end;
        if (m.length > 1 && m.indices && m.indices[1]) {
            start = m.indices[1][0];
            end = m.indices[1][1];
        } else if (m.indices && m.indices[0]) {
            start = m.indices[0][0];
            end = m.indices[0][1];
        } else {
            start = m.index;
            end = m.index + m[0].length;
        }
        results.push({ start, end });
        if (regex.lastIndex <= start) regex.lastIndex = start + 1;
        if (end === start) regex.lastIndex = start + 1;
    }
    return results;
}

/**
 * Creates the find overlay DOM and appends it to the given parent.
 * Includes match-case and whole-word toggles.
 * Returns { overlay, input, caseBtn, wordBtn } so the caller can wire events.
 */
export function createFindOverlay(parent = document.body) {
    const overlay = document.createElement('div');
    overlay.className = 'find-overlay';
    overlay.innerHTML = `
        <input id="find-input" class="find-input" type="text" placeholder="Find..." aria-label="Find" />
        <span class="find-count" id="find-count"></span>
        <button class="find-btn find-toggle" id="find-case" type="button" title="Match case" aria-label="Match case" aria-pressed="false">Aa</button>
        <button class="find-btn find-toggle" id="find-word" type="button" title="Whole word" aria-label="Whole word" aria-pressed="false">\u201C\u201D</button>
        <button class="find-btn" id="find-prev" type="button" title="Previous match (Shift+Enter)" aria-label="Previous match">&#8593;</button>
        <button class="find-btn" id="find-next" type="button" title="Next match (Enter)" aria-label="Next match">&#8595;</button>
        <button class="find-btn" id="find-close" type="button" title="Close (Esc)" aria-label="Close find">&#10005;</button>
    `;
    (parent || document.body).appendChild(overlay);
    return {
        overlay,
        input: overlay.querySelector('#find-input'),
        caseBtn: overlay.querySelector('#find-case'),
        wordBtn: overlay.querySelector('#find-word'),
    };
}

export function updateFindCount(overlay, results, currentIndex) {
    const countEl = overlay?.querySelector('#find-count');
    if (!countEl) return;
    if (results.length === 0) {
        countEl.textContent = overlay?.querySelector('#find-input')?.value ? '0/0' : '';
    } else {
        countEl.textContent = `${currentIndex + 1}/${results.length}`;
    }
}

/**
 * Calculate the next find result index.
 * direction: 1 for next, -1 for previous
 */
export function nextFindIndex(currentIndex, totalResults, direction) {
    if (totalResults === 0) return -1;
    if (direction === 1) {
        return (currentIndex + 1) % totalResults;
    }
    return currentIndex <= 0 ? totalResults - 1 : currentIndex - 1;
}

export function applyThemeToDocument(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}

// === Font presets ===============================================

export const DEFAULT_DOCUMENT_FONT_ID = 'serif-iowan';
export const DEFAULT_EDITOR_FONT_ID = 'mono-plex';

export const DOCUMENT_FONT_PRESETS = [
    { id: 'serif-iowan', label: 'Serif (Iowan)',
      stack: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif' },
    { id: 'sans-system', label: 'Sans (SF Pro)',
      stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "Segoe UI", system-ui, sans-serif' },
    { id: 'mono-plex', label: 'Mono (IBM Plex)',
      stack: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace' },
];

export const EDITOR_FONT_PRESETS = [
    { id: 'mono-plex', label: 'IBM Plex',
      stack: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace' },
    { id: 'mono-jetbrains', label: 'JetBrains',
      stack: '"JetBrains Mono", "IBM Plex Mono", Consolas, monospace' },
    { id: 'mono-sf', label: 'SF Mono',
      stack: '"SF Mono", "SFMono-Regular", Menlo, Consolas, monospace' },
];

export function resolveFontStack(kind, id) {
    const list = kind === 'editor' ? EDITOR_FONT_PRESETS : DOCUMENT_FONT_PRESETS;
    const fallback = kind === 'editor' ? DEFAULT_EDITOR_FONT_ID : DEFAULT_DOCUMENT_FONT_ID;
    const hit = list.find(p => p.id === id) || list.find(p => p.id === fallback) || list[0];
    return hit.stack;
}

/**
 * Apply font family preferences by writing CSS custom properties.
 * When a given id is null/undefined, the corresponding property is left unchanged.
 */
export function applyFontFamily({ documentId, editorId } = {}) {
    const root = document.documentElement;
    if (documentId) {
        root.style.setProperty('--document-font-family', resolveFontStack('document', documentId));
    }
    if (editorId) {
        root.style.setProperty('--editor-font-family', resolveFontStack('editor', editorId));
    }
}

// === Paste URL over selection ===================================

export function isUrlLike(s) {
    if (!s) return false;
    return /^(https?|ftp):\/\/\S+$/i.test(String(s).trim());
}

// Markdown format helpers (toggle-wrap, insert-link, paste-URL) moved into
// editor.js as CodeMirror commands when the editor switched off <textarea>.

// === Keyboard shortcut dispatcher (with chord support) ==========

// Shared registry so chord dispatcher can resolve a prefix's single-key
// handler on timeout. Key: "<keyLower>:<ctrl?><shift?><alt?>"
const __shortcutRegistry = new Map();

function __comboKey(k, ctrl, shift, alt) {
    return `${k}:${ctrl ? 'c' : ''}${shift ? 's' : ''}${alt ? 'a' : ''}`;
}

function __matches(e, def) {
    const ctrl = e.ctrlKey || e.metaKey;
    return (def.ctrl || false) === ctrl
        && (def.shift || false) === e.shiftKey
        && (def.alt || false) === e.altKey
        && e.key.toLowerCase() === def.key;
}

/**
 * Set up table-driven keyboard shortcuts.
 * Each entry: { key, ctrl, shift, alt, action }
 * - key: lowercase key name
 * - ctrl: true if Ctrl/Cmd required (default false)
 * - shift: true if Shift required (default false)
 * - alt: true if Alt/Option required (default false)
 * - action: function to call (may be async)
 * Entries are matched in order; more-specific (shift/alt) variants must
 * precede less-specific variants for the same key.
 */
export function setupKeyboardShortcuts(shortcuts) {
    // Register every shortcut in the shared registry so chord dispatcher
    // can run the right single-key action on timeout. Last registration wins
    // for any combo; that mirrors how setupKeyboardShortcuts currently works
    // (first match on order, but a later setup call would override).
    for (const s of shortcuts) {
        const combo = __comboKey(s.key, s.ctrl, s.shift, s.alt);
        __shortcutRegistry.set(combo, s.action);
    }
    document.addEventListener('keydown', async (e) => {
        // If a chord prefix is pending, let the chord dispatcher run first
        // (it listens at the same phase but on window, so we just skip here
        // when the event is already handled — chord handler will call
        // stopImmediatePropagation()).
        if (e.defaultPrevented) return;
        for (const s of shortcuts) {
            if (__matches(e, s)) {
                e.preventDefault();
                await s.action(e);
                return;
            }
        }
    });
}

const CHORD_TIMEOUT_MS = 400;

/**
 * Register two-key chord shortcuts.
 *
 * Each prefix entry: { key1, ctrl1, shift1, alt1, secondKeys: [{ key2, ctrl2, ..., action }, ...] }
 *
 * Behavior:
 *   - On a keydown matching a prefix, swallow the event and arm a 400ms timer.
 *   - If another keydown arrives within the window matching a secondKeys entry,
 *     run that action and clear state.
 *   - If another keydown arrives that matches NO secondKeys entry, cancel the
 *     pending state and fall through (the second key dispatches normally).
 *   - On timeout, run the single-key handler registered in the shared registry
 *     for the prefix combo, if any; otherwise the chord prefix is a no-op.
 *
 * Trade-off: any single-key action that shares a chord prefix fires 400ms
 * after keypress. Prefer binding conflicting single-key actions to a non-chord
 * combo (e.g. Insert Link uses Cmd+Shift+U so Cmd+K stays chord-only).
 */
export function setupChordShortcuts(prefixes) {
    let pending = null; // { prefix, timer }

    const resolvePrefixAction = (prefix) => {
        const combo = __comboKey(prefix.key1, prefix.ctrl1, prefix.shift1, prefix.alt1);
        return __shortcutRegistry.get(combo) || null;
    };

    const fireTimeout = () => {
        if (!pending) return;
        const action = resolvePrefixAction(pending.prefix);
        pending = null;
        if (action) action();
    };

    document.addEventListener('keydown', async (e) => {
        if (pending) {
            // Modifier-only keydowns (releasing and re-pressing Cmd between the
            // two chord keys) must not cancel the pending chord.
            if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') {
                return;
            }
            // Look for a matching secondKeys entry
            for (const sk of pending.prefix.secondKeys) {
                const def = { key: sk.key2, ctrl: sk.ctrl2, shift: sk.shift2, alt: sk.alt2 };
                if (__matches(e, def)) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    clearTimeout(pending.timer);
                    pending = null;
                    await sk.action(e);
                    return;
                }
            }
            // Second key didn't match any chord: cancel and let event flow normally.
            clearTimeout(pending.timer);
            const cancelled = pending.prefix;
            pending = null;
            // Still fire the prefix's single-key action so the user's intent
            // ("Cmd+K alone") completes, then re-dispatch the second key.
            // Simpler and less surprising: drop the prefix action, let the 2nd key run.
            void cancelled;
            return;
        }
        for (const p of prefixes) {
            const def = { key: p.key1, ctrl: p.ctrl1, shift: p.shift1, alt: p.alt1 };
            if (__matches(e, def)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                pending = { prefix: p, timer: setTimeout(fireTimeout, CHORD_TIMEOUT_MS) };
                return;
            }
        }
    }, { capture: true });
}

// === Command palette ============================================

/**
 * Cheap fuzzy-subsequence scorer (case-insensitive). Higher is better.
 * Returns -1 if any query char is missing.
 */
function __fuzzyScore(haystack, needle) {
    if (!needle) return 0;
    const hay = haystack.toLowerCase();
    const ndl = needle.toLowerCase();
    let hi = 0;
    let score = 0;
    let streak = 0;
    for (let ni = 0; ni < ndl.length; ni++) {
        const ch = ndl[ni];
        const idx = hay.indexOf(ch, hi);
        if (idx < 0) return -1;
        // Bonus for consecutive matches, for matches at word boundaries, for early matches
        if (idx === hi) { streak++; score += 2 + streak; }
        else { streak = 0; score += 1; }
        if (idx === 0 || ' -_/.:'.includes(hay[idx - 1])) score += 2;
        score -= Math.max(0, idx - hi) * 0.05;
        hi = idx + 1;
    }
    return score;
}

/**
 * Build a command palette modal. Returns `{ root, open(query?), close() }`.
 *
 * `getActions()` is called each time the palette opens, so actions can
 * reflect current state (e.g. "Save" only if there is an active file).
 * Each action: { id, label, hint?, run }
 */
export function createCommandPalette(parent, getActions) {
    const backdrop = document.createElement('div');
    backdrop.className = 'cmd-palette-backdrop';
    backdrop.innerHTML = `
      <div class="cmd-palette" role="dialog" aria-label="Command palette">
        <input class="cmd-palette-input" type="text" placeholder="Type a command…" aria-label="Filter commands" />
        <div class="cmd-palette-list" role="listbox"></div>
      </div>`;
    (parent || document.body).appendChild(backdrop);

    const input = backdrop.querySelector('.cmd-palette-input');
    const list = backdrop.querySelector('.cmd-palette-list');

    let actions = [];
    let filtered = [];
    let activeIdx = 0;
    let returnFocusEl = null;

    function render() {
        list.innerHTML = '';
        filtered.forEach((a, i) => {
            const row = document.createElement('div');
            row.className = 'cmd-palette-item' + (i === activeIdx ? ' active' : '');
            row.setAttribute('role', 'option');
            row.dataset.idx = String(i);
            row.innerHTML = `<span class="label"></span>${a.hint ? `<span class="hint"></span>` : ''}`;
            row.querySelector('.label').textContent = a.label;
            if (a.hint) row.querySelector('.hint').textContent = a.hint;
            row.addEventListener('mouseenter', () => setActive(i));
            row.addEventListener('click', () => runActive());
            list.appendChild(row);
        });
        const active = list.children[activeIdx];
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    function refilter() {
        const q = input.value.trim();
        if (!q) {
            filtered = actions.slice();
        } else {
            const scored = actions
                .map(a => ({ a, s: __fuzzyScore(a.label, q) }))
                .filter(x => x.s >= 0)
                .sort((x, y) => y.s - x.s);
            filtered = scored.map(x => x.a);
        }
        activeIdx = filtered.length ? 0 : -1;
        render();
    }

    function setActive(i) {
        if (i < 0 || i >= filtered.length) return;
        activeIdx = i;
        [...list.children].forEach((el, j) => el.classList.toggle('active', j === activeIdx));
        const el = list.children[activeIdx];
        if (el) el.scrollIntoView({ block: 'nearest' });
    }

    async function runActive() {
        if (activeIdx < 0 || activeIdx >= filtered.length) return;
        const action = filtered[activeIdx];
        close();
        try { await action.run(); }
        catch (err) { console.error('Command failed:', err); }
    }

    function open(initialQuery = '') {
        actions = (typeof getActions === 'function' ? getActions() : getActions) || [];
        input.value = initialQuery;
        returnFocusEl = (document.activeElement && document.activeElement !== document.body)
            ? document.activeElement : null;
        refilter();
        backdrop.classList.add('show');
        // Defer focus so the keydown that opened the palette doesn't leak into the input.
        setTimeout(() => { input.focus(); input.select(); }, 0);
    }

    function close() {
        backdrop.classList.remove('show');
        const rt = returnFocusEl;
        returnFocusEl = null;
        if (rt && document.contains(rt) && typeof rt.focus === 'function') rt.focus();
    }

    input.addEventListener('input', refilter);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter') { e.preventDefault(); runActive(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(filtered.length - 1, activeIdx + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, activeIdx - 1)); }
    });
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });

    return { root: backdrop, open, close };
}
