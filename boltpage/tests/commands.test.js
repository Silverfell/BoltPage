import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommands } from '../src/commands.js';

const focused = { mac: true, hasFocus: () => true };

// Stand-in for Tauri's listen(): records each handler under its event name.
function fakeListen() {
    const handlers = new Map();
    const listen = async (event, handler) => { handlers.set(event, handler); return () => {}; };
    return { handlers, listen };
}

// Table whose actions record their id in `ran`.
function recording(entries) {
    const ran = [];
    return { ran, table: entries.map(e => ({ ...e, action: () => { ran.push(e.id); } })) };
}

const strokes = (shortcuts) => shortcuts.map(s => `${s.ctrl ? 'c' : ''}${s.alt ? 'a' : ''}${s.shift ? 's' : ''}+${s.key}`);

test('duplicate key bindings are rejected', () => {
    const { table } = recording([
        { id: 'find', keys: 'Mod+Shift+F' },
        { id: 'search', keys: 'shift+mod+f' },
    ]);
    assert.throws(() => createCommands(table, focused), /"search" is already bound to "find": Ctrl\+Shift\+F/);
});

test('a duplicate is caught in a second binding, a chord and a native binding', () => {
    const second = recording([{ id: 'a', keys: 'Mod+G' }, { id: 'b', keys: ['Mod+J', 'Mod+G'] }]);
    assert.throws(() => createCommands(second.table, focused), /already bound to "a"/);

    const chord = recording([{ id: 'a', keys: 'Mod+K Mod+P' }, { id: 'b', keys: 'Mod+K Mod+P' }]);
    assert.throws(() => createCommands(chord.table, focused), /already bound to "a"/);

    const native = recording([{ id: 'a', keys: 'Mod+N', native: true }, { id: 'b', keys: 'Mod+N' }]);
    assert.throws(() => createCommands(native.table, focused), /already bound to "a"/);
});

test('same key with different modifiers, and a chord prefix, are not duplicates', () => {
    const { table } = recording([
        { id: 'a', keys: 'Mod+K' },
        { id: 'b', keys: 'Mod+Shift+K' },
        { id: 'c', keys: 'Mod+K Mod+P' },
    ]);
    assert.doesNotThrow(() => createCommands(table, focused));
});

test('duplicate menu events are rejected', () => {
    const { table } = recording([{ id: 'a', menu: 'menu-find' }, { id: 'b', menu: 'menu-find' }]);
    assert.throws(() => createCommands(table, focused), /"menu-find" of "b" is already bound to "a"/);
});

test('an unknown modifier is rejected', () => {
    const { table } = recording([{ id: 'a', keys: 'Cmd+F' }]);
    assert.throws(() => createCommands(table, focused), /Unknown modifier "Cmd"/);
});

test('more-specific shortcuts are ordered before less-specific ones', () => {
    const { table } = recording([
        { id: 'find', keys: 'Mod+F' },
        { id: 'save', keys: 'Mod+S' },
        { id: 'search', keys: 'Mod+Shift+F' },
        { id: 'replace', keys: 'Mod+Alt+F' },
    ]);
    const { shortcuts } = createCommands(table, focused);
    // Equal modifier counts keep table order.
    assert.deepEqual(strokes(shortcuts), ['cs+f', 'ca+f', 'c+f', 'c+s']);
});

test('a shortcut runs its own command', () => {
    const { ran, table } = recording([
        { id: 'find', keys: 'Mod+F' },
        { id: 'search', keys: 'Mod+Shift+F' },
    ]);
    const { shortcuts } = createCommands(table, focused);
    shortcuts.find(s => s.key === 'f' && s.shift).action();
    shortcuts.find(s => s.key === 'f' && !s.shift).action();
    assert.deepEqual(ran, ['search', 'find']);
});

test('the palette hint is derived from the binding', () => {
    const { table } = recording([
        { id: 'find', keys: 'Mod+F', label: 'Find' },
        { id: 'search', keys: 'Mod+Shift+F', label: 'Search' },
        { id: 'replace', keys: 'Mod+Alt+F', label: 'Replace' },
        { id: 'next', keys: ['Mod+G', 'F3'], label: 'Find Next' },
        { id: 'palette', keys: 'Mod+K Mod+P', label: 'Palette' },
        { id: 'new', keys: 'Mod+N', native: true, label: 'New File' },
        { id: 'wrap', label: 'Toggle Word Wrap' },
    ]);
    const hints = (mac) => Object.fromEntries(
        createCommands(table, { mac, hasFocus: () => true }).paletteActions().map(a => [a.id, a.hint]));

    assert.deepEqual(hints(true), {
        find: '⌘F', search: '⌘⇧F', replace: '⌘⌥F', next: '⌘G', palette: '⌘K ⌘P', new: '⌘N', wrap: undefined,
    });
    assert.deepEqual(hints(false), {
        find: 'Ctrl+F', search: 'Ctrl+Shift+F', replace: 'Ctrl+Alt+F', next: 'Ctrl+G',
        palette: 'Ctrl+K Ctrl+P', new: 'Ctrl+N', wrap: undefined,
    });
});

test('every binding gets a handler, except a native one', () => {
    const { ran, table } = recording([
        { id: 'next', keys: ['Mod+G', 'F3'] },
        { id: 'new', keys: 'Mod+N', native: true },
    ]);
    const { shortcuts } = createCommands(table, focused);
    assert.deepEqual(strokes(shortcuts), ['c+g', '+f3']);
    for (const s of shortcuts) s.action();
    assert.deepEqual(ran, ['next', 'next']);
});

test('chords are grouped by prefix in the setupChordShortcuts shape', () => {
    const { ran, table } = recording([
        { id: 'palette', keys: 'Mod+K Mod+P' },
        { id: 'zen', keys: 'Mod+K Z' },
        { id: 'find', keys: 'Mod+F' },
    ]);
    const { chords, shortcuts } = createCommands(table, focused);
    assert.deepEqual(strokes(shortcuts), ['c+f']);
    assert.equal(chords.length, 1);
    const { secondKeys, ...prefix } = chords[0];
    assert.deepEqual(prefix, { key1: 'k', ctrl1: true, shift1: false, alt1: false });
    assert.deepEqual(secondKeys.map(({ action, ...rest }) => rest), [
        { key2: 'p', ctrl2: true, shift2: false, alt2: false },
        { key2: 'z', ctrl2: false, shift2: false, alt2: false },
    ]);
    secondKeys[1].action();
    assert.deepEqual(ran, ['zen']);
});

test('menu events respect the focus guard', async () => {
    let hasFocus = false;
    const { ran, table } = recording([
        { id: 'find', menu: 'menu-find' },
        { id: 'theme', menu: 'menu-theme', needsFocus: false },
        { id: 'save', keys: 'Mod+S' },
    ]);
    const { handlers, listen } = fakeListen();
    await createCommands(table, { mac: true, hasFocus: () => hasFocus }).listenMenu(listen);
    assert.deepEqual([...handlers.keys()], ['menu-find', 'menu-theme']);

    handlers.get('menu-find')();
    handlers.get('menu-theme')();
    assert.deepEqual(ran, ['theme']);

    hasFocus = true;
    handlers.get('menu-find')();
    assert.deepEqual(ran, ['theme', 'find']);
});

test('menuDelay checks focus after the delay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let hasFocus = false;
    const { ran, table } = recording([{ id: 'export', menu: 'menu-export-html', menuDelay: 50 }]);
    const { handlers, listen } = fakeListen();
    await createCommands(table, { mac: true, hasFocus: () => hasFocus }).listenMenu(listen);

    handlers.get('menu-export-html')();
    hasFocus = true;
    t.mock.timers.tick(49);
    assert.deepEqual(ran, []);
    t.mock.timers.tick(1);
    assert.deepEqual(ran, ['export']);

    handlers.get('menu-export-html')();
    hasFocus = false;
    t.mock.timers.tick(50);
    assert.deepEqual(ran, ['export']);
});

test('an unavailable command is skipped by all three surfaces', async () => {
    let available = false;
    const { ran, table } = recording([
        { id: 'find', keys: 'Mod+F', menu: 'menu-find', label: 'Find' },
        { id: 'palette', keys: 'Mod+K Mod+P' },
        { id: 'open', keys: 'Mod+O', menu: 'menu-open', label: 'Open' },
    ]);
    table[0].available = () => available;
    table[1].available = () => available;
    const { handlers, listen } = fakeListen();
    const commands = createCommands(table, focused);
    await commands.listenMenu(listen);
    const press = (key) => commands.shortcuts.find(s => s.key === key).action();

    press('f');
    commands.chords[0].secondKeys[0].action();
    handlers.get('menu-find')();
    assert.deepEqual(ran, []);
    assert.deepEqual(commands.paletteActions().map(a => a.id), ['open']);

    // The predicate is read each time, not once at build.
    available = true;
    press('f');
    commands.chords[0].secondKeys[0].action();
    handlers.get('menu-find')();
    assert.deepEqual(ran, ['find', 'palette', 'find']);
    assert.deepEqual(commands.paletteActions().map(a => a.id), ['find', 'open']);
});

test('listed decides the palette entry alone, and available the key and menu', async () => {
    let listed = false;
    let available = true;
    const { ran, table } = recording([
        { id: 'refresh', keys: 'Mod+R', menu: 'menu-refresh', label: 'Refresh' },
        { id: 'print', keys: 'Mod+P', label: 'Print' },
    ]);
    table[0].listed = () => listed;
    table[1].available = () => available;
    table[1].listed = () => true;
    const { handlers, listen } = fakeListen();
    const commands = createCommands(table, focused);
    await commands.listenMenu(listen);
    const press = (key) => commands.shortcuts.find(s => s.key === key).action();

    // Not listed: the key and the menu event still run it.
    press('r');
    handlers.get('menu-refresh')();
    assert.deepEqual(ran, ['refresh', 'refresh']);
    assert.deepEqual(commands.paletteActions().map(a => a.id), ['print']);

    // Listed but unavailable: only the palette entry runs it.
    listed = true;
    available = false;
    press('p');
    assert.deepEqual(ran, ['refresh', 'refresh']);
    assert.deepEqual(commands.paletteActions().map(a => a.id), ['refresh', 'print']);
    commands.paletteActions()[1].run();
    assert.deepEqual(ran, ['refresh', 'refresh', 'print']);
});

test('palette entries follow table order, run the action and read a label function each time', () => {
    let vim = false;
    const { ran, table } = recording([
        { id: 'save', keys: 'Mod+S', label: 'Save' },
        { id: 'hidden', keys: 'Mod+A' },
        { id: 'vim', label: () => `Vim Mode: ${vim ? 'Off' : 'On'}` },
    ]);
    const { paletteActions } = createCommands(table, focused);
    assert.deepEqual(paletteActions().map(a => [a.id, a.label]), [['save', 'Save'], ['vim', 'Vim Mode: On']]);
    vim = true;
    const actions = paletteActions();
    assert.equal(actions[1].label, 'Vim Mode: Off');
    actions[0].run();
    assert.deepEqual(ran, ['save']);
});

test('shortcut and menu handlers return what the action returns', async () => {
    const table = [{ id: 'close', keys: 'Mod+W', menu: 'menu-close', action: async () => 'closed' }];
    const { handlers, listen } = fakeListen();
    const commands = createCommands(table, focused);
    await commands.listenMenu(listen);
    assert.equal(await commands.shortcuts[0].action(), 'closed');
    assert.equal(await handlers.get('menu-close')(), 'closed');
});
