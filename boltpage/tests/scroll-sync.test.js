import test from 'node:test';
import assert from 'node:assert/strict';

import { createScrollSync } from '../src/scroll-sync.js';
import { EVENT_SCROLL_SYNC, KIND_MARKDOWN, KIND_JSON, KIND_YAML, KIND_TXT } from '../src/constants.js';

const DEBOUNCE_MS = 50;
const GUARD_MS = 100;

function fakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    return {
        setTimeout(fn, ms) {
            const id = nextId++;
            timers.set(id, { fn, at: now + ms });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        advance(ms) {
            const end = now + ms;
            for (;;) {
                const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].fn();
            }
            now = end;
        },
    };
}

// One window: a fake adapter over plain state, with emitted payloads and
// scroll calls recorded, and deliver() standing in for the event bus.
function fakeWindow({ label = 'preview', path = '/doc.md', kind = KIND_MARKDOWN } = {}) {
    const clock = fakeClock();
    const win = {
        clock,
        path,
        kind,
        line: 1,
        percent: 0,
        scrollable: true,
        emitted: [],
        scrolls: [],
        handlers: {},
    };
    const adapter = {
        label,
        filePath: () => win.path,
        kind: () => win.kind,
        topLine: () => win.line,
        topPercent: () => (win.scrollable ? win.percent : null),
        scrollToLine(line) {
            win.scrolls.push({ line });
            win.line = line;
        },
        scrollToPercent(percent) {
            if (!win.scrollable) return false;
            win.scrolls.push({ percent });
            win.percent = percent;
            return true;
        },
    };
    win.sync = createScrollSync({
        adapter,
        emit: (payload) => win.emitted.push(payload),
        listen: (name, handler) => { win.handlers[name] = handler; },
        clock,
    });
    win.deliver = (payload) => win.handlers[EVENT_SCROLL_SYNC]({ payload });
    // A user scroll that settles: move, fire the event, let the debounce run.
    win.userScroll = (position) => {
        Object.assign(win, position);
        win.sync.onScroll();
        clock.advance(DEBOUNCE_MS);
    };
    return win;
}

test('a burst of scroll events is debounced into one payload', () => {
    const win = fakeWindow();
    win.percent = 0.2;
    win.sync.onScroll();
    win.clock.advance(DEBOUNCE_MS - 1);
    win.percent = 0.4;
    win.sync.onScroll();
    win.clock.advance(DEBOUNCE_MS - 1);
    assert.deepEqual(win.emitted, []);
    win.clock.advance(1);
    assert.deepEqual(win.emitted, [
        { source: 'preview', file_path: '/doc.md', kind: KIND_MARKDOWN, line: null, percent: 0.4 },
    ]);
});

test('line kinds send a line, other kinds send a percent', () => {
    for (const kind of [KIND_JSON, KIND_YAML, KIND_TXT]) {
        const win = fakeWindow({ path: '/data', kind });
        win.userScroll({ line: 12, percent: 0.5 });
        assert.deepEqual(win.emitted, [
            { source: 'preview', file_path: '/data', kind, line: 12, percent: null },
        ]);
    }
    const md = fakeWindow();
    md.userScroll({ line: 12, percent: 0.5 });
    assert.deepEqual(md.emitted, [
        { source: 'preview', file_path: '/doc.md', kind: KIND_MARKDOWN, line: null, percent: 0.5 },
    ]);
});

test('nothing is sent without a file, without a synced kind, or without a readable position', () => {
    const noFile = fakeWindow({ path: null });
    noFile.userScroll({ percent: 0.5 });
    assert.deepEqual(noFile.emitted, []);

    const pdf = fakeWindow({ path: '/doc.pdf', kind: null });
    pdf.userScroll({ percent: 0.5 });
    assert.deepEqual(pdf.emitted, []);

    const fits = fakeWindow();
    fits.scrollable = false;
    fits.userScroll({ percent: 0.5 });
    assert.deepEqual(fits.emitted, []);
});

test('micro-scrolls below the threshold are not sent', () => {
    const md = fakeWindow();
    md.userScroll({ percent: 0.5 });
    md.userScroll({ percent: 0.505 });
    assert.equal(md.emitted.length, 1);
    md.userScroll({ percent: 0.52 });
    assert.deepEqual(md.emitted.map((p) => p.percent), [0.5, 0.52]);

    const json = fakeWindow({ path: '/a.json', kind: KIND_JSON });
    json.userScroll({ line: 7 });
    json.userScroll({ line: 7 });
    assert.equal(json.emitted.length, 1);
    json.userScroll({ line: 8 });
    assert.deepEqual(json.emitted.map((p) => p.line), [7, 8]);
});

test('a payload from this window or from another file is ignored', () => {
    const win = fakeWindow();
    win.deliver({ source: 'preview', file_path: '/doc.md', kind: KIND_MARKDOWN, line: null, percent: 0.7 });
    win.deliver({ source: 'editor', file_path: '/other.md', kind: KIND_MARKDOWN, line: null, percent: 0.7 });
    assert.deepEqual(win.scrolls, []);

    const noFile = fakeWindow({ path: null });
    noFile.deliver({ source: 'editor', file_path: null, kind: KIND_MARKDOWN, line: null, percent: 0.7 });
    assert.deepEqual(noFile.scrolls, []);

    win.deliver({ source: 'editor', file_path: '/doc.md', kind: KIND_MARKDOWN, line: null, percent: 0.7 });
    assert.deepEqual(win.scrolls, [{ percent: 0.7 }]);
});

test('a received payload scrolls by line or percent according to this window\'s kind', () => {
    const json = fakeWindow({ path: '/a.json', kind: KIND_JSON });
    json.deliver({ source: 'editor', file_path: '/a.json', kind: KIND_JSON, line: 30, percent: 0.9 });
    assert.deepEqual(json.scrolls, [{ line: 30 }]);

    const md = fakeWindow();
    md.deliver({ source: 'editor', file_path: '/doc.md', kind: KIND_MARKDOWN, line: 30, percent: 0.9 });
    assert.deepEqual(md.scrolls, [{ percent: 0.9 }]);
});

test('the echo of a received scroll is not sent back', () => {
    const win = fakeWindow();
    win.deliver({ source: 'editor', file_path: '/doc.md', kind: KIND_MARKDOWN, line: null, percent: 0.7 });
    // The scroll event the programmatic scroll causes, inside the guard window.
    win.sync.onScroll();
    win.clock.advance(GUARD_MS + DEBOUNCE_MS);
    assert.deepEqual(win.emitted, []);

    // Once the guard has lapsed, a late event at the received position is
    // still filtered, and a real user scroll is sent.
    win.userScroll({ percent: 0.7 });
    assert.deepEqual(win.emitted, []);
    win.userScroll({ percent: 0.3 });
    assert.deepEqual(win.emitted.map((p) => p.percent), [0.3]);
});

test('a received scroll that could not be applied is not recorded as synced', () => {
    const win = fakeWindow();
    win.scrollable = false;
    win.deliver({ source: 'editor', file_path: '/doc.md', kind: KIND_MARKDOWN, line: null, percent: 0.7 });
    win.clock.advance(GUARD_MS);
    win.scrollable = true;
    win.userScroll({ percent: 0.7 });
    assert.deepEqual(win.emitted.map((p) => p.percent), [0.7]);
});

test('programmatic() suppresses scroll events until its timeout, restarted by each call', () => {
    const win = fakeWindow();
    let ran = 0;
    assert.equal(win.sync.programmatic(() => { ran++; return 'result'; }), 'result');
    assert.equal(ran, 1);
    win.clock.advance(GUARD_MS - 10);
    win.sync.programmatic(() => {});
    win.clock.advance(GUARD_MS - 10);
    win.userScroll({ percent: 0.5 });
    assert.deepEqual(win.emitted, []);

    win.clock.advance(10);
    win.userScroll({ percent: 0.6 });
    assert.deepEqual(win.emitted.map((p) => p.percent), [0.6]);
});

test('top() and scrollTo() restore an anchor by kind, guarded and outside the micro-scroll filter', () => {
    const json = fakeWindow({ path: '/a.json', kind: KIND_JSON });
    json.line = 40;
    json.percent = 0.5;
    assert.deepEqual(json.sync.top(), { line: 40 });

    const md = fakeWindow();
    md.percent = 0.5;
    const anchor = md.sync.top();
    assert.deepEqual(anchor, { percent: 0.5 });
    md.percent = 0.1;
    assert.equal(md.sync.scrollTo(anchor), true);
    assert.deepEqual(md.scrolls, [{ percent: 0.5 }]);
    md.sync.onScroll();
    md.clock.advance(GUARD_MS + DEBOUNCE_MS);
    assert.deepEqual(md.emitted, []);
    // The restore was not a sync, so the same position is still sendable.
    md.userScroll({ percent: 0.5 });
    assert.deepEqual(md.emitted.map((p) => p.percent), [0.5]);

    md.scrollable = false;
    assert.equal(md.sync.top(), null);
    assert.equal(md.sync.scrollTo(null), false);
    assert.equal(md.sync.scrollTo(anchor), false);
});
