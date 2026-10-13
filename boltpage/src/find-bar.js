// Docked find bar shared by the preview (main.js) and editor (editor.js) windows.
//
// The bar owns its markup, the query/toggle state, the type debounce, the
// Enter / Shift+Enter / Escape keys, the count text, focus return and the
// optional replace row. What "searching" means belongs to the window, which
// passes an adapter:
//
//   available()             -> false while the window cannot be searched
//                              (no file, a PDF); the bar then stays closed.
//   search(query, options)  -> number of matches, after highlighting them.
//                              options: { matchCase, wholeWord, keepPosition }.
//                              Without keepPosition the first match becomes
//                              current and is scrolled to; with it nothing
//                              moves (re-run after a change, use-selection
//                              unless jumpToSelection).
//   step(direction)         -> index of the current match, or -1. 1 and -1 move
//                              to the next / previous match and wrap; 0 moves
//                              nothing and only reports.
//   clear()                 -> drop the highlights and the query.
//   replace(text)           -> optional; replace the current match, return the
//   replaceAll(text)           new match count. Declaring replace adds the
//                              replace row.
//   selectionText()         -> optional; the window's selected text.
//   jumpToSelection         -> optional; true when use-selection moves to the
//                              first match instead of searching in place.
//   focus()                 -> optional; take focus when the bar closes. Without
//                              it focus returns to whatever had it on open.
//
// Usage:
//   const findBar = createFindBar({ document, parent: slotElement, adapter });
//   findBar.open();            // Cmd+F; open('text') pre-fills instead of the selection
//   findBar.contentChanged();  // after the searched content changed
//
// The DOM is built on first use through the document passed in, so the module
// loads in plain Node and the slot stays empty until the bar is needed.

// Debounce window for find-as-you-type
const FIND_TYPE_DEBOUNCE_MS = 80;

export function createFindBar({ document, parent, adapter, timers = globalThis }) {
    let overlay = null;
    let input = null;
    let countEl = null;
    let replaceRow = null;
    let replaceInput = null;
    let visible = false;
    let matchCase = false;
    let wholeWord = false;
    let typeTimer = null;
    let returnFocusEl = null;
    // The query the adapter is currently highlighting; '' when there is none.
    let query = '';
    let count = 0;
    let index = -1;

    function el(tag, className, props = {}, attrs = {}) {
        const node = document.createElement(tag);
        node.className = className;
        Object.assign(node, props);
        for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
        return node;
    }

    function button(className, id, title, label, text, attrs = {}) {
        const attributes = label ? { 'aria-label': label, ...attrs } : attrs;
        return el('button', className, { id, type: 'button', title, textContent: text }, attributes);
    }

    function ensure() {
        if (overlay) return;
        overlay = el('div', 'find-overlay');
        input = el('input', 'find-input', { id: 'find-input', type: 'text', placeholder: 'Find...' }, { 'aria-label': 'Find' });
        countEl = el('span', 'find-count', { id: 'find-count' });
        const caseBtn = button('find-btn find-toggle', 'find-case', 'Match case', 'Match case', 'Aa', { 'aria-pressed': 'false' });
        const wordBtn = button('find-btn find-toggle', 'find-word', 'Whole word', 'Whole word', '“”', { 'aria-pressed': 'false' });
        const prevBtn = button('find-btn', 'find-prev', 'Previous match (Shift+Enter)', 'Previous match', '↑');
        const nextBtn = button('find-btn', 'find-next', 'Next match (Enter)', 'Next match', '↓');
        const closeBtn = button('find-btn', 'find-close', 'Close (Esc)', 'Close find', '✕');
        for (const node of [input, countEl, caseBtn, wordBtn, prevBtn, nextBtn, closeBtn]) overlay.appendChild(node);

        input.addEventListener('input', () => {
            if (typeTimer) timers.clearTimeout(typeTimer);
            typeTimer = timers.setTimeout(() => {
                typeTimer = null;
                runFromInput();
            }, FIND_TYPE_DEBOUNCE_MS);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) previous(); else next();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
            } else if (e.key === 'Tab' && !e.shiftKey && replaceRow && !replaceRow.hidden) {
                e.preventDefault();
                replaceInput.focus();
            }
        });

        const toggle = (btn, setter) => {
            const pressed = btn.getAttribute('aria-pressed') !== 'true';
            btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
            btn.classList.toggle('active', pressed);
            setter(pressed);
            runFromInput();
            input.focus();
        };
        caseBtn.addEventListener('click', () => toggle(caseBtn, v => { matchCase = v; }));
        wordBtn.addEventListener('click', () => toggle(wordBtn, v => { wholeWord = v; }));
        prevBtn.addEventListener('click', previous);
        nextBtn.addEventListener('click', next);
        closeBtn.addEventListener('click', close);

        if (adapter.replace) buildReplaceRow();
        parent.appendChild(overlay);
    }

    // Hidden until the user requests Find-and-Replace.
    function buildReplaceRow() {
        replaceRow = el('div', 'replace-row', { hidden: true });
        replaceInput = el('input', 'find-input replace-input', { id: 'replace-input', type: 'text', placeholder: 'Replace...' }, { 'aria-label': 'Replace with' });
        const oneBtn = button('find-btn replace-btn-text', 'replace-one', 'Replace current match', null, 'Replace');
        const allBtn = button('find-btn replace-btn-text', 'replace-all', 'Replace all matches', null, 'All');
        for (const node of [replaceInput, oneBtn, allBtn]) replaceRow.appendChild(node);
        overlay.appendChild(replaceRow);

        replaceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                replaceWith(adapter.replace);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
            } else if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault();
                input.focus();
            }
        });
        oneBtn.addEventListener('click', () => replaceWith(adapter.replace));
        allBtn.addEventListener('click', () => replaceWith(adapter.replaceAll));
    }

    function renderCount() {
        if (count === 0) {
            countEl.textContent = input.value ? '0/0' : '';
        } else {
            countEl.textContent = `${index + 1}/${count}`;
        }
    }

    function setCount(matches) {
        count = matches;
        index = count > 0 ? adapter.step(0) : -1;
        renderCount();
    }

    function search(text, keepPosition) {
        query = text;
        if (!query) {
            adapter.clear();
            setCount(0);
            return;
        }
        setCount(adapter.search(query, { matchCase, wholeWord, keepPosition }));
    }

    function runFromInput() {
        search(input.value, false);
    }

    function step(direction) {
        if (!overlay || !adapter.available()) return;
        if (count === 0) {
            runFromInput();
            return;
        }
        index = adapter.step(direction);
        renderCount();
    }

    function next() {
        step(1);
    }

    function previous() {
        step(-1);
    }

    function replaceWith(replaceFn) {
        if (!query) return;
        setCount(replaceFn(replaceInput.value));
    }

    function selection() {
        return adapter.selectionText ? adapter.selectionText() : '';
    }

    function show(withReplace) {
        ensure();
        if (!visible) {
            const active = document.activeElement;
            returnFocusEl = (active && active !== document.body) ? active : null;
        }
        if (replaceRow) replaceRow.hidden = !withReplace;
        overlay.classList.add('show');
        visible = true;
    }

    /** Open the bar on `text`, or on the window's selection when none is given. */
    function open(text) {
        if (!adapter.available()) return;
        show(false);
        const fill = text || selection();
        if (fill) {
            input.value = fill;
            runFromInput();
        }
        input.focus();
        input.select();
    }

    /** Open with the replace row; plain find where the adapter cannot replace. */
    function openReplace() {
        if (!adapter.replace) {
            open();
            return;
        }
        if (!adapter.available()) return;
        show(true);
        const sel = selection();
        if (sel && !input.value) {
            input.value = sel;
            runFromInput();
        }
        input.focus();
        input.select();
    }

    /**
     * Search for the window's selection without opening the bar, so the user
     * can keep reading. Returns false when there is nothing selected.
     */
    function useSelection() {
        if (!adapter.available()) return false;
        const sel = selection();
        if (!sel) return false;
        ensure();
        input.value = sel;
        search(sel, !adapter.jumpToSelection);
        if (visible) {
            input.focus();
            input.select();
        }
        return true;
    }

    function close() {
        if (!overlay) return;
        overlay.classList.remove('show');
        visible = false;
        if (typeTimer) {
            timers.clearTimeout(typeTimer);
            typeTimer = null;
        }
        search('', false);
        if (replaceRow) {
            replaceRow.hidden = true;
            replaceInput.value = '';
        }
        const returnTo = returnFocusEl;
        returnFocusEl = null;
        if (adapter.focus) {
            adapter.focus();
        } else if (returnTo && document.contains(returnTo) && typeof returnTo.focus === 'function') {
            returnTo.focus();
        } else if (document.activeElement === input) {
            input.blur();
        }
    }

    function toggle() {
        if (visible) close(); else open();
    }

    /**
     * The searched content changed: highlight the current query again without
     * moving, or close the bar when the window can no longer be searched.
     */
    function contentChanged() {
        if (!overlay) return;
        if (!adapter.available()) {
            close();
            return;
        }
        if (query) search(query, true);
    }

    return { open, openReplace, useSelection, toggle, close, next, previous, contentChanged };
}
