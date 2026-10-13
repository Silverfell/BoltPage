// Incremental preview patching.
//
// A window creates one patcher for its preview container and sends every
// render through it:
//
//   const patcher = createPreviewPatcher({
//       container,                    // the preview element
//       parse,                        // html => array of top-level nodes
//       enhancers,                    // [math, mermaid, images]: (elements) => Promise
//       find: { beforePatch, afterPatch },
//       onOutlineChanged,             // the heading outline needs rebuilding
//       onMetricsInvalidated,         // cached layout measurements are stale
//   });
//   patcher.patch(html);                           // on-type render
//   patcher.patch(html, { outlineOnFull: true });  // file open or reload
//   patcher.swap(html);                            // PDF: replace everything
//
// Each top-level preview node is keyed (WeakMap) by a hash of its
// pre-enhancement serialization: KaTeX and Mermaid mutate rendered nodes in
// place, so the live DOM never equals freshly parsed HTML and a direct
// isEqualNode diff would re-render every diagram on every patch.

const ELEMENT_NODE = 1;

function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
}

function nodeKey(node) {
    return hashString(node.nodeType === ELEMENT_NODE ? node.outerHTML : (node.textContent || ''));
}

/**
 * Lengths of the common prefix and suffix of two key lists; the suffix never
 * overlaps the prefix. A null key (a node this patcher did not insert)
 * matches nothing.
 */
export function diffKeys(oldKeys, newKeys) {
    const maxCommon = Math.min(oldKeys.length, newKeys.length);
    let prefix = 0;
    while (prefix < maxCommon && oldKeys[prefix] !== null && oldKeys[prefix] === newKeys[prefix]) {
        prefix++;
    }
    let suffix = 0;
    const maxSuffix = maxCommon - prefix;
    while (
        suffix < maxSuffix
        && oldKeys[oldKeys.length - 1 - suffix] !== null
        && oldKeys[oldKeys.length - 1 - suffix] === newKeys[newKeys.length - 1 - suffix]
    ) {
        suffix++;
    }
    return { prefix, suffix };
}

/** Resolve `scope` (container element or array of inserted elements) to all
 *  descendants-or-self matching `selector`. */
export function collectRenderTargets(scope, selector) {
    const roots = Array.isArray(scope) ? scope : [scope];
    const out = [];
    for (const root of roots) {
        if (root.matches && root.matches(selector)) out.push(root);
        if (root.querySelectorAll) out.push(...root.querySelectorAll(selector));
    }
    return out;
}

/** Prefix every document-supplied id with "md-". Called once per inserted
 *  node, and unconditionally: a heading "MD files" arrives as "md-files" and
 *  must become "md-md-files" for its links to find it. */
function prefixIds(scope) {
    for (const el of collectRenderTargets(scope, '[id]')) {
        el.id = 'md-' + el.id;
    }
}

function tocSignatureOf(container) {
    return Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map(h => `${h.tagName}\x1f${h.textContent}`)
        .join('\x1e');
}

export function createPreviewPatcher({ container, parse, enhancers, find, onOutlineChanged, onMetricsInvalidated }) {
    const nodeKeys = new WeakMap();
    let lastTocSignature = null;

    /**
     * Show `html`, replacing only the changed run of top-level nodes (common
     * prefix/suffix matched by pre-enhancement key; a typing edit yields one
     * contiguous run). Enhancers run only inside inserted nodes; scroll is
     * untouched. The outline callback fires when the headings changed, and
     * with `outlineOnFull` also when nothing could be kept. Returns { full }.
     */
    function patch(html, { outlineOnFull = false } = {}) {
        // Find-highlight spans would distort the keys of old nodes.
        find.beforePatch();

        const newNodes = parse(html);
        const newKeys = newNodes.map(nodeKey);
        const oldNodes = Array.from(container.childNodes);
        const oldKeys = oldNodes.map(n => nodeKeys.get(n) ?? null);
        const { prefix, suffix } = diffKeys(oldKeys, newKeys);
        const full = prefix === 0 && suffix === 0;

        for (let i = oldNodes.length - 1 - suffix; i >= prefix; i--) {
            container.removeChild(oldNodes[i]);
        }
        const anchorNode = suffix > 0 ? oldNodes[oldNodes.length - suffix] : null;
        const inserted = [];
        for (let i = prefix; i < newNodes.length - suffix; i++) {
            const n = newNodes[i];
            nodeKeys.set(n, newKeys[i]);
            container.insertBefore(n, anchorNode);
            inserted.push(n);
        }

        onMetricsInvalidated();

        const insertedEls = inserted.filter(n => n.nodeType === ELEMENT_NODE);
        if (insertedEls.length) {
            // Prefix document-supplied ids (heading slugs from the Rust render
            // included) so they can never clobber app element ids.
            prefixIds(insertedEls);
            // fire-and-forget, scoped to what actually changed
            for (const enhance of enhancers) enhance(insertedEls).catch(() => {});
        }
        find.afterPatch();

        const tocSig = tocSignatureOf(container);
        const tocChanged = tocSig !== lastTocSignature;
        lastTocSignature = tocSig;
        if (tocChanged || (full && outlineOnFull)) onOutlineChanged();

        return { full };
    }

    /** Replace everything with `html`, unkeyed and unenhanced (PDF embeds:
     *  nothing in them is patchable). Always reports an outline change. */
    function swap(html) {
        find.beforePatch();
        container.replaceChildren(...parse(html));
        onMetricsInvalidated();
        lastTocSignature = null;
        find.afterPatch();
        onOutlineChanged();
    }

    return { patch, swap };
}
