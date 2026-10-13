import test from 'node:test';
import assert from 'node:assert/strict';
import { diffKeys, collectRenderTargets, createPreviewPatcher } from '../src/preview-patcher.js';

// --- diffKeys ---

test('diffKeys: identical lists are all prefix', () => {
    assert.deepEqual(diffKeys(['a', 'b', 'c'], ['a', 'b', 'c']), { prefix: 3, suffix: 0 });
});

test('diffKeys: empty lists', () => {
    assert.deepEqual(diffKeys([], []), { prefix: 0, suffix: 0 });
    assert.deepEqual(diffKeys([], ['a']), { prefix: 0, suffix: 0 });
    assert.deepEqual(diffKeys(['a'], []), { prefix: 0, suffix: 0 });
});

test('diffKeys: one changed key in the middle', () => {
    assert.deepEqual(diffKeys(['a', 'b', 'c'], ['a', 'x', 'c']), { prefix: 1, suffix: 1 });
});

test('diffKeys: insertion and deletion keep both ends', () => {
    assert.deepEqual(diffKeys(['a', 'c'], ['a', 'b', 'c']), { prefix: 1, suffix: 1 });
    assert.deepEqual(diffKeys(['a', 'b', 'c'], ['a', 'c']), { prefix: 1, suffix: 1 });
});

test('diffKeys: append and prepend', () => {
    assert.deepEqual(diffKeys(['a', 'b'], ['a', 'b', 'c']), { prefix: 2, suffix: 0 });
    assert.deepEqual(diffKeys(['b', 'c'], ['a', 'b', 'c']), { prefix: 0, suffix: 2 });
});

test('diffKeys: nothing in common', () => {
    assert.deepEqual(diffKeys(['a', 'b'], ['x', 'y', 'z']), { prefix: 0, suffix: 0 });
});

test('diffKeys: suffix never overlaps the prefix on repeated keys', () => {
    assert.deepEqual(diffKeys(['a', 'a'], ['a', 'a', 'a']), { prefix: 2, suffix: 0 });
    assert.deepEqual(diffKeys(['a', 'a', 'a'], ['a', 'a']), { prefix: 2, suffix: 0 });
    assert.deepEqual(diffKeys(['a', 'b', 'a'], ['a']), { prefix: 1, suffix: 0 });
});

test('diffKeys: a null old key matches nothing and stops the run', () => {
    assert.deepEqual(diffKeys([null], [null]), { prefix: 0, suffix: 0 });
    assert.deepEqual(diffKeys(['a', null, 'c'], ['a', 'b', 'c']), { prefix: 1, suffix: 1 });
    assert.deepEqual(diffKeys([null, 'b', 'c'], ['a', 'b', 'c']), { prefix: 0, suffix: 2 });
});

// --- Patch orchestration over fake nodes ---
// The fakes cover only what the patcher touches: childNodes, removeChild,
// insertBefore, replaceChildren, and the two selectors it queries.

function matchesSelector(el, selector) {
    if (selector === '[id]') return !!el.id;
    return selector.split(', ').includes(el.tagName.toLowerCase());
}

function descendants(el, selector, out = []) {
    for (const c of el.children) {
        if (matchesSelector(c, selector)) out.push(c);
        descendants(c, selector, out);
    }
    return out;
}

function el(tag, text = '', { id = '', children = [] } = {}) {
    return {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        id,
        textContent: text,
        children,
        outerHTML: `<${tag} id="${id}">${text}${children.map(c => c.outerHTML).join('')}</${tag}>`,
        matches(selector) { return matchesSelector(this, selector); },
        querySelectorAll(selector) { return descendants(this, selector); },
    };
}

function textNode(text) {
    return { nodeType: 3, textContent: text };
}

function makeContainer() {
    return {
        childNodes: [],
        get children() { return this.childNodes.filter(n => n.nodeType === 1); },
        removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); },
        insertBefore(n, ref) {
            const at = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
            this.childNodes.splice(at, 0, n);
        },
        replaceChildren(...nodes) { this.childNodes = nodes; },
        querySelectorAll(selector) { return descendants(this, selector); },
    };
}

/** `html` is the node list itself: the fake parser hands it straight back. */
function setup() {
    const container = makeContainer();
    const log = [];
    const enhanced = [];
    const patcher = createPreviewPatcher({
        container,
        parse: nodes => nodes,
        enhancers: [
            async (els) => { enhanced.push(['math', els]); },
            async (els) => { enhanced.push(['mermaid', els]); },
            async () => { throw new Error('enhancer failures are swallowed'); },
        ],
        find: {
            beforePatch: () => log.push('find:before'),
            afterPatch: () => log.push('find:after'),
        },
        onOutlineChanged: () => log.push('outline'),
        onMetricsInvalidated: () => log.push('metrics'),
    });
    return { container, patcher, log, enhanced };
}

test('collectRenderTargets: roots and descendants, element or array scope', () => {
    const inner = el('span', 'x', { id: 'inner' });
    const a = el('p', '', { id: 'a', children: [inner] });
    const b = el('p', 'no id');
    assert.deepEqual(collectRenderTargets([a, b], '[id]'), [a, inner]);
    assert.deepEqual(collectRenderTargets(a, '[id]'), [a, inner]);
});

test('patch: first render inserts everything, keyed, enhanced and reported', () => {
    const { container, patcher, log, enhanced } = setup();
    const h = el('h1', 'Title');
    const p = el('p', 'one');
    const t = textNode('\n');
    const result = patcher.patch([h, t, p]);

    assert.deepEqual(result, { full: true });
    assert.deepEqual(container.childNodes, [h, t, p]);
    // Text nodes are inserted but never handed to enhancers.
    assert.deepEqual(enhanced, [['math', [h, p]], ['mermaid', [h, p]]]);
    assert.deepEqual(log, ['find:before', 'metrics', 'find:after', 'outline']);
});

test('patch: a middle edit replaces one node and keeps the others by identity', () => {
    const { container, patcher, log, enhanced } = setup();
    const a = el('p', 'a'), b = el('p', 'b'), c = el('p', 'c');
    patcher.patch([el('h1', 'T'), a, b, c]);
    const h = container.childNodes[0];
    log.length = 0;
    enhanced.length = 0;

    const b2 = el('p', 'b edited');
    const result = patcher.patch([el('h1', 'T'), el('p', 'a'), b2, el('p', 'c')]);

    assert.deepEqual(result, { full: false });
    assert.equal(container.childNodes.length, 4);
    assert.equal(container.childNodes[0], h);
    assert.equal(container.childNodes[1], a);
    assert.equal(container.childNodes[2], b2);
    assert.equal(container.childNodes[3], c);
    assert.deepEqual(enhanced, [['math', [b2]], ['mermaid', [b2]]]);
    // Headings unchanged: no outline callback.
    assert.deepEqual(log, ['find:before', 'metrics', 'find:after']);
});

test('patch: identical html changes nothing and enhances nothing', () => {
    const { container, patcher, log, enhanced } = setup();
    const a = el('p', 'a'), b = el('p', 'b');
    patcher.patch([a, b]);
    log.length = 0;
    enhanced.length = 0;

    assert.deepEqual(patcher.patch([el('p', 'a'), el('p', 'b')]), { full: false });
    assert.deepEqual(container.childNodes, [a, b]);
    assert.deepEqual(enhanced, []);
    assert.deepEqual(log, ['find:before', 'metrics', 'find:after']);
});

test('patch: deletion and append keep the untouched nodes', () => {
    const { container, patcher } = setup();
    const a = el('p', 'a'), b = el('p', 'b'), c = el('p', 'c');
    patcher.patch([a, b, c]);

    patcher.patch([el('p', 'a'), el('p', 'c')]);
    assert.deepEqual(container.childNodes, [a, c]);

    const d = el('p', 'd');
    patcher.patch([el('p', 'a'), el('p', 'c'), d]);
    assert.deepEqual(container.childNodes, [a, c, d]);
});

test('patch: keys are pre-enhancement, so an enhanced node still matches', () => {
    const { container, patcher } = setup();
    const diagram = el('pre', 'graph TD');
    patcher.patch([diagram, el('p', 'a')]);
    // What Mermaid does in place after the patch.
    diagram.outerHTML = '<pre><svg></svg></pre>';

    patcher.patch([el('pre', 'graph TD'), el('p', 'b')]);
    assert.equal(container.childNodes[0], diagram);
});

test('patch: outline callback fires only when the headings change', () => {
    const { patcher, log } = setup();
    patcher.patch([el('h1', 'One'), el('p', 'a')]);
    log.length = 0;

    patcher.patch([el('h1', 'One'), el('p', 'b')]);
    assert.ok(!log.includes('outline'));

    patcher.patch([el('h1', 'Two'), el('p', 'b')]);
    assert.ok(log.includes('outline'));
});

test('patch: a full replacement with the same headings reports the outline only with outlineOnFull', () => {
    const { patcher, log } = setup();
    patcher.patch([el('p', 'a')]);
    log.length = 0;

    assert.deepEqual(patcher.patch([el('p', 'b')]), { full: true });
    assert.ok(!log.includes('outline'));

    assert.deepEqual(patcher.patch([el('p', 'c')], { outlineOnFull: true }), { full: true });
    assert.ok(log.includes('outline'));
});

test('patch: outlineOnFull does not report a partial patch with unchanged headings', () => {
    const { patcher, log } = setup();
    patcher.patch([el('p', 'a'), el('p', 'b')]);
    log.length = 0;

    assert.deepEqual(patcher.patch([el('p', 'a'), el('p', 'c')], { outlineOnFull: true }), { full: false });
    assert.ok(!log.includes('outline'));
});

test('patch: ids of inserted nodes are prefixed once, kept nodes are left alone', () => {
    const { patcher } = setup();
    const inner = el('span', 'x', { id: 'note' });
    const p = el('p', '', { children: [inner] });
    // The Rust render's slug for a heading "MD files".
    const h = el('h2', 'MD files', { id: 'md-files' });
    const plain = el('p', 'no id');
    patcher.patch([h, p, plain]);

    assert.equal(h.id, 'md-md-files');
    assert.equal(inner.id, 'md-note');
    assert.equal(plain.id, '');

    // The heading is kept by key, so it is not prefixed a second time.
    patcher.patch([el('h2', 'MD files', { id: 'md-files' }), el('p', 'changed')]);
    assert.equal(h.id, 'md-md-files');
});

test('swap: replaces everything unkeyed, without enhancers, and always reports the outline', () => {
    const { container, patcher, log, enhanced } = setup();
    patcher.patch([el('p', 'a')]);
    log.length = 0;
    enhanced.length = 0;

    const embed = el('embed');
    patcher.swap([embed]);
    assert.deepEqual(container.childNodes, [embed]);
    assert.deepEqual(enhanced, []);
    assert.deepEqual(log, ['find:before', 'metrics', 'find:after', 'outline']);

    // Swapped-in nodes carry no key: the next patch replaces them even if
    // the html is the same, and the forgotten outline is reported again.
    log.length = 0;
    const embed2 = el('embed');
    assert.deepEqual(patcher.patch([embed2]), { full: true });
    assert.deepEqual(container.childNodes, [embed2]);
    assert.ok(log.includes('outline'));
});
