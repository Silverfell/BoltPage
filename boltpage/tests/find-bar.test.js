import test from 'node:test';
import assert from 'node:assert/strict';

import { createFindBar } from '../src/find-bar.js';

const DEBOUNCE_MS = 80;

// The few DOM members the bar touches.
function makeDocument() {
    const doc = { activeElement: null };
    function makeElement(tag) {
        const listeners = {};
        const attrs = {};
        const classes = new Set();
        const node = {
            tag,
            children: [],
            parent: null,
            value: '',
            textContent: '',
            hidden: false,
            selected: false,
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c),
                toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
            },
            setAttribute: (name, value) => { attrs[name] = value; },
            getAttribute: (name) => (name in attrs ? attrs[name] : null),
            appendChild(child) { child.parent = node; node.children.push(child); return child; },
            addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
            fire(type, event = {}) {
                const e = { prevented: false, preventDefault() { e.prevented = true; }, ...event };
                for (const fn of listeners[type] || []) fn(e);
                return e;
            },
            focus() { doc.activeElement = node; },
            blur() { if (doc.activeElement === node) doc.activeElement = doc.body; },
            select() { node.selected = true; },
        };
        return node;
    }
    doc.createElement = makeElement;
    doc.body = makeElement('body');
    doc.activeElement = doc.body;
    doc.contains = (node) => {
        for (let n = node; n; n = n.parent) if (n === doc.body) return true;
        return false;
    };
    return doc;
}

function makeClock() {
    let now = 0;
    let nextId = 1;
    const pending = new Map();
    return {
        setTimeout(fn, ms) { pending.set(nextId, { fn, at: now + ms }); return nextId++; },
        clearTimeout(id) { pending.delete(id); },
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...pending]) {
                if (timer.at <= now) { pending.delete(id); timer.fn(); }
            }
        },
    };
}

/**
 * A bar over a fake window. `h.matches` is how many matches the next search
 * finds; `h.calls` records every adapter call that changes something.
 */
function harness({ replace = false, focus = false, jumpToSelection = false } = {}) {
    const document = makeDocument();
    const slot = document.body.appendChild(document.createElement('div'));
    const clock = makeClock();
    const h = { document, slot, clock, calls: [], matches: 3, current: -1, available: true, selection: '' };
    const adapter = {
        available: () => h.available,
        search(query, options) {
            h.calls.push(['search', query, options]);
            if (!options.keepPosition) h.current = h.matches > 0 ? 0 : -1;
            return h.matches;
        },
        step(direction) {
            if (direction !== 0) {
                h.calls.push(['step', direction]);
                h.current = (h.current + direction + h.matches) % h.matches;
            }
            return h.current;
        },
        clear() { h.calls.push(['clear']); h.current = -1; },
        selectionText: () => h.selection,
    };
    if (replace) {
        adapter.replace = (text) => { h.calls.push(['replace', text]); h.matches -= 1; return h.matches; };
        adapter.replaceAll = (text) => { h.calls.push(['replaceAll', text]); h.matches = 0; return 0; };
    }
    if (focus) adapter.focus = () => { h.calls.push(['focus']); };
    if (jumpToSelection) adapter.jumpToSelection = true;
    h.bar = createFindBar({ document, parent: slot, adapter, timers: clock });
    h.overlay = () => slot.children[0];
    h.byId = (id) => {
        const walk = (node) => (node.id === id ? node : node.children.map(walk).find(Boolean));
        return walk(slot);
    };
    h.searches = () => h.calls.filter(c => c[0] === 'search');
    h.isOpen = () => !!h.overlay() && h.overlay().classList.contains('show');
    h.type = (text) => {
        h.byId('find-input').value = text;
        h.byId('find-input').fire('input');
    };
    h.typeAndWait = (text) => {
        h.type(text);
        clock.advance(DEBOUNCE_MS);
    };
    return h;
}

const FRESH = { matchCase: false, wholeWord: false, keepPosition: false };

test('the slot stays empty until the bar is first opened', () => {
    const h = harness();
    assert.equal(h.slot.children.length, 0);
    h.bar.open();
    assert.equal(h.slot.children.length, 1);
    assert.equal(h.isOpen(), true);
    assert.equal(h.document.activeElement, h.byId('find-input'));
    assert.equal(h.byId('find-input').selected, true);
    assert.deepEqual(h.calls, []);
});

test('typing searches once, after the debounce window', () => {
    const h = harness();
    h.bar.open();
    h.type('a');
    h.clock.advance(DEBOUNCE_MS - 1);
    h.type('ab');
    h.clock.advance(DEBOUNCE_MS - 1);
    assert.deepEqual(h.searches(), []);
    h.clock.advance(1);
    assert.deepEqual(h.searches(), [['search', 'ab', FRESH]]);
});

test('Enter steps forward, Shift+Enter back, and both are consumed', () => {
    const h = harness();
    h.bar.open();
    h.typeAndWait('ab');
    const input = h.byId('find-input');
    assert.equal(input.fire('keydown', { key: 'Enter' }).prevented, true);
    assert.equal(h.byId('find-count').textContent, '2/3');
    assert.equal(input.fire('keydown', { key: 'Enter', shiftKey: true }).prevented, true);
    input.fire('keydown', { key: 'Enter', shiftKey: true });
    assert.equal(h.byId('find-count').textContent, '3/3');
    assert.deepEqual(h.calls.slice(1), [['step', 1], ['step', -1], ['step', -1]]);
});

test('Enter searches the typed text when nothing is matched yet', () => {
    const h = harness();
    h.bar.open();
    h.type('ab');
    h.byId('find-input').fire('keydown', { key: 'Enter' });
    assert.deepEqual(h.calls, [['search', 'ab', FRESH]]);
});

test('the previous and next buttons step like the keys', () => {
    const h = harness();
    h.bar.open();
    h.typeAndWait('ab');
    h.byId('find-next').fire('click');
    h.byId('find-prev').fire('click');
    assert.deepEqual(h.calls.slice(1), [['step', 1], ['step', -1]]);
    assert.equal(h.byId('find-count').textContent, '1/3');
});

test('Escape closes, clears the search and drops a pending debounce', () => {
    const h = harness();
    h.bar.open();
    h.typeAndWait('ab');
    h.type('abc');
    const e = h.byId('find-input').fire('keydown', { key: 'Escape' });
    assert.equal(e.prevented, true);
    assert.equal(h.isOpen(), false);
    assert.deepEqual(h.calls.at(-1), ['clear']);
    h.clock.advance(DEBOUNCE_MS);
    assert.equal(h.searches().length, 1);
});

test('case and word toggles re-run the search with the new options', () => {
    const h = harness();
    h.bar.open();
    h.typeAndWait('ab');
    const caseBtn = h.byId('find-case');
    caseBtn.fire('click');
    assert.equal(caseBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(caseBtn.classList.contains('active'), true);
    assert.deepEqual(h.calls.at(-1), ['search', 'ab', { ...FRESH, matchCase: true }]);
    h.byId('find-word').fire('click');
    assert.deepEqual(h.calls.at(-1), ['search', 'ab', { ...FRESH, matchCase: true, wholeWord: true }]);
    caseBtn.fire('click');
    assert.equal(caseBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(caseBtn.classList.contains('active'), false);
    assert.deepEqual(h.calls.at(-1), ['search', 'ab', { ...FRESH, wholeWord: true }]);
    assert.equal(h.document.activeElement, h.byId('find-input'));
});

test('count text shows position/total, 0/0 for no match and nothing for no query', () => {
    const h = harness();
    h.bar.open();
    const count = h.byId('find-count');
    assert.equal(count.textContent, '');
    h.typeAndWait('ab');
    assert.equal(count.textContent, '1/3');
    h.matches = 0;
    h.typeAndWait('zz');
    assert.equal(count.textContent, '0/0');
    h.typeAndWait('');
    assert.equal(count.textContent, '');
    assert.deepEqual(h.calls.at(-1), ['clear']);
});

test('an unavailable adapter keeps the bar closed', () => {
    const h = harness({ replace: true });
    h.available = false;
    h.selection = 'ab';
    h.bar.open();
    h.bar.open('ab');
    h.bar.openReplace();
    h.bar.toggle();
    h.bar.next();
    h.bar.previous();
    assert.equal(h.bar.useSelection(), false);
    assert.equal(h.slot.children.length, 0);
    assert.deepEqual(h.calls, []);
});

test('the bar closes when the content becomes unavailable', () => {
    const h = harness();
    h.bar.open('ab');
    h.available = false;
    h.bar.contentChanged();
    assert.equal(h.isOpen(), false);
    assert.deepEqual(h.calls.at(-1), ['clear']);
});

test('contentChanged re-runs the query in place, only while there is one', () => {
    const h = harness();
    h.bar.contentChanged();
    h.bar.open();
    h.bar.contentChanged();
    assert.deepEqual(h.calls, []);

    h.typeAndWait('ab');
    h.byId('find-input').fire('keydown', { key: 'Enter' });
    h.matches = 5;
    h.bar.contentChanged();
    assert.deepEqual(h.calls.at(-1), ['search', 'ab', { ...FRESH, keepPosition: true }]);
    assert.equal(h.byId('find-count').textContent, '2/5');

    h.bar.close();
    const before = h.calls.length;
    h.bar.contentChanged();
    assert.equal(h.calls.length, before);
});

test('contentChanged re-runs the applied query, not text still being typed', () => {
    const h = harness();
    h.bar.open();
    h.typeAndWait('ab');
    h.type('abc');
    h.bar.contentChanged();
    assert.deepEqual(h.calls.at(-1), ['search', 'ab', { ...FRESH, keepPosition: true }]);
});

test('open searches the selection, or the given text over the selection', () => {
    const h = harness();
    h.selection = 'sel';
    h.bar.open();
    assert.equal(h.byId('find-input').value, 'sel');
    assert.deepEqual(h.calls, [['search', 'sel', FRESH]]);
    h.bar.open('given');
    assert.equal(h.byId('find-input').value, 'given');
    assert.deepEqual(h.calls.at(-1), ['search', 'given', FRESH]);
});

test('toggle opens and closes', () => {
    const h = harness();
    h.bar.toggle();
    assert.equal(h.isOpen(), true);
    h.bar.toggle();
    assert.equal(h.isOpen(), false);
});

test('use-selection searches in place and leaves a closed bar closed', () => {
    const h = harness();
    assert.equal(h.bar.useSelection(), false);
    assert.equal(h.slot.children.length, 0);

    h.selection = 'sel';
    assert.equal(h.bar.useSelection(), true);
    assert.equal(h.isOpen(), false);
    assert.notEqual(h.document.activeElement, h.byId('find-input'));
    assert.deepEqual(h.calls, [['search', 'sel', { ...FRESH, keepPosition: true }]]);

    // Find Next then walks those matches without the bar.
    h.current = 1;
    h.bar.next();
    assert.deepEqual(h.calls.at(-1), ['step', 1]);

    h.bar.open();
    h.selection = 'other';
    h.document.body.focus();
    assert.equal(h.bar.useSelection(), true);
    assert.equal(h.document.activeElement, h.byId('find-input'));
});

test('use-selection moves to the first match where the adapter asks for it', () => {
    const h = harness({ jumpToSelection: true });
    h.selection = 'sel';
    assert.equal(h.bar.useSelection(), true);
    assert.equal(h.isOpen(), false);
    assert.deepEqual(h.calls, [['search', 'sel', FRESH]]);
});

test('closing returns focus to what had it, or blurs the input', () => {
    const h = harness();
    const link = h.document.body.appendChild(h.document.createElement('a'));
    link.focus();
    h.bar.open();
    h.bar.close();
    assert.equal(h.document.activeElement, link);

    h.document.body.focus();
    h.bar.open();
    h.bar.close();
    assert.equal(h.document.activeElement, h.document.body);
});

test('closing hands focus to the adapter when it asks for it', () => {
    const h = harness({ focus: true });
    const link = h.document.body.appendChild(h.document.createElement('a'));
    link.focus();
    h.bar.open();
    h.bar.close();
    assert.deepEqual(h.calls.at(-1), ['focus']);
    assert.equal(h.document.activeElement, h.byId('find-input'));
});

test('no replace row without a replacing adapter; openReplace is plain find', () => {
    const h = harness();
    h.bar.openReplace();
    assert.equal(h.isOpen(), true);
    assert.equal(h.byId('replace-input'), undefined);
    assert.equal(h.overlay().children.some(c => c.className === 'replace-row'), false);
});

test('a replacing adapter gets a replace row, shown only by openReplace', () => {
    const h = harness({ replace: true });
    h.bar.open();
    const row = h.overlay().children.find(c => c.className === 'replace-row');
    assert.equal(row.hidden, true);
    h.bar.openReplace();
    assert.equal(row.hidden, false);
    h.bar.open();
    assert.equal(row.hidden, true);
    h.bar.openReplace();
    h.byId('replace-input').value = 'x';
    h.bar.close();
    assert.equal(row.hidden, true);
    assert.equal(h.byId('replace-input').value, '');
});

test('openReplace fills from the selection only into an empty input', () => {
    const h = harness({ replace: true });
    h.selection = 'sel';
    h.bar.openReplace();
    assert.equal(h.byId('find-input').value, 'sel');
    h.selection = 'other';
    h.bar.openReplace();
    assert.equal(h.byId('find-input').value, 'sel');
    assert.equal(h.searches().length, 1);
});

test('replace and replace-all pass the replacement and show the new count', () => {
    const h = harness({ replace: true });
    h.bar.openReplace();
    const replaceInput = h.byId('replace-input');
    replaceInput.value = 'x';

    // Nothing is searched yet, so there is nothing to replace.
    h.byId('replace-one').fire('click');
    assert.deepEqual(h.calls, []);

    h.typeAndWait('ab');
    h.byId('replace-one').fire('click');
    assert.deepEqual(h.calls.at(-1), ['replace', 'x']);
    assert.equal(h.byId('find-count').textContent, '1/2');
    assert.equal(replaceInput.fire('keydown', { key: 'Enter' }).prevented, true);
    assert.deepEqual(h.calls.at(-1), ['replace', 'x']);
    assert.equal(h.byId('find-count').textContent, '1/1');
    h.byId('replace-all').fire('click');
    assert.deepEqual(h.calls.at(-1), ['replaceAll', 'x']);
    assert.equal(h.byId('find-count').textContent, '0/0');
});

test('Tab moves between the find and replace inputs; Escape closes from either', () => {
    const h = harness({ replace: true });
    h.bar.open();
    const input = h.byId('find-input');
    const replaceInput = h.byId('replace-input');
    // Row hidden: Tab is left to the browser.
    assert.equal(input.fire('keydown', { key: 'Tab' }).prevented, false);

    h.bar.openReplace();
    assert.equal(input.fire('keydown', { key: 'Tab' }).prevented, true);
    assert.equal(h.document.activeElement, replaceInput);
    assert.equal(replaceInput.fire('keydown', { key: 'Tab', shiftKey: true }).prevented, true);
    assert.equal(h.document.activeElement, input);
    replaceInput.fire('keydown', { key: 'Escape' });
    assert.equal(h.isOpen(), false);
});
