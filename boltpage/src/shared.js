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

/**
 * Creates the find overlay DOM and appends it to document.body.
 * Returns { overlay, input } for the caller to wire up event handlers.
 */
export function createFindOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'find-overlay';
    overlay.innerHTML = `
        <input id="find-input" class="find-input" type="text" placeholder="Find..." />
        <span class="find-count" id="find-count"></span>
        <button class="find-btn" id="find-prev" title="Previous" aria-label="Previous match">&#8593;</button>
        <button class="find-btn" id="find-next" title="Next" aria-label="Next match">&#8595;</button>
        <button class="find-btn" id="find-close" title="Close" aria-label="Close find">&#10005;</button>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#find-input');
    return { overlay, input };
}

export function updateFindCount(overlay, results, currentIndex) {
    const countEl = overlay?.querySelector('#find-count');
    if (!countEl) return;
    if (results.length === 0) {
        countEl.textContent = '';
    } else {
        countEl.textContent = `${currentIndex + 1}/${results.length}`;
    }
}

/**
 * Calculate the next find result index.
 * @param {number} currentIndex - current find result index
 * @param {number} totalResults - total number of find results
 * @param {number} direction - 1 for next, -1 for previous
 * @returns {number} new index
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
 * Each entry: { key, ctrl, shift, action }
 * - key: lowercase key name
 * - ctrl: true if Ctrl/Cmd required (default false)
 * - shift: true if Shift required (default false)
 * - action: function to call (may be async)
 * Entries are matched in order; shift variants must precede non-shift for the same key.
 */
export function setupKeyboardShortcuts(shortcuts) {
    document.addEventListener('keydown', async (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        for (const s of shortcuts) {
            if ((s.ctrl || false) === ctrl
                && (s.shift || false) === e.shiftKey
                && e.key.toLowerCase() === s.key) {
                e.preventDefault();
                await s.action(e);
                return;
            }
        }
    });
}
