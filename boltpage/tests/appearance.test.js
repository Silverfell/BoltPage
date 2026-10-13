import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppearance } from '../src/appearance.js';

const STORED = {
    theme: 'light',
    font_size: 20,
    toolbar_density: 'icon',
    document_font_family: 'sans-system',
    editor_font_family: 'mono-sf',
    toc_visible: false,
};

// A window with fake Tauri: invoke records every call, emit delivers an event
// to the registered listeners the way a broadcast from any window would.
function makeWindow({ prefs = STORED, failLoad = false, failCommands = false } = {}) {
    const calls = [];
    const handlers = new Map();
    const applied = [];
    const invoke = async (command, args) => {
        calls.push([command, args]);
        if (command === 'get_preferences') {
            if (failLoad) throw new Error('store unavailable');
            return prefs;
        }
        if (failCommands) throw new Error('command failed');
        return null;
    };
    const listen = async (event, handler) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
    };
    const effects = {};
    for (const name of ['theme', 'fontSize', 'toolbarDensity', 'documentFont', 'editorFont']) {
        effects[name] = (value) => applied.push([name, value]);
    }
    const appearance = createAppearance({ invoke, listen, effects });
    return {
        appearance,
        applied,
        emit: (event, payload) => handlers.get(event)({ payload }),
        saves: () => calls.filter(([command]) => command === 'save_preference_key'),
        broadcasts: () => calls.filter(([command]) => command.startsWith('broadcast_')),
    };
}

test('boot load applies the stored prefs without saving or broadcasting', async () => {
    const w = makeWindow();
    const prefs = await w.appearance.start();

    assert.deepEqual(w.applied, [
        ['theme', 'light'],
        ['fontSize', 20],
        ['toolbarDensity', 'icon'],
        ['documentFont', 'sans-system'],
        ['editorFont', 'mono-sf'],
    ]);
    assert.equal(w.appearance.get('theme'), 'light');
    assert.equal(prefs, STORED);
    assert.deepEqual(w.saves(), []);
    assert.deepEqual(w.broadcasts(), []);
});

test('boot load fills unset prefs with defaults and clamps the font size', async () => {
    const w = makeWindow({ prefs: { theme: 'dark', font_size: 99, toolbar_density: null } });
    await w.appearance.start();

    assert.deepEqual(w.applied, [
        ['theme', 'dark'],
        ['fontSize', 24],
        ['toolbarDensity', 'icon-label'],
        ['documentFont', 'serif-iowan'],
        ['editorFont', 'mono-plex'],
    ]);
    assert.deepEqual(w.saves(), []);
});

test('a failed load applies defaults without writing them', async (t) => {
    t.mock.method(console, 'error', () => {});
    const w = makeWindow({ failLoad: true });
    const prefs = await w.appearance.start();

    assert.equal(prefs, null);
    assert.deepEqual(w.applied, [
        ['theme', 'drac'],
        ['fontSize', 18],
        ['toolbarDensity', 'icon-label'],
        ['documentFont', 'serif-iowan'],
        ['editorFont', 'mono-plex'],
    ]);
    assert.deepEqual(w.saves(), []);
    assert.deepEqual(w.broadcasts(), []);
});

test('set applies, saves once and broadcasts once', async () => {
    const w = makeWindow();
    await w.appearance.start();
    w.applied.length = 0;

    await w.appearance.set('theme', 'dark');
    await w.appearance.set('fontSize', 21);
    await w.appearance.set('toolbarDensity', 'label');
    await w.appearance.set('documentFont', 'mono-plex');
    await w.appearance.set('editorFont', 'mono-jetbrains');

    assert.deepEqual(w.applied, [
        ['theme', 'dark'],
        ['fontSize', 21],
        ['toolbarDensity', 'label'],
        ['documentFont', 'mono-plex'],
        ['editorFont', 'mono-jetbrains'],
    ]);
    assert.deepEqual(w.saves(), [
        ['save_preference_key', { key: 'theme', value: 'dark' }],
        ['save_preference_key', { key: 'font_size', value: 21 }],
        ['save_preference_key', { key: 'toolbar_density', value: 'label' }],
        ['save_preference_key', { key: 'document_font_family', value: 'mono-plex' }],
        ['save_preference_key', { key: 'editor_font_family', value: 'mono-jetbrains' }],
    ]);
    assert.deepEqual(w.broadcasts(), [
        ['broadcast_theme_change', { theme: 'dark' }],
        ['broadcast_font_size_change', { fontSize: 21 }],
        ['broadcast_toolbar_density_change', { density: 'label' }],
        ['broadcast_font_family_change', { payload: { document: 'mono-plex', editor: null } }],
        ['broadcast_font_family_change', { payload: { document: null, editor: 'mono-jetbrains' } }],
    ]);
});

test('set to the value already held does nothing', async () => {
    const w = makeWindow();
    await w.appearance.start();
    w.applied.length = 0;

    await w.appearance.set('theme', 'light');
    await w.appearance.set('fontSize', 20);
    await w.appearance.set('documentFont', null);

    assert.deepEqual(w.applied, []);
    assert.deepEqual(w.saves(), []);
    assert.deepEqual(w.broadcasts(), []);
});

test('set saves and broadcasts the clamped font size', async () => {
    const w = makeWindow();
    await w.appearance.start();

    await w.appearance.set('fontSize', 40);

    assert.equal(w.appearance.get('fontSize'), 24);
    assert.deepEqual(w.saves(), [['save_preference_key', { key: 'font_size', value: 24 }]]);
    assert.deepEqual(w.broadcasts(), [['broadcast_font_size_change', { fontSize: 24 }]]);
});

test('set keeps the applied value when the save and the broadcast fail', async (t) => {
    t.mock.method(console, 'error', () => {});
    const w = makeWindow({ failCommands: true });
    await w.appearance.start();

    await w.appearance.set('theme', 'dark');

    assert.equal(w.appearance.get('theme'), 'dark');
});

test('a peer event applies without saving or re-broadcasting', async () => {
    const w = makeWindow();
    await w.appearance.start();
    w.applied.length = 0;

    w.emit('theme-changed', 'drac');
    w.emit('font-size-changed', 16);
    w.emit('toolbar-density-changed', 'label');
    w.emit('font-family-changed', { document: 'mono-plex', editor: null });
    w.emit('font-family-changed', { document: null, editor: 'mono-jetbrains' });

    assert.deepEqual(w.applied, [
        ['theme', 'drac'],
        ['fontSize', 16],
        ['toolbarDensity', 'label'],
        ['documentFont', 'mono-plex'],
        ['editorFont', 'mono-jetbrains'],
    ]);
    assert.equal(w.appearance.get('editorFont'), 'mono-jetbrains');
    assert.deepEqual(w.saves(), []);
    assert.deepEqual(w.broadcasts(), []);
});

test('the echo of this window\'s own change is ignored', async () => {
    const w = makeWindow();
    await w.appearance.start();

    await w.appearance.set('theme', 'dark');
    await w.appearance.set('fontSize', 22);
    await w.appearance.set('toolbarDensity', 'label');
    await w.appearance.set('editorFont', 'mono-jetbrains');
    w.applied.length = 0;

    w.emit('theme-changed', 'dark');
    w.emit('font-size-changed', 22);
    w.emit('toolbar-density-changed', 'label');
    w.emit('font-family-changed', { document: null, editor: 'mono-jetbrains' });

    assert.deepEqual(w.applied, []);
    assert.equal(w.saves().length, 4);
    assert.equal(w.broadcasts().length, 4);
});

test('an effect sees every stored value, not a half-applied set', async () => {
    const seen = [];
    const appearance = createAppearance({
        invoke: async () => STORED,
        listen: async () => () => {},
        effects: {
            theme: () => seen.push(appearance.get('editorFont')),
        },
    });
    await appearance.start();

    assert.deepEqual(seen, ['mono-sf']);
});
