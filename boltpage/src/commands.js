// Command table: a window (viewer, editor) declares each command once and gets
// its keyboard shortcuts, menu-event listeners and palette entries from it.
//
//   const commands = createCommands([
//       { id: 'find', keys: 'Mod+F', menu: EVENT_MENU_FIND, label: 'Find…',
//         available: () => currentKind !== 'pdf', action: () => openFindOverlay() },
//       { id: 'palette', keys: 'Mod+K Mod+P', menu: EVENT_MENU_COMMAND_PALETTE,
//         action: () => openPalette() },
//   ], { mac: true, hasFocus: () => document.hasFocus() });
//   setupKeyboardShortcuts(commands.shortcuts);
//   setupChordShortcuts(commands.chords);
//   await commands.listenMenu(listen);
//   createCommandPalette(document.body, commands.paletteActions);
//
// Command fields; only id and action are required:
//   keys       'Mod+Shift+F' (Mod is Cmd/Ctrl), a two-key chord 'Mod+K Mod+P',
//              or an array of either. The first one is the palette hint.
//   native     true when the native menu accelerator serves the binding: it is
//              the hint and is checked for duplicates, but gets no key handler.
//   menu       menu event name that runs the command.
//   needsFocus false lets the menu event run it in an unfocused window.
//   menuDelay  ms to wait after the menu event before the focus check.
//   label      palette label, a string or a function returning one. A command
//              without a label is not in the palette.
//   available  predicate; while it returns false the key and the menu event do
//              nothing (the key is still swallowed) and the palette omits it.
//   listed     predicate for the palette alone, in place of available, for a
//              command whose palette entry and key follow different rules.
//
// Nothing here touches the DOM or Tauri, so the module also loads in Node.

const MODIFIERS = { mod: 'ctrl', shift: 'shift', alt: 'alt' };

function parseStroke(stroke) {
    const parts = stroke.split('+');
    const def = { key: parts.pop().toLowerCase(), ctrl: false, shift: false, alt: false };
    for (const part of parts) {
        const field = MODIFIERS[part.toLowerCase()];
        if (!field) throw new Error(`Unknown modifier "${part}" in key binding "${stroke}"`);
        def[field] = true;
    }
    return def;
}

function strokeId(s) {
    return `${s.key}:${s.ctrl ? 'c' : ''}${s.shift ? 's' : ''}${s.alt ? 'a' : ''}`;
}

function strokeHint(s, mac) {
    const key = s.key[0].toUpperCase() + s.key.slice(1);
    return mac
        ? `${s.ctrl ? '⌘' : ''}${s.alt ? '⌥' : ''}${s.shift ? '⇧' : ''}${key}`
        : `${s.ctrl ? 'Ctrl+' : ''}${s.alt ? 'Alt+' : ''}${s.shift ? 'Shift+' : ''}${key}`;
}

/**
 * Build the three command surfaces from one table.
 * - mac: true for ⌘⇧F style hints, false for Ctrl+Shift+F.
 * - hasFocus: () => boolean, whether this window has focus.
 * Throws when two commands share a key binding or a menu event.
 * Returns { shortcuts, chords, listenMenu(listen), paletteActions() }.
 */
export function createCommands(table, { mac, hasFocus }) {
    const usable = (c) => !c.available || c.available();
    const run = (c) => { if (usable(c)) return c.action(); };

    const shortcuts = [];
    const prefixes = new Map();
    const hints = new Map();
    const boundKeys = new Map();
    const boundMenus = new Map();

    for (const c of table) {
        const bindings = [].concat(c.keys || []).map(b => b.split(' ').map(parseStroke));
        for (const strokes of bindings) {
            const id = strokes.map(strokeId).join(' ');
            if (boundKeys.has(id)) {
                throw new Error(`Key binding of "${c.id}" is already bound to "${boundKeys.get(id)}": ${strokes.map(s => strokeHint(s, false)).join(' ')}`);
            }
            boundKeys.set(id, c.id);
            if (c.native) continue;
            const action = () => run(c);
            const [first, second] = strokes;
            if (!second) {
                shortcuts.push({ ...first, action });
                continue;
            }
            let prefix = prefixes.get(strokeId(first));
            if (!prefix) {
                prefix = { key1: first.key, ctrl1: first.ctrl, shift1: first.shift, alt1: first.alt, secondKeys: [] };
                prefixes.set(strokeId(first), prefix);
            }
            prefix.secondKeys.push({ key2: second.key, ctrl2: second.ctrl, shift2: second.shift, alt2: second.alt, action });
        }
        if (bindings.length) hints.set(c, bindings[0].map(s => strokeHint(s, mac)).join(' '));

        if (c.menu) {
            if (boundMenus.has(c.menu)) {
                throw new Error(`Menu event "${c.menu}" of "${c.id}" is already bound to "${boundMenus.get(c.menu)}"`);
            }
            boundMenus.set(c.menu, c.id);
        }
    }

    // More modifiers first, so Cmd+Shift+F is tried before Cmd+F.
    const modifierCount = (s) => s.ctrl + s.shift + s.alt;
    shortcuts.sort((a, b) => modifierCount(b) - modifierCount(a));

    function listenMenu(listen) {
        return Promise.all(table.filter(c => c.menu).map(c => {
            const fire = () => {
                if (c.needsFocus !== false && !hasFocus()) return;
                return run(c);
            };
            return listen(c.menu, c.menuDelay ? () => { setTimeout(fire, c.menuDelay); } : fire);
        }));
    }

    function paletteActions() {
        return table.filter(c => c.label && (c.listed ? c.listed() : usable(c))).map(c => ({
            id: c.id,
            label: typeof c.label === 'function' ? c.label() : c.label,
            hint: hints.get(c),
            run: () => c.action(),
        }));
    }

    return { shortcuts, chords: [...prefixes.values()], listenMenu, paletteActions };
}
