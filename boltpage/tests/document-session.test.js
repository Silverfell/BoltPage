import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentSession } from '../src/document-session.js';

const AUTOSAVE_MS = 700;

// Lets every already-resolved promise continuation run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A session over an in-memory disk, buffer and clock. `hold.write` /
 * `hold.format` make those calls wait in `held` until the test releases them.
 */
function harness({ kind = 'markdown', disk = '' } = {}) {
    const h = {
        disk,
        text: '',
        statuses: [],
        replacements: [],
        writes: 0,
        activeWrites: 0,
        maxActiveWrites: 0,
        failWrites: false,
        failReads: false,
        failFormat: false,
        hold: { write: false, format: false },
        held: [],
        now: 0,
        timers: [],
    };

    const maybeHold = (what) => (h.hold[what] ? new Promise((resolve) => h.held.push(resolve)) : null);

    h.release = async () => {
        h.held.shift()();
        await settle();
    };

    h.advance = async (ms) => {
        h.now += ms;
        const due = h.timers.filter((t) => t.at <= h.now);
        h.timers = h.timers.filter((t) => t.at > h.now);
        for (const t of due) t.fn();
        await settle();
    };

    // The user types: the buffer changes, then the editor reports it.
    h.type = (text) => {
        h.text = text;
        return h.session.edited();
    };

    h.session = createDocumentSession({
        kind,
        read: async () => {
            if (h.failReads) throw new Error('read failed');
            return h.disk;
        },
        write: async (content) => {
            h.writes += 1;
            h.activeWrites += 1;
            h.maxActiveWrites = Math.max(h.maxActiveWrites, h.activeWrites);
            try {
                await maybeHold('write');
                if (h.failWrites) throw new Error('disk full');
                h.disk = content;
            } finally {
                h.activeWrites -= 1;
            }
        },
        formatJson: async (content) => {
            await maybeHold('format');
            if (h.failFormat) throw new Error('not json');
            return JSON.stringify(JSON.parse(content), null, 2);
        },
        buffer: {
            getText: () => h.text,
            setText: (text, why) => {
                h.text = text;
                h.replacements.push(why);
                // CodeMirror's update listener fires for a dispatched change.
                h.session.edited();
            },
        },
        clock: {
            setTimeout: (fn, ms) => {
                const timer = { fn, at: h.now + ms };
                h.timers.push(timer);
                return timer;
            },
            clearTimeout: (timer) => {
                h.timers = h.timers.filter((t) => t !== timer);
            },
        },
        onStatus: (label) => h.statuses.push(label),
        onWrite: () => h.statuses.push('(write)'),
    });
    return h;
}

async function loaded(options) {
    const h = harness(options);
    h.text = await h.session.load();
    return h;
}

// The editor window's close handler: destroy the window only when the save
// says the buffer is on disk. Returns what the disk held at that moment.
async function closeWindow(h) {
    if ((await h.session.save()) !== 'persisted') return { destroyed: false };
    return { destroyed: true, diskAtDestroy: h.disk };
}

test('close during an in-flight save keeps edits typed after that save started', async () => {
    // The bug: saveFile answered true ("deferred") to a save requested while
    // another was in flight, so the close handler destroyed the window with
    // the newer edits still only in the buffer.
    const h = await loaded({ disk: 'one' });
    h.hold.write = true;
    h.type('one two');
    await h.advance(AUTOSAVE_MS); // autosave starts writing 'one two' and stalls
    assert.equal(h.held.length, 1);

    h.type('one two three'); // typed after that save started
    const closing = closeWindow(h);
    await h.release(); // first write lands
    h.hold.write = false;
    if (h.held.length) await h.release();
    const closed = await closing;

    assert.equal(closed.destroyed, true);
    assert.equal(closed.diskAtDestroy, 'one two three');
});

test('load returns the text for the buffer and leaves the session clean', async () => {
    const h = harness({ disk: 'a\r\nb\r\n' });
    assert.equal(await h.session.load(), 'a\nb\n');
    assert.equal(h.session.eol, 'CRLF');
    assert.equal(h.session.dirty, false);

    const lf = await loaded({ disk: 'a\nb\n' });
    assert.equal(lf.session.eol, 'LF');
});

test('load rejects when the read fails', async () => {
    const h = harness();
    h.failReads = true;
    await assert.rejects(h.session.load(), /read failed/);
});

test('an edit marks the buffer dirty and a save clears it', async () => {
    const h = await loaded({ disk: 'a' });
    assert.equal(h.type('ab'), true);
    h.type('abc');
    assert.equal(h.session.dirty, true);
    assert.deepEqual(h.statuses, ['Modified']);

    assert.equal(await h.session.save(), 'persisted');
    assert.equal(h.disk, 'abc');
    assert.equal(h.session.dirty, false);
    assert.deepEqual(h.statuses, ['Modified', 'Saved', '(write)']);
});

test('saving a clean buffer writes nothing', async () => {
    const h = await loaded({ disk: 'a' });
    assert.equal(await h.session.save(), 'persisted');
    assert.equal(h.writes, 0);
});

test('autosave waits for a pause in typing', async () => {
    const h = await loaded({ disk: '' });
    h.type('a');
    await h.advance(AUTOSAVE_MS - 1);
    h.type('ab');
    await h.advance(AUTOSAVE_MS - 1);
    assert.equal(h.writes, 0);

    await h.advance(1);
    assert.equal(h.writes, 1);
    assert.equal(h.disk, 'ab');
    assert.equal(h.session.dirty, false);
});

test('an explicit save cancels the pending autosave', async () => {
    const h = await loaded({ disk: '' });
    h.type('a');
    await h.session.save();
    await h.advance(AUTOSAVE_MS);
    assert.equal(h.writes, 1);
});

test('a save requested during a save resolves after its own flush, and writes never overlap', async () => {
    const h = await loaded({ disk: '' });
    h.hold.write = true;
    h.type('a');
    const first = h.session.save();
    await settle();
    h.type('ab');
    let secondResult = null;
    const second = h.session.save().then((result) => {
        secondResult = result;
    });

    await h.release(); // 'a' is on disk, 'ab' is not
    assert.equal(h.disk, 'a');
    assert.equal(secondResult, null);

    await h.release(); // the queued flush
    await second;
    assert.equal(secondResult, 'persisted');
    assert.equal(await first, 'persisted');
    assert.equal(h.disk, 'ab');
    assert.equal(h.maxActiveWrites, 1);
    assert.equal(h.session.dirty, false);
});

test('edits during an autosave write are left to the debounce', async () => {
    const h = await loaded({ disk: '' });
    h.hold.write = true;
    h.type('a');
    await h.advance(AUTOSAVE_MS);
    h.type('ab');
    await h.release();
    assert.equal(h.disk, 'a');
    assert.equal(h.session.dirty, true);
    assert.equal(h.held.length, 0); // no immediate second write
    assert.equal(h.statuses.at(-2), 'Modified');

    h.hold.write = false;
    await h.advance(AUTOSAVE_MS);
    assert.equal(h.disk, 'ab');
    assert.equal(h.session.dirty, false);
});

test('an autosave that comes due during a write is flushed afterwards', async () => {
    const h = await loaded({ disk: '' });
    h.hold.write = true;
    h.type('a');
    await h.advance(AUTOSAVE_MS);
    h.type('ab');
    await h.advance(AUTOSAVE_MS); // due while 'a' is still being written
    assert.equal(h.writes, 1);

    h.hold.write = false;
    await h.release();
    await h.advance(AUTOSAVE_MS);
    assert.equal(h.disk, 'ab');
    assert.equal(h.maxActiveWrites, 1);
});

test('a failed write resolves to failed and keeps the buffer dirty', async () => {
    const h = await loaded({ disk: 'a' });
    h.type('ab');
    h.failWrites = true;
    assert.deepEqual(await closeWindow(h), { destroyed: false });
    assert.equal(h.session.dirty, true);
    assert.equal(h.disk, 'a');
    assert.equal(h.statuses.at(-1), 'Error saving');

    h.failWrites = false;
    assert.equal(await h.session.save(), 'persisted');
    assert.equal(h.disk, 'ab');
});

test('a queued save fails when its flush fails', async () => {
    const h = await loaded({ disk: '' });
    h.hold.write = true;
    h.type('a');
    const first = h.session.save();
    await settle();
    h.type('ab');
    const second = h.session.save();
    await h.release();
    h.failWrites = true;
    await h.release();
    assert.equal(await second, 'failed');
    assert.equal(await first, 'failed');
    assert.equal(h.disk, 'a');
    assert.equal(h.session.dirty, true);
});

test('an external change that equals our own write is ignored', async () => {
    const h = await loaded({ disk: 'a\r\nb' });
    h.type('a\nb\nc');
    await h.session.save();
    assert.equal(h.disk, 'a\r\nb\r\nc');
    h.statuses.length = 0;

    await h.session.externalChange();
    assert.deepEqual(h.statuses, []);
    assert.deepEqual(h.replacements, []);
    assert.equal(h.text, 'a\nb\nc');
});

test('an external change on a clean buffer reloads it', async () => {
    const h = await loaded({ disk: 'a' });
    h.disk = 'x\r\ny';
    await h.session.externalChange();
    assert.equal(h.text, 'x\ny');
    assert.deepEqual(h.replacements, ['reload']);
    assert.deepEqual(h.statuses, ['Reloaded']);
    assert.equal(h.session.eol, 'CRLF');
    assert.equal(h.session.dirty, false);
    assert.equal(h.timers.length, 0); // the reload is not an edit to autosave
});

test('an external change on a dirty buffer keeps the edits and warns once', async () => {
    const h = await loaded({ disk: 'a' });
    h.type('mine');
    h.disk = 'theirs';
    await h.session.externalChange();
    await h.session.externalChange();
    assert.equal(h.text, 'mine');
    assert.equal(h.session.dirty, true);
    assert.deepEqual(h.statuses, ['Modified', 'File changed on disk']);

    // Last writer wins: the next save overwrites the external content.
    assert.equal(await h.session.save(), 'persisted');
    assert.equal(h.disk, 'mine');
});

test('an external change that cannot be read is ignored', async () => {
    const h = await loaded({ disk: 'a' });
    h.failReads = true;
    await h.session.externalChange();
    assert.equal(h.text, 'a');
    assert.deepEqual(h.statuses, []);
});

test('CRLF line endings survive a save', async () => {
    const h = await loaded({ disk: 'a\r\nb\r\n' });
    h.type('a\nb\nc\n');
    await h.session.save();
    assert.equal(h.disk, 'a\r\nb\r\nc\r\n');

    const lf = await loaded({ disk: 'a\nb\n' });
    lf.type('a\nb\nc\n');
    await lf.session.save();
    assert.equal(lf.disk, 'a\nb\nc\n');
});

test('a JSON document is formatted on load and on save', async () => {
    const h = await loaded({ kind: 'json', disk: '{"a":1}' });
    assert.equal(h.text, '{\n  "a": 1\n}');
    assert.equal(h.session.dirty, false);

    h.type('{"a":1,"b":2}');
    assert.equal(await h.session.save(), 'persisted');
    assert.equal(h.disk, '{\n  "a": 1,\n  "b": 2\n}');
    assert.equal(h.text, h.disk);
    assert.deepEqual(h.replacements, ['format']);
    assert.equal(h.session.dirty, false);
    assert.equal(h.timers.length, 0); // the rewrite is not an edit to autosave
});

test('JSON that does not parse is saved as typed', async () => {
    const h = await loaded({ kind: 'json', disk: '{}' });
    h.failFormat = true;
    h.type('{"a":');
    assert.equal(await h.session.save(), 'persisted');
    assert.equal(h.disk, '{"a":');
    assert.deepEqual(h.replacements, []);
});

test('other kinds are never passed through the JSON formatter', async () => {
    const h = await loaded({ kind: 'markdown', disk: '{"a":1}' });
    assert.equal(h.text, '{"a":1}');
    h.type('{"a":2}');
    await h.session.save();
    assert.equal(h.disk, '{"a":2}');
});

test('edits typed while JSON is being formatted are not overwritten', async () => {
    const h = await loaded({ kind: 'json', disk: '{}' });
    h.hold.format = true;
    h.type('{"a":1}');
    const saving = h.session.save();
    await settle();
    h.type('{"a":1,"b":2}'); // typed while the formatter runs
    h.hold.format = false;
    await h.release();
    assert.equal(await saving, 'persisted');
    assert.equal(h.disk, '{\n  "a": 1,\n  "b": 2\n}');
    assert.equal(h.text, h.disk);
});
