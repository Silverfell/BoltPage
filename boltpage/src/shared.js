// Shared constants and utilities for preview (main.js) and editor (editor.js)

// Scroll sync configuration
export const SCROLL_SYNC_DEBOUNCE_MS = 50;
export const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 100;
export const MIN_SCROLL_DELTA_LINES = 0.5;
export const MIN_SCROLL_DELTA_PERCENT = 0.01;
export const LINE_HEIGHT_FALLBACK_MULTIPLIER = 1.4;

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
        <button class="find-btn" id="find-prev" title="Previous">&#8593;</button>
        <button class="find-btn" id="find-next" title="Next">&#8595;</button>
        <button class="find-btn" id="find-close" title="Close">&#10005;</button>
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
