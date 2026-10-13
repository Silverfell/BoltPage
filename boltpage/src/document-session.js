// Document session: the one owner of an editor window's file state - load,
// dirty flag, serialized saves, the autosave timer, save-echo suppression,
// EOL round-trip and JSON normalization. No CodeMirror, DOM or Tauri in here;
// the window passes those in.
//
// How a window uses it:
//   const session = createDocumentSession({ kind, read, write, formatJson,
//                                           buffer, clock, onStatus, onWrite });
//   const doc = await session.load();   // text for the initial editor state
//   session.edited();                   // from the editor's change listener
//   await session.save();               // Cmd+S, and before closing the window
//   session.externalChange();           // from the file watcher event
//   session.dirty, session.eol          // for the UI
//
// save() resolves to 'persisted' only when the buffer text is on disk, else to
// 'failed'. A window may be destroyed only after 'persisted'.

import { KIND_JSON } from './constants.js';

const AUTOSAVE_DELAY_MS = 700; // Slightly longer debounce for smoother typing

/**
 * @param {object} deps
 * @param {string} deps.kind - document kind (KIND_* from constants.js)
 * @param {() => Promise<string>} deps.read - raw file text
 * @param {(content: string) => Promise<void>} deps.write - rejects on failure
 * @param {(content: string) => Promise<string>} deps.formatJson - rejects on invalid JSON
 * @param {{getText: () => string, setText: (text: string, why: 'format'|'reload') => void}} deps.buffer
 * @param {{setTimeout: Function, clearTimeout: Function}} deps.clock
 * @param {(label: string) => void} deps.onStatus - status badge text
 * @param {() => void} deps.onWrite - a write reached the disk
 */
export function createDocumentSession({ kind, read, write, formatJson, buffer, clock, onStatus, onWrite }) {
    // Called unbound so the browser's own timer functions can be passed as-is.
    const { setTimeout: startTimer, clearTimeout: stopTimer } = clock;

    let dirty = false;
    let eol = 'LF';
    // Last known on-disk content, LF-normalized. Used to tell our own save echo
    // (and no-op rewrites) apart from genuine external modifications.
    let diskText = '';
    // True while the session itself replaces the buffer, so edited() doesn't
    // mark it dirty or schedule a save for it.
    let replacing = false;
    let autosaveTimer = null;
    // Serialize saves: one flush at a time, so two writes never overlap (which
    // could land out of order). `flushing` is the promise of the one in flight.
    let flushing = null;
    // A save() caller is waiting on the flush in flight.
    let awaited = false;
    let autosaveDue = false;

    function replaceBuffer(text, why) {
        replacing = true;
        try {
            buffer.setText(text, why);
        } finally {
            replacing = false;
        }
    }

    function scheduleAutosave() {
        if (autosaveTimer) stopTimer(autosaveTimer);
        autosaveTimer = startTimer(() => {
            autosaveTimer = null;
            if (flushing) autosaveDue = true;
            else if (dirty) flushing = flush();
        }, AUTOSAVE_DELAY_MS);
    }

    /**
     * Normalize raw file content for the buffer. The buffer is kept
     * LF-normalized; the on-disk EOL mode is remembered and re-applied on save.
     */
    async function ingest(raw) {
        eol = raw.includes('\r\n') ? 'CRLF' : 'LF';
        const normalized = raw.replace(/\r\n/g, '\n');
        diskText = normalized;
        if (kind !== KIND_JSON) return normalized;
        try {
            return await formatJson(normalized);
        } catch (e) {
            console.warn('JSON pretty formatting failed; showing raw:', e);
            return normalized;
        }
    }

    async function load() {
        return ingest(await read());
    }

    /** The editor reports a buffer change. False when it was the session's own. */
    function edited() {
        if (replacing) return false;
        if (!dirty) {
            dirty = true;
            onStatus('Modified');
        }
        scheduleAutosave();
        return true;
    }

    // One write of the current buffer. True when it reached the disk.
    async function writeOnce() {
        let content = buffer.getText();

        // For JSON files, normalize to the same pretty-sorted format as preview
        if (kind === KIND_JSON) {
            try {
                const formatted = await formatJson(content);
                // Rewrite the buffer only when formatting changed it, and only
                // if nothing was typed meanwhile: then the formatted text is
                // written and the newer buffer stays dirty for the next write.
                if (formatted !== content) {
                    if (buffer.getText() === content) replaceBuffer(formatted, 'format');
                    content = formatted;
                }
            } catch (e) {
                console.warn('JSON pretty formatting failed on save; saving raw content:', e);
            }
        }

        try {
            // Buffer text is LF-normalized; re-apply the file's on-disk EOL mode.
            await write(eol === 'CRLF' ? content.replace(/\n/g, '\r\n') : content);
        } catch (err) {
            // REASON: any write failure means the same thing here - not on disk.
            console.error('Failed to save file:', err);
            onStatus('Error saving');
            return false;
        }
        diskText = content;
        // Only clear the dirty flag when the buffer still matches what we
        // wrote; edits that landed during the write keep it set so the next
        // save persists them instead of seeing a falsely-clean buffer.
        dirty = buffer.getText() !== content;
        onStatus(dirty ? 'Modified' : 'Saved');
        onWrite();
        return true;
    }

    // Writes until the buffer is on disk or a write fails. An autosave pass
    // stops after one write when nobody is waiting: edits that landed during
    // it are left to the debounce ('unflushed', which save() callers never
    // see because waiting on a flush makes it keep writing).
    async function flush() {
        try {
            for (;;) {
                if (!(await writeOnce())) return 'failed';
                if (!dirty) return 'persisted';
                if (!awaited) return 'unflushed';
            }
        } finally {
            flushing = null;
            awaited = false;
            // An autosave came due while this flush was in flight.
            if (autosaveDue) {
                autosaveDue = false;
                if (dirty) scheduleAutosave();
            }
        }
    }

    /**
     * Resolves to 'persisted' once the buffer text is on disk (or was already),
     * or to 'failed' when a write failed. A call made while a flush is in
     * flight resolves only after the buffer as it is now has been written too.
     */
    function save() {
        if (autosaveTimer) {
            stopTimer(autosaveTimer);
            autosaveTimer = null;
        }
        if (!flushing && !dirty) return Promise.resolve('persisted');
        awaited = true;
        if (!flushing) flushing = flush();
        return flushing;
    }

    /**
     * The watched file changed on disk. Distinguish three cases:
     * - our own save echo / no-op rewrite (disk matches diskText): ignore;
     * - clean buffer: reload from disk;
     * - dirty buffer: keep the user's edits, surface a persistent warning.
     *   Autosave still wins on the next write (deliberate last-writer-wins, but
     *   visible instead of a silent clobber).
     */
    async function externalChange() {
        let raw;
        try {
            raw = await read();
        } catch (err) {
            // REASON: a file that cannot be re-read leaves the buffer as it is.
            console.error('Failed to re-read externally changed file:', err);
            return;
        }
        const normalized = raw.replace(/\r\n/g, '\n');
        if (normalized === diskText) return;
        if (dirty) {
            diskText = normalized;
            onStatus('File changed on disk');
            return;
        }
        replaceBuffer(await ingest(raw), 'reload');
        onStatus('Reloaded');
    }

    return {
        load,
        edited,
        save,
        externalChange,
        get dirty() {
            return dirty;
        },
        get eol() {
            return eol;
        },
    };
}
