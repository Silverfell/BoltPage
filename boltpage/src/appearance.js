// Synced appearance: theme, font size, document/editor font family and toolbar
// density, shared by every window.
//
// A window builds one instance with its Tauri invoke/listen and one effect per
// pref, then calls start() once at boot:
//
//     const appearance = createAppearance({ invoke, listen, effects: {
//         theme: (theme) => { ... },            // also: fontSize, toolbarDensity,
//     } });                                     //       documentFont, editorFont
//     const prefs = await appearance.start();   // raw get_preferences, or null
//     appearance.set('theme', 'dark');          // a change made in this window
//     appearance.get('fontSize');
//
// An effect is everything the window does to show a value (DOM, menu state,
// re-measure); it runs after the value is stored, whether the value came from
// boot, from this window or from a peer. Only set() saves and broadcasts.

import {
    EVENT_THEME_CHANGED,
    EVENT_FONT_SIZE_CHANGED,
    EVENT_FONT_FAMILY_CHANGED,
    EVENT_TOOLBAR_DENSITY_CHANGED,
} from './constants.js';
import {
    clampFontSize,
    DEFAULT_DOCUMENT_FONT_ID,
    DEFAULT_EDITOR_FONT_ID,
} from './shared.js';

const DEFAULT_THEME = 'drac';

function normalizeDensity(v) {
    return v === 'icon' || v === 'label' ? v : 'icon-label';
}

// key: field in the stored preferences. broadcast: the Rust command and its
// arguments (src-tauri/src/menu.rs broadcast_*).
const PREFS = {
    theme: {
        key: 'theme',
        normalize: (v) => v || DEFAULT_THEME,
        broadcast: (theme) => ['broadcast_theme_change', { theme }],
    },
    fontSize: {
        key: 'font_size',
        normalize: clampFontSize,
        broadcast: (fontSize) => ['broadcast_font_size_change', { fontSize }],
    },
    toolbarDensity: {
        key: 'toolbar_density',
        normalize: normalizeDensity,
        broadcast: (density) => ['broadcast_toolbar_density_change', { density }],
    },
    documentFont: {
        key: 'document_font_family',
        normalize: (v) => v || DEFAULT_DOCUMENT_FONT_ID,
        broadcast: (id) => ['broadcast_font_family_change', { payload: { document: id, editor: null } }],
    },
    editorFont: {
        key: 'editor_font_family',
        normalize: (v) => v || DEFAULT_EDITOR_FONT_ID,
        broadcast: (id) => ['broadcast_font_family_change', { payload: { document: null, editor: id } }],
    },
};

// Event name -> the prefs its payload carries. A null value means "not in this
// event" (the font-family payload names one family at a time).
const EVENTS = [
    [EVENT_THEME_CHANGED, (p) => ({ theme: p })],
    [EVENT_FONT_SIZE_CHANGED, (p) => ({ fontSize: p })],
    [EVENT_TOOLBAR_DENSITY_CHANGED, (p) => ({ toolbarDensity: p })],
    [EVENT_FONT_FAMILY_CHANGED, (p) => ({ documentFont: p?.document, editorFont: p?.editor })],
];

export function createAppearance({ invoke, listen, effects }) {
    const values = {};

    // Store the values that differ, then run their effects, so an effect that
    // reads another pref through get() never sees a half-applied set.
    function apply(incoming) {
        const changed = [];
        for (const [name, raw] of Object.entries(incoming)) {
            if (raw == null) continue;
            const value = PREFS[name].normalize(raw);
            if (value === values[name]) continue;
            values[name] = value;
            changed.push(name);
        }
        for (const name of changed) effects[name]?.(values[name]);
        return changed;
    }

    // Apply the stored prefs (defaults when they cannot be read) without saving
    // or broadcasting, then follow changes made in other windows. An event
    // carrying the value already held is this window's own echo and is ignored.
    async function start() {
        let prefs = null;
        try {
            prefs = await invoke('get_preferences');
        } catch (err) {
            console.error('Failed to load preferences:', err);
        }
        const stored = {};
        for (const [name, pref] of Object.entries(PREFS)) {
            stored[name] = pref.normalize(prefs?.[pref.key]);
        }
        apply(stored);
        await Promise.all(EVENTS.map(([event, read]) =>
            listen(event, (e) => { apply(read(e.payload)); })));
        return prefs;
    }

    // A change made in this window: apply, save once, tell the other windows.
    // Resolves when the save and the broadcast have settled.
    function set(name, value) {
        if (apply({ [name]: value }).length === 0) return Promise.resolve();
        const pref = PREFS[name];
        const next = values[name];
        return Promise.all([
            invoke('save_preference_key', { key: pref.key, value: next })
                .catch(err => console.error(`Failed to save ${pref.key} preference:`, err)),
            invoke(...pref.broadcast(next))
                .catch(err => console.error(`Failed to broadcast ${pref.key} change:`, err)),
        ]);
    }

    return { start, get: (name) => values[name], set };
}
