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
    document.addEventListener('keydown', async (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        for (const s of shortcuts) {
            if ((s.ctrl || false) === ctrl
                && (s.shift || false) === e.shiftKey
                && (s.alt || false) === e.altKey
                && e.key.toLowerCase() === s.key) {
                e.preventDefault();
                await s.action(e);
                return;
            }
        }
    });
}
