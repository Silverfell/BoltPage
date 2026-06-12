import {
    SCROLL_SYNC_DEBOUNCE_MS,
    PROGRAMMATIC_SCROLL_TIMEOUT_MS,
    MIN_SCROLL_DELTA_LINES,
    MIN_SCROLL_DELTA_PERCENT,
    LINE_HEIGHT_FALLBACK_MULTIPLIER,
    DEFAULT_FONT_SIZE,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    FIND_TYPE_DEBOUNCE_MS,
    parsePx,
    escapeHtml,
    directoryFromPath,
    kindLabel,
    clampFontSize,
    createFindOverlay,
    updateFindCount,
    nextFindIndex,
    buildFindRegex,
    collectFindMatches,
    applyThemeToDocument,
    applyFontFamily,
    resolveFontStack,
    DEFAULT_DOCUMENT_FONT_ID,
    DEFAULT_EDITOR_FONT_ID,
    setupKeyboardShortcuts,
    setupChordShortcuts,
    createCommandPalette,
    setBadgeState,
} from './shared.js';
import {
    EVENT_FILE_CHANGED,
    EVENT_THEME_CHANGED,
    EVENT_FONT_SIZE_CHANGED,
    EVENT_FONT_FAMILY_CHANGED,
    EVENT_TOOLBAR_DENSITY_CHANGED,
    EVENT_EDITOR_WINDOW_CLOSED,
    EVENT_EDITOR_BUFFER_CHANGED,
    EVENT_SCROLL_SYNC,
    EVENT_MENU_OPEN,
    EVENT_MENU_OPEN_FOLDER,
    EVENT_MENU_CLOSE,
    EVENT_MENU_FIND,
    EVENT_MENU_FIND_NEXT,
    EVENT_MENU_FIND_PREV,
    EVENT_MENU_FIND_USE_SELECTION,
    EVENT_MENU_FIND_REPLACE,
    EVENT_MENU_EXPORT_HTML,
    EVENT_MENU_COMMAND_PALETTE,
    KIND_MARKDOWN,
    KIND_JSON,
    KIND_YAML,
    KIND_TXT,
} from './constants.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

let currentFilePath = null;
// Last path registered with open_tracked_file. Window-created opens are
// registered by Rust, so this is seeded with the label-derived path at boot.
let lastTrackedPath = null;
let currentTheme = 'drac';
let currentKind = KIND_MARKDOWN; // KIND_JSON | KIND_MARKDOWN | KIND_TXT | 'pdf'
let currentPdfUrl = null;
let currentWritable = null;
let isProgrammaticScroll = false;
let scrollDebounce = null;
let contentEl = null; // scrolling container (.content-wrapper)
let findOverlay = null;
let findInput = null;
let findVisible = false;
let currentFontSize = 18;
let updateStatusTimeout = null;
let currentToolbarDensity = 'icon-label';
let currentDocFontId = null;
let currentEdFontId = null;
let commandPalette = null;
let katexReady = null;
let mermaidReady = null;

// Track last synced position to filter micro-scrolls
let lastSyncedLine = null;
let lastSyncedPercent = null;
// Cache offset calculations to avoid repeated DOM walking
let cachedPreMetrics = null;

async function loadPreferences() {
    try {
        const prefs = await invoke('get_preferences');
        applyFontSize(prefs.font_size);
        applyTheme(prefs.theme);
        tocVisible = prefs.toc_visible !== false;
        applyToolbarDensity(normalizeDensity(prefs.toolbar_density), { save: false, broadcast: false });
        currentDocFontId = prefs.document_font_family || DEFAULT_DOCUMENT_FONT_ID;
        currentEdFontId = prefs.editor_font_family || DEFAULT_EDITOR_FONT_ID;
        applyFontFamily({ documentId: currentDocFontId, editorId: currentEdFontId });
        updateViewMenuState();
    } catch (err) {
        console.error('Failed to load preferences:', err);
        applyFontSize(DEFAULT_FONT_SIZE);
        applyTheme('drac');
        applyToolbarDensity('icon-label', { save: false, broadcast: false });
        currentDocFontId = DEFAULT_DOCUMENT_FONT_ID;
        currentEdFontId = DEFAULT_EDITOR_FONT_ID;
        applyFontFamily({ documentId: currentDocFontId, editorId: currentEdFontId });
    }
}

function changeDocumentFont(id) {
    if (!id || id === currentDocFontId) return;
    currentDocFontId = id;
    applyFontFamily({ documentId: id });
    savePreference('document_font_family', id);
    invoke('broadcast_font_family_change', { payload: { document: id, editor: null } })
        .catch(err => console.error('Failed to broadcast document font change:', err));
    updateViewMenuState();
}

function changeEditorFont(id) {
    if (!id || id === currentEdFontId) return;
    currentEdFontId = id;
    applyFontFamily({ editorId: id });
    savePreference('editor_font_family', id);
    invoke('broadcast_font_family_change', { payload: { document: null, editor: id } })
        .catch(err => console.error('Failed to broadcast editor font change:', err));
    updateViewMenuState();
}

function normalizeDensity(v) {
    return v === 'icon' || v === 'label' ? v : 'icon-label';
}

function applyToolbarDensity(density, options = {}) {
    const { save = false, broadcast = false } = options;
    const next = normalizeDensity(density);
    currentToolbarDensity = next;
    document.documentElement.dataset.toolbarDensity = next;
    updateViewMenuState();
    if (save) savePreference('toolbar_density', next);
    if (broadcast) {
        invoke('broadcast_toolbar_density_change', { density: next })
            .catch(err => console.error('Failed to broadcast toolbar density change:', err));
    }
}

async function broadcastThemeChange(theme) {
    try {
        await invoke('broadcast_theme_change', { theme });
    } catch (err) {
        console.error('Failed to broadcast theme change:', err);
    }
}

async function broadcastFontSizeChange(fontSize) {
    try {
        await invoke('broadcast_font_size_change', { fontSize });
    } catch (err) {
        console.error('Failed to broadcast font size change:', err);
    }
}

async function savePreference(key, value) {
    try {
        await invoke('save_preference_key', { key, value });
    } catch (err) {
        console.error('Failed to save preference:', err);
    }
}

function restorePreviewAnchor(anchor) {
    if (!anchor || !contentEl) return;
    if ((anchor.kind === KIND_JSON || anchor.kind === KIND_YAML || anchor.kind === KIND_TXT) && typeof anchor.line === 'number') {
        scrollPreviewToLine(anchor.line);
        return;
    }
    if (typeof anchor.percent === 'number') {
        const scrollableHeight = contentEl.scrollHeight - contentEl.clientHeight;
        if (scrollableHeight > 0) {
            isProgrammaticScroll = true;
            contentEl.scrollTop = anchor.percent * scrollableHeight;
            setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
        }
    }
}

function applyFontSize(fontSize, options = {}) {
    const { save = false, broadcast = false } = options;
    const nextFontSize = clampFontSize(fontSize);
    const anchor = currentFilePath && contentEl ? getTopLineForPreview() : null;
    currentFontSize = nextFontSize;
    document.documentElement.style.setProperty('--document-font-size', `${currentFontSize}px`);
    cachedPreMetrics = null;
    updateViewMenuState();
    requestAnimationFrame(() => restorePreviewAnchor(anchor));
    if (save) savePreference('font_size', currentFontSize);
    if (broadcast) broadcastFontSizeChange(currentFontSize);
}

function changeFontSize(delta) {
    applyFontSize(currentFontSize + delta, { save: true, broadcast: true });
}

function isCurrentFileViewOnly() {
    return currentKind === 'pdf' || (currentFilePath && !isEditableType(currentFilePath));
}

function currentSidebarModeLabel() {
    if (!currentFilePath) return 'Context Rail';
    const headings = document.querySelectorAll('#markdown-content h1, #markdown-content h2, #markdown-content h3, #markdown-content h4, #markdown-content h5, #markdown-content h6');
    return currentKind === KIND_MARKDOWN && headings.length > 0 ? 'Contents Rail' : 'Info Rail';
}


function updateViewMenuState() {
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === currentTheme);
    });

    const railToggle = document.getElementById('rail-toggle-option');
    const railTitle = document.getElementById('rail-toggle-title');
    const railCaption = document.getElementById('rail-toggle-caption');
    const railState = document.getElementById('rail-toggle-state');
    if (!railToggle || !railTitle || !railCaption || !railState) return;

    const railLabel = currentSidebarModeLabel();
    railTitle.textContent = railLabel;
    railCaption.textContent = currentFilePath
        ? (railLabel === 'Contents Rail'
            ? 'Keep the outline and document details visible beside the preview.'
            : 'Keep file details and workflow state visible beside the preview.')
        : 'Remember whether the context panel opens with each document.';
    railState.textContent = tocVisible ? 'On' : 'Off';
    railToggle.classList.toggle('active', tocVisible);
    railToggle.setAttribute('aria-pressed', tocVisible ? 'true' : 'false');

    const fontSizeIndicator = document.getElementById('font-size-indicator');
    const fontSizeDecreaseBtn = document.getElementById('font-size-decrease-btn');
    const fontSizeIncreaseBtn = document.getElementById('font-size-increase-btn');
    if (fontSizeIndicator) fontSizeIndicator.textContent = `${currentFontSize}px`;
    if (fontSizeDecreaseBtn) fontSizeDecreaseBtn.disabled = currentFontSize <= MIN_FONT_SIZE;
    if (fontSizeIncreaseBtn) fontSizeIncreaseBtn.disabled = currentFontSize >= MAX_FONT_SIZE;

    document.querySelectorAll('.density-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.density === currentToolbarDensity);
    });

    document.querySelectorAll('.doc-font-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === currentDocFontId);
    });
    document.querySelectorAll('.ed-font-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === currentEdFontId);
    });
}


function updateExportButtonState() {
    const exportBtn = document.getElementById('export-btn');
    if (!exportBtn) return;
    if (!currentFilePath || currentKind === 'pdf') {
        exportBtn.setAttribute('disabled', 'true');
        exportBtn.title = currentKind === 'pdf'
            ? 'HTML export is unavailable for PDF files'
            : 'Open a file to export HTML';
    } else {
        exportBtn.removeAttribute('disabled');
        exportBtn.title = 'Export HTML (Ctrl+Shift+E)';
    }
}

function updateFindButtonState() {
    const findBtn = document.getElementById('find-btn');
    if (!findBtn) return;
    if (!currentFilePath) {
        findBtn.setAttribute('disabled', 'true');
        findBtn.title = 'Open a file to search';
        return;
    }
    if (currentKind === 'pdf') {
        findBtn.setAttribute('disabled', 'true');
        findBtn.title = 'Search is unavailable for PDF files';
        return;
    }
    findBtn.removeAttribute('disabled');
    findBtn.title = 'Find (Ctrl+F)';
}

function applyTheme(theme) {
    currentTheme = theme;
    applyThemeToDocument(theme);
    savePreference('theme', theme);
    // Ensure syntax CSS for this theme is loaded
    ensureSyntaxCss(theme);
    updateViewMenuState();
    
    // Notify all windows of theme change
    broadcastThemeChange(theme);
}

async function ensureSyntaxCss(theme) {
    try {
        const css = await invoke('get_syntax_css', { theme });
        let styleEl = document.getElementById('syntax-css');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'syntax-css';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = css;
    } catch (err) {
        console.error('Failed to load syntax CSS:', err);
    }
}

function ensureKatex() {
    if (!katexReady) {
        katexReady = new Promise((resolve, reject) => {
            if (window.katex) return resolve(window.katex);
            const s = document.createElement('script');
            s.src = '/assets/vendor/katex/katex.min.js';
            s.onload = () => resolve(window.katex);
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }
    return katexReady;
}

async function renderMath(scope) {
    const nodes = collectRenderTargets(scope, '.math');
    if (!nodes.length) return;
    let katex;
    try { katex = await ensureKatex(); }
    catch (e) { console.error('Failed to load KaTeX:', e); return; }
    for (const el of nodes) {
        const display = el.classList.contains('math-display');
        const src = el.textContent || '';
        try {
            katex.render(src, el, { displayMode: display, throwOnError: false });
        } catch (err) {
            // Leave the original text on failure.
            console.warn('KaTeX render failed for:', src, err);
        }
    }
}

// --- Incremental preview patching ---
// Each top-level preview node is keyed (WeakMap) by a hash of its
// pre-enhancement serialization: KaTeX and Mermaid mutate rendered nodes in
// place, so the live DOM never equals freshly parsed HTML and a direct
// isEqualNode diff would re-render every diagram on every patch.
const previewNodeKeys = new WeakMap();
let lastTocSignature = null;

function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
}

function previewNodeKey(node) {
    return hashString(node.nodeType === Node.ELEMENT_NODE ? node.outerHTML : (node.textContent || ''));
}

function tocSignatureOf(container) {
    return Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map(h => `${h.tagName}\x1f${h.textContent}`)
        .join('\x1e');
}

/**
 * Patch #markdown-content to show `html`, replacing only the changed run of
 * top-level nodes (common prefix/suffix matched by pre-enhancement key; a
 * typing edit yields one contiguous run). Math/Mermaid re-render only inside
 * inserted nodes; scroll is untouched. Returns { full, tocChanged }.
 */
function applyPreviewHtml(html) {
    const container = document.getElementById('markdown-content');
    if (!container) return { full: true, tocChanged: false };
    // Find-highlight spans would distort the keys of old nodes.
    clearFindResults();

    const range = document.createRange();
    range.selectNodeContents(container);
    const fragment = range.createContextualFragment(html);
    const newNodes = Array.from(fragment.childNodes);
    const newKeys = newNodes.map(previewNodeKey);
    const oldNodes = Array.from(container.childNodes);
    const oldKeys = oldNodes.map(n => previewNodeKeys.get(n) ?? null);

    let prefix = 0;
    const maxCommon = Math.min(oldNodes.length, newNodes.length);
    while (prefix < maxCommon && oldKeys[prefix] !== null && oldKeys[prefix] === newKeys[prefix]) {
        prefix++;
    }
    let suffix = 0;
    const maxSuffix = maxCommon - prefix;
    while (
        suffix < maxSuffix
        && oldKeys[oldNodes.length - 1 - suffix] !== null
        && oldKeys[oldNodes.length - 1 - suffix] === newKeys[newNodes.length - 1 - suffix]
    ) {
        suffix++;
    }

    const full = prefix === 0 && suffix === 0;

    for (let i = oldNodes.length - 1 - suffix; i >= prefix; i--) {
        container.removeChild(oldNodes[i]);
    }
    const anchorNode = suffix > 0 ? oldNodes[oldNodes.length - suffix] : null;
    const inserted = [];
    for (let i = prefix; i < newNodes.length - suffix; i++) {
        const n = newNodes[i];
        previewNodeKeys.set(n, newKeys[i]);
        container.insertBefore(n, anchorNode);
        inserted.push(n);
    }

    cachedPreMetrics = null;

    const insertedEls = inserted.filter(n => n.nodeType === Node.ELEMENT_NODE);
    if (insertedEls.length) {
        // fire-and-forget, scoped to what actually changed
        renderMath(insertedEls).catch(() => {});
        renderMermaid(insertedEls).catch(() => {});
    }

    const tocSig = tocSignatureOf(container);
    const tocChanged = tocSig !== lastTocSignature;
    lastTocSignature = tocSig;

    return { full, tocChanged };
}

/** Resolve `scope` (container element or array of inserted elements) to all
 *  descendants-or-self matching `selector`. */
function collectRenderTargets(scope, selector) {
    const roots = Array.isArray(scope) ? scope : [scope];
    const out = [];
    for (const root of roots) {
        if (root.matches && root.matches(selector)) out.push(root);
        if (root.querySelectorAll) out.push(...root.querySelectorAll(selector));
    }
    return out;
}

function mermaidThemeForCurrent() {
    return currentTheme === 'light' ? 'default' : 'dark';
}

function ensureMermaid() {
    if (!mermaidReady) {
        mermaidReady = new Promise((resolve, reject) => {
            if (window.mermaid) return resolve(window.mermaid);
            const s = document.createElement('script');
            s.src = '/assets/vendor/mermaid/mermaid.min.js';
            s.onload = () => {
                try {
                    window.mermaid.initialize({
                        startOnLoad: false,
                        theme: mermaidThemeForCurrent(),
                        securityLevel: 'strict',
                    });
                } catch (err) {
                    return reject(err);
                }
                resolve(window.mermaid);
            };
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }
    return mermaidReady;
}

async function renderMermaid(scope) {
    const nodes = collectRenderTargets(scope, 'pre.mermaid');
    if (!nodes.length) return;
    let mermaid;
    try { mermaid = await ensureMermaid(); }
    catch (e) { console.error('Failed to load Mermaid:', e); return; }
    // Stash the diagram source before mermaid replaces it with SVG, so theme
    // changes can restore it and re-render (mermaid.run skips nodes that
    // already carry data-processed).
    for (const node of nodes) {
        if (node.dataset.bpSrc === undefined) node.dataset.bpSrc = node.textContent;
    }
    try {
        await mermaid.run({ nodes });
    } catch (err) {
        console.warn('Mermaid run failed:', err);
    }
}

async function reRenderMermaidForTheme() {
    if (!mermaidReady) return;
    try {
        const mermaid = await mermaidReady;
        mermaid.initialize({
            startOnLoad: false,
            theme: mermaidThemeForCurrent(),
            securityLevel: 'strict',
        });
    } catch (err) {
        console.warn('Mermaid re-initialize failed:', err);
    }
    const container = document.getElementById('markdown-content');
    if (!container) return;
    // Restore each diagram's source and clear the processed marker, otherwise
    // mermaid.run skips them and the old theme's SVG stays.
    for (const node of container.querySelectorAll('pre.mermaid')) {
        if (node.dataset.bpSrc !== undefined) {
            node.removeAttribute('data-processed');
            node.textContent = node.dataset.bpSrc;
        }
    }
    await renderMermaid(container);
}

async function exportHtml() {
    if (!currentFilePath) return;
    if (currentKind === 'pdf') return;
    try {
        const documentFontStack = currentDocFontId
            ? resolveFontStack('document', currentDocFontId)
            : null;
        const result = await invoke('save_html_export', {
            path: currentFilePath,
            theme: currentTheme,
            documentFontStack,
        });
        void result;
    } catch (err) {
        console.error('HTML export failed:', err);
    }
}

let tocScrollDebounce = null;
let tocVisible = true;

// --- Workspace folder (file tree + quick switcher) ---
let workspaceFolder = null;
let workspaceTabActive = 'outline'; // 'files' | 'outline'
const expandedDirs = new Set();
let workspaceFileIndex = [];
let quickSwitcherPalette = null;

async function initWorkspace() {
    try {
        workspaceFolder = await invoke('get_workspace_folder');
    } catch (err) {
        console.error('Failed to load workspace folder:', err);
        workspaceFolder = null;
    }
    if (workspaceFolder && !currentFilePath) workspaceTabActive = 'files';
    updateSidebarTabs();
    if (workspaceFolder) {
        // buildTOC owns sidebar visibility; with a workspace it shows the
        // sidebar even before any file is open (Files tab).
        buildTOC();
        await refreshFileTree();
    }
}

function updateSidebarTabs() {
    const tabsRow = document.getElementById('sidebar-tabs');
    const filesTab = document.getElementById('sidebar-tab-files');
    const outlineTab = document.getElementById('sidebar-tab-outline');
    const fileTree = document.getElementById('file-tree');
    const tocNav = document.getElementById('toc-nav');
    if (!tabsRow || !fileTree || !tocNav) return;

    const hasWorkspace = !!workspaceFolder;
    tabsRow.hidden = !hasWorkspace;
    const showFiles = hasWorkspace && workspaceTabActive === 'files';
    fileTree.hidden = !showFiles;
    tocNav.hidden = showFiles;
    if (filesTab) {
        filesTab.classList.toggle('active', showFiles);
        filesTab.setAttribute('aria-selected', showFiles ? 'true' : 'false');
    }
    if (outlineTab) {
        outlineTab.classList.toggle('active', !showFiles);
        outlineTab.setAttribute('aria-selected', showFiles ? 'false' : 'true');
    }
    if (showFiles) {
        const sidebarLabel = document.querySelector('.sidebar-label');
        const sidebarCaption = document.querySelector('.sidebar-caption');
        if (sidebarLabel) sidebarLabel.textContent = 'Files';
        if (sidebarCaption) {
            sidebarCaption.textContent = String(workspaceFolder).split(/[/\\]/).pop() || workspaceFolder;
        }
    }
}

function setSidebarTab(tab) {
    workspaceTabActive = tab;
    updateSidebarTabs();
    // Re-assert the outline labels buildTOC owns when switching back.
    if (tab === 'outline') buildTOC();
}

async function refreshFileTree() {
    const tree = document.getElementById('file-tree');
    if (!tree || !workspaceFolder) return;
    tree.innerHTML = '';
    await renderDirInto(tree, workspaceFolder, 0);
    updateTreeActiveFile();
}

async function renderDirInto(container, dirPath, depth) {
    let entries;
    try {
        entries = await invoke('list_dir', { path: dirPath });
    } catch (err) {
        console.error('Failed to list folder:', err);
        return;
    }
    for (const entry of entries) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'tree-item ' + (entry.is_dir ? 'tree-dir' : 'tree-file');
        row.style.paddingLeft = `${8 + depth * 14}px`;
        row.textContent = entry.name;
        row.title = entry.name;
        row.dataset.path = entry.path;
        container.appendChild(row);
        if (entry.is_dir) {
            const childrenBox = document.createElement('div');
            childrenBox.className = 'tree-children';
            container.appendChild(childrenBox);
            row.addEventListener('click', async () => {
                if (expandedDirs.has(entry.path)) {
                    expandedDirs.delete(entry.path);
                    row.classList.remove('expanded');
                    childrenBox.innerHTML = '';
                } else {
                    expandedDirs.add(entry.path);
                    row.classList.add('expanded');
                    childrenBox.innerHTML = '';
                    await renderDirInto(childrenBox, entry.path, depth + 1);
                    updateTreeActiveFile();
                }
            });
            if (expandedDirs.has(entry.path)) {
                row.classList.add('expanded');
                // Awaiting in the loop keeps fetches bounded to expanded dirs
                // and renders the tree top-down; child boxes are pre-appended
                // so sibling order is stable either way.
                await renderDirInto(childrenBox, entry.path, depth + 1);
            }
        } else {
            row.addEventListener('click', () => openFile(entry.path));
        }
    }
}

function updateTreeActiveFile() {
    document.querySelectorAll('#file-tree .tree-file').forEach(el => {
        el.classList.toggle('active', el.dataset.path === currentFilePath);
    });
}

async function openFolder() {
    try {
        const folder = await invoke('open_folder_dialog');
        if (!folder) return;
        workspaceFolder = folder;
        expandedDirs.clear();
        workspaceTabActive = 'files';
        if (!tocVisible) toggleTOC();
        buildTOC();
        updateSidebarTabs();
        await refreshFileTree();
    } catch (err) {
        console.error('Failed to open folder:', err);
    }
}

async function closeFolder() {
    try {
        await invoke('clear_workspace_folder');
    } catch (err) {
        console.error('Failed to clear workspace folder:', err);
        return;
    }
    workspaceFolder = null;
    expandedDirs.clear();
    workspaceFileIndex = [];
    workspaceTabActive = 'outline';
    const tree = document.getElementById('file-tree');
    if (tree) tree.innerHTML = '';
    updateSidebarTabs();
    buildTOC();
}

// --- Quick switcher (Cmd+O with a workspace folder) ---
async function refreshWorkspaceIndex() {
    try {
        const res = await invoke('list_workspace_files');
        workspaceFileIndex = res.files || [];
        if (res.truncated) {
            console.info(`Workspace index truncated at ${workspaceFileIndex.length} files.`);
        }
    } catch (err) {
        console.error('Failed to index workspace:', err);
        workspaceFileIndex = [];
    }
}

function buildQuickSwitcherActions() {
    const actions = [
        { id: 'browse', label: 'Browse Files…', hint: 'dialog', run: () => openFile() },
    ];
    for (const f of workspaceFileIndex) {
        actions.push({ id: f.path, label: f.name, run: () => openFile(f.path) });
    }
    return actions;
}

function ensureQuickSwitcher() {
    if (quickSwitcherPalette) return quickSwitcherPalette;
    quickSwitcherPalette = createCommandPalette(document.body, buildQuickSwitcherActions);
    return quickSwitcherPalette;
}

/** Cmd+O / File > Open: fuzzy switcher when a workspace is set, dialog otherwise. */
async function openFileSmart() {
    if (!workspaceFolder) {
        openFile();
        return;
    }
    await refreshWorkspaceIndex();
    ensureQuickSwitcher().open();
}

function buildTOC() {
    const tocNav = document.getElementById('toc-nav');
    const tocSidebar = document.getElementById('toc-sidebar');
    const tocOpenBtn = document.getElementById('toc-open-btn');
    const sidebarLabel = document.querySelector('.sidebar-label');
    const sidebarCaption = document.querySelector('.sidebar-caption');
    if (!tocNav) return;

    tocNav.innerHTML = '';

    if (!currentFilePath) {
        // With a workspace folder the sidebar stays useful (Files tab) even
        // before any file is open.
        if (workspaceFolder) {
            if (tocVisible) {
                if (tocSidebar) tocSidebar.classList.add('show');
                if (tocOpenBtn) tocOpenBtn.hidden = true;
            } else {
                if (tocSidebar) tocSidebar.classList.remove('show');
                if (tocOpenBtn) tocOpenBtn.hidden = false;
            }
            updateViewMenuState();
            updateSidebarTabs();
            return;
        }
        if (tocSidebar) tocSidebar.classList.remove('show');
        if (tocOpenBtn) tocOpenBtn.hidden = true;
        updateViewMenuState();
        return;
    }

    const headings = document.querySelectorAll('#markdown-content h1, #markdown-content h2, #markdown-content h3, #markdown-content h4, #markdown-content h5, #markdown-content h6');
    const isMarkdownWithHeadings = currentKind === KIND_MARKDOWN && headings.length > 0;

    if (sidebarLabel) sidebarLabel.textContent = isMarkdownWithHeadings ? 'Contents' : 'Document';
    if (sidebarCaption) sidebarCaption.textContent = isMarkdownWithHeadings ? 'Markdown outline' : 'Document details';

    if (tocVisible) {
        if (tocSidebar) tocSidebar.classList.add('show');
        if (tocOpenBtn) tocOpenBtn.hidden = true;
    } else {
        if (tocSidebar) tocSidebar.classList.remove('show');
        if (tocOpenBtn) tocOpenBtn.hidden = false;
    }
    updateViewMenuState();
    // When the Files tab is active its labels override the outline's.
    updateSidebarTabs();

    if (!isMarkdownWithHeadings) {
        return;
    }

    headings.forEach((heading, i) => {
        const level = parseInt(heading.tagName[1], 10);
        const link = document.createElement('a');
        link.className = 'toc-link';
        link.textContent = heading.textContent;
        link.style.paddingLeft = ((level - 1) * 12) + 'px';
        link.dataset.index = i;
        link.addEventListener('click', (e) => {
            e.preventDefault();
            scrollContentToHeading(heading);
        });
        tocNav.appendChild(link);
    });
}

/**
 * Scroll .content-wrapper so the heading sits near the top, but never past
 * scrollHeight - clientHeight. `scrollIntoView({block:'start'})` was
 * over-scrolling in Wry/WebKit for short trailing sections, leaving a large
 * empty region below the last visible content.
 */
function scrollContentToHeading(heading) {
    if (!contentEl || !heading) return;
    const wrapRect = contentEl.getBoundingClientRect();
    const headRect = heading.getBoundingClientRect();
    const desired = headRect.top - wrapRect.top + contentEl.scrollTop - 8;
    const maxScroll = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
    const target = Math.min(Math.max(0, desired), maxScroll);
    isProgrammaticScroll = true;
    contentEl.scrollTo({ top: target, behavior: 'smooth' });
    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
}

function updateActiveTOCLink() {
    const tocNav = document.getElementById('toc-nav');
    if (!tocNav || !tocNav.children.length) return;

    const headings = document.querySelectorAll('#markdown-content h1, #markdown-content h2, #markdown-content h3, #markdown-content h4, #markdown-content h5, #markdown-content h6');
    if (!headings.length) return;

    const wrapper = document.querySelector('.content-wrapper');
    if (!wrapper) return;
    const wrapperTop = wrapper.getBoundingClientRect().top;

    let activeIndex = 0;
    for (let i = 0; i < headings.length; i++) {
        const rect = headings[i].getBoundingClientRect();
        if (rect.top - wrapperTop <= 8) {
            activeIndex = i;
        } else {
            break;
        }
    }

    const links = tocNav.querySelectorAll('.toc-link');
    links.forEach((link, i) => {
        link.classList.toggle('active', i === activeIndex);
    });

    // Scroll the active link into view within the sidebar
    const activeLink = links[activeIndex];
    if (activeLink) {
        const sidebar = document.getElementById('toc-sidebar');
        const linkTop = activeLink.offsetTop;
        const sidebarScroll = sidebar.scrollTop;
        const sidebarHeight = sidebar.clientHeight;
        if (linkTop < sidebarScroll || linkTop > sidebarScroll + sidebarHeight - 30) {
            activeLink.scrollIntoView({ block: 'nearest' });
        }
    }
}

function toggleTOC() {
    const sidebar = document.getElementById('toc-sidebar');
    const tocOpenBtn = document.getElementById('toc-open-btn');
    if (currentFilePath && sidebar) {
        sidebar.classList.toggle('show');
        tocVisible = sidebar.classList.contains('show');
    } else {
        tocVisible = !tocVisible;
    }
    if (tocOpenBtn) tocOpenBtn.hidden = tocVisible;
    savePreference('toc_visible', tocVisible);
    updateViewMenuState();
}

async function openFile(filePath) {
    if (!filePath) {
        filePath = await invoke('open_file_dialog');
        if (!filePath) return;
    }
    
    try {
        // Register in-window opens (welcome recents, dialog, workspace tree)
        // before rendering: open_tracked_file grants recents access and keeps
        // open_windows / session / recents tracking correct for this window.
        if (filePath !== lastTrackedPath) {
            try {
                await invoke('open_tracked_file', { path: filePath });
            } catch (e) {
                console.error('Failed to register file open:', e);
            }
            lastTrackedPath = filePath;
        }

        const lowerPath = String(filePath).toLowerCase();
        if (lowerPath.endsWith('.pdf')) currentKind = 'pdf';
        else if (lowerPath.endsWith('.json')) currentKind = KIND_JSON;
        else if (lowerPath.endsWith('.yaml') || lowerPath.endsWith('.yml')) currentKind = KIND_YAML;
        else if (lowerPath.endsWith('.txt')) currentKind = KIND_TXT;
        else currentKind = KIND_MARKDOWN;

        // Preserve scroll anchor if reloading same file
        let anchor = null;
        if (currentKind !== 'pdf' && currentFilePath && currentFilePath === filePath && contentEl) {
            anchor = getTopLineForPreview();
        }
        let html;
        let usedPdf = false;
        if (currentKind === 'pdf') {
            try {
                const b64 = await invoke('read_file_bytes_b64', { path: filePath });
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const blob = new Blob([bytes], { type: 'application/pdf' });
                if (currentPdfUrl) {
                    try { URL.revokeObjectURL(currentPdfUrl); } catch {}
                    currentPdfUrl = null;
                }
                const url = URL.createObjectURL(blob);
                currentPdfUrl = url;
                html = `<embed class="pdf-embed" src="${url}" type="application/pdf" />`;
                usedPdf = true;
            } catch (e) {
                console.error('Failed to load PDF:', e);
                const msg = typeof e === 'string' ? e : (e && e.message) ? e.message : 'Failed to open PDF';
                html = `<div class="markdown-body"><pre style="color: var(--danger, #c00); white-space: pre-wrap;">${escapeHtml(String(msg))}</pre></div>`;
            }
        } else {
            try {
                html = await invoke('render_file_to_html', { path: filePath, theme: currentTheme });
            } catch (e) {
                console.error('Failed to render file:', e);
                const msg = typeof e === 'string' ? e : (e && e.message) ? e.message : 'Failed to render file';
                html = `<div class="markdown-body"><pre style="color: var(--danger, #c00); white-space: pre-wrap;">${escapeHtml(String(msg))}</pre></div>`;
            }
        }

        currentFilePath = filePath;
        let patchResult = { full: true, tocChanged: true };
        if (usedPdf) {
            // PDFs keep the simple full swap; nothing in them is patchable.
            clearFindResults();
            const container = document.getElementById('markdown-content');
            const range = document.createRange();
            range.selectNodeContents(container);
            container.replaceChildren(range.createContextualFragment(html));
            cachedPreMetrics = null;
            lastTocSignature = null;
        } else {
            // Patch only the changed top-level blocks; math/mermaid re-render
            // inside the patch, scoped to inserted nodes.
            patchResult = applyPreviewHtml(html);
        }
        // Toggle PDF layout mode
        if (usedPdf) {
            document.body.classList.add('pdf-mode');
        } else {
            document.body.classList.remove('pdf-mode');
        }
        // Ensure link interception remains active after content swap (non-PDF only)
        if (!usedPdf) attachLinkInterceptor();
        // Update edit button availability based on file writability
        currentWritable = await updateEditButtonState();
        updateFindButtonState();
        updateExportButtonState();
        // Rebuild table of contents on full swaps (file/kind switches drive
        // sidebar visibility and labels) or when the heading outline changed.
        if (usedPdf || patchResult.full || patchResult.tocChanged) {
            buildTOC();
        }
        updateTreeActiveFile();
        // Restore scroll position only after a full swap; patches leave the
        // scroll untouched and the percent-based anchor would jolt it.
        if (anchor && patchResult.full) {
            if ((anchor.kind === KIND_JSON || anchor.kind === KIND_YAML || anchor.kind === KIND_TXT) && typeof anchor.line === 'number') {
                scrollPreviewToLine(anchor.line);
            } else if (typeof anchor.percent === 'number') {
                const scrollableHeight = contentEl.scrollHeight - contentEl.clientHeight;
                if (scrollableHeight > 0) {
                    isProgrammaticScroll = true;
                    contentEl.scrollTop = anchor.percent * scrollableHeight;
                    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
                }
            }
        }

        // Ensure window title reflects the opened file (overrides default index.html title)
        try {
            const base = (String(currentFilePath).split(/[/\\]/).pop()) || '';
            if (base) {
                await appWindow.setTitle(`BoltPage - ${base}`);
            }
        } catch (e) {
            console.warn('Failed to set window title:', e);
        }

        // Show the window only if it's not yet visible (first load)
        try {
            const visible = await appWindow.isVisible();
            if (!visible) {
                await invoke('show_window', { windowLabel: appWindow.label });
            }
        } catch (err) {
            console.error('Failed to show window:', err);
        }
        
        // Start file watching
        await startFileWatcher();
        
    } catch (err) {
        console.error('[DEBUG] Failed to open file:', err);
    }
}

function getPreAndMetrics() {
    // Return cached metrics if available and DOM hasn't changed
    if (cachedPreMetrics && cachedPreMetrics.pre && cachedPreMetrics.pre.isConnected) {
        return cachedPreMetrics;
    }

    let pre = null;
    if (currentKind === KIND_JSON || currentKind === KIND_YAML) {
        pre = document.querySelector('#markdown-content .highlight pre');
    } else if (currentKind === KIND_TXT) {
        pre = document.querySelector('#markdown-content pre.plain-text');
    }
    if (!pre) {
        cachedPreMetrics = null;
        return null;
    }
    const cs = window.getComputedStyle(pre);
    let lh = parsePx(cs.lineHeight);
    if (!lh) {
        lh = LINE_HEIGHT_FALLBACK_MULTIPLIER * parsePx(cs.fontSize || '16');
    }
    // compute pre's top relative to the scrolling container
    const preTop = offsetTopWithin(contentEl, pre);
    cachedPreMetrics = { pre, lineHeight: lh, preTop };
    return cachedPreMetrics;
}

function getTopLineForPreview() {
    if (currentKind === KIND_JSON || currentKind === KIND_YAML || currentKind === KIND_TXT) {
        const m = getPreAndMetrics();
        if (!m) return null;
        const offset = Math.max(0, contentEl.scrollTop - m.preTop);
        const line = Math.floor(offset / m.lineHeight) + 1;
        return { kind: currentKind, line };
    }
    // Fallback: percent scroll for markdown
    const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
    const percent = Math.max(0, Math.min(1, contentEl.scrollTop / maxScroll));
    return { kind: KIND_MARKDOWN, percent };
}

function scrollPreviewToLine(line) {
    const m = getPreAndMetrics();
    if (!m) return;
    const y = m.preTop + (Math.max(1, line) - 1) * m.lineHeight;
    isProgrammaticScroll = true;
    contentEl.scrollTop = y;
    setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
}

function offsetTopWithin(container, el) {
    let y = 0;
    let node = el;
    while (node && node !== container) {
        y += node.offsetTop || 0;
        node = node.offsetParent;
    }
    return y;
}

async function refreshFile() {
    if (currentFilePath) {
        await openFile(currentFilePath);
        // Clear the refresh indicator
        document.getElementById('refresh-indicator').classList.remove('show');
    }
}

// Make refreshFile available globally for editor to call
window.refreshFile = refreshFile;

// --- On-type preview from editor buffers ---
let bufferRenderBusy = false;
let bufferRenderPending = null;

async function renderBufferToPreview(kind, content) {
    // Single-flight with latest-pending: renders can't interleave, and only
    // the newest buffered keystroke matters.
    if (bufferRenderBusy) {
        bufferRenderPending = { kind, content };
        return;
    }
    bufferRenderBusy = true;
    try {
        let html;
        if (kind === KIND_JSON) {
            // Mid-typing JSON/YAML is usually invalid; keep the last good render.
            try { html = await invoke('parse_json_with_theme', { content, theme: currentTheme }); }
            catch (_) { return; }
        } else if (kind === KIND_YAML) {
            try { html = await invoke('parse_yaml_with_theme', { content, theme: currentTheme }); }
            catch (_) { return; }
        } else if (kind === KIND_TXT) {
            // Same shape render_file_to_html emits for txt.
            html = `<div class="markdown-body"><pre class="plain-text">${escapeHtml(content)}</pre></div>`;
        } else {
            html = await invoke('parse_markdown_with_theme', { content, theme: currentTheme });
        }
        const result = applyPreviewHtml(html);
        if (result.tocChanged) buildTOC();
    } catch (err) {
        console.warn('On-type preview render failed:', err);
    } finally {
        bufferRenderBusy = false;
        if (bufferRenderPending) {
            const next = bufferRenderPending;
            bufferRenderPending = null;
            renderBufferToPreview(next.kind, next.content);
        }
    }
}

function toggleThemeMenu() {
    const menu = document.getElementById('theme-menu');
    menu.classList.toggle('show');
}

async function openEditor() {
    if (!currentFilePath) return;
    // Block if file type isn't editable
    if (!isEditableType(currentFilePath)) return;
    // Block if file is not writable
    try {
        const writable = await invoke('is_writable', { path: currentFilePath });
        if (!writable) return;
    } catch (_) {
        return;
    }
    
    try {
        await invoke('open_editor_window', { 
            filePath: currentFilePath,
            previewWindow: appWindow.label
        });
    } catch (err) {
        console.error('Failed to open editor:', err);
    }
}

async function fetchRecents() {
    const recentList = document.querySelector('.recent-list');
    if (!recentList) return;
    const welcome = document.querySelector('.welcome-message');
    const welcomeVisible = !!welcome && welcome.isConnected && welcome.offsetParent !== null;
    if (!welcomeVisible) {
        recentList.setAttribute('hidden', '');
        return;
    }
    let files = [];
    try {
        files = await invoke('get_recent_files');
    } catch (err) {
        console.error('Failed to load recent files:', err);
        return;
    }
    if (!Array.isArray(files) || files.length === 0) {
        recentList.setAttribute('hidden', '');
        renderRecentItems(recentList, []);
        return;
    }
    recentList.removeAttribute('hidden');
    renderRecentItems(recentList, files);
}

function renderRecentItems(container, files) {
    const existing = container.querySelectorAll('.recent-item');
    existing.forEach(el => el.remove());
    const frag = document.createDocumentFragment();
    for (const f of files) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'recent-item';
        item.dataset.path = f.path;
        const name = document.createElement('span');
        name.className = 'ri-name';
        name.textContent = f.display_name || f.path;
        const dir = document.createElement('span');
        dir.className = 'ri-path';
        dir.textContent = f.directory || '';
        item.appendChild(name);
        item.appendChild(dir);
        item.addEventListener('click', () => openFile(f.path));
        frag.appendChild(item);
    }
    container.appendChild(frag);
}

async function createNewMarkdownFile() {
    try {
        const windowLabel = await invoke('create_new_markdown_file');
        return windowLabel || null;
    } catch (err) {
        console.error('Failed to create new file:', err);
        return null;
    }
}

async function updateEditButtonState() {
    const editBtn = document.getElementById('edit-btn');
    if (!editBtn) return null;
    if (!currentFilePath) {
        editBtn.setAttribute('disabled', 'true');
        editBtn.title = 'Open a file to edit';
        return null;
    }
    // Disable for non-editable types
    if (!isEditableType(currentFilePath)) {
        editBtn.setAttribute('disabled', 'true');
        editBtn.title = 'This file type is view-only';
        return false;
    }
    try {
        const writable = await invoke('is_writable', { path: currentFilePath });
        if (writable) {
            editBtn.removeAttribute('disabled');
            editBtn.title = 'Edit (Ctrl+E)';
        } else {
            editBtn.setAttribute('disabled', 'true');
            editBtn.title = 'This file is write-protected';
        }
        return writable;
    } catch (e) {
        // On error, be conservative and disable
        editBtn.setAttribute('disabled', 'true');
        editBtn.title = 'Unable to verify edit permission';
        return null;
    }
}

function isEditableType(filePath) {
    const lower = String(filePath).toLowerCase();
    return (
        lower.endsWith('.md') ||
        lower.endsWith('.markdown') ||
        lower.endsWith('.txt') ||
        lower.endsWith('.json') ||
        lower.endsWith('.yaml') ||
        lower.endsWith('.yml')
    );
}

function setupEventListeners() {
    // Toolbar buttons
    document.getElementById('open-btn').addEventListener('click', () => openFile());
    document.getElementById('new-btn').addEventListener('click', createNewMarkdownFile);
    document.getElementById('refresh-btn').addEventListener('click', refreshFile);
    document.getElementById('theme-btn').addEventListener('click', toggleThemeMenu);
    const fontSizeDecreaseBtn = document.getElementById('font-size-decrease-btn');
    const fontSizeIncreaseBtn = document.getElementById('font-size-increase-btn');
    if (fontSizeDecreaseBtn) fontSizeDecreaseBtn.addEventListener('click', () => changeFontSize(-1));
    if (fontSizeIncreaseBtn) fontSizeIncreaseBtn.addEventListener('click', () => changeFontSize(1));
    const railToggleBtn = document.getElementById('rail-toggle-option');
    if (railToggleBtn) railToggleBtn.addEventListener('click', toggleTOC);
    document.getElementById('edit-btn').addEventListener('click', openEditor);
    document.getElementById('export-btn').addEventListener('click', exportHtml);
    const findBtn = document.getElementById('find-btn');
    if (findBtn) findBtn.addEventListener('click', toggleFindOverlay);
    const welcomeOpenBtn = document.getElementById('welcome-open-btn');
    if (welcomeOpenBtn) welcomeOpenBtn.addEventListener('click', () => document.getElementById('open-btn').click());
    const welcomeFolderBtn = document.getElementById('welcome-folder-btn');
    if (welcomeFolderBtn) welcomeFolderBtn.addEventListener('click', openFolder);
    const welcomeNewBtn = document.getElementById('welcome-new-btn');
    if (welcomeNewBtn) welcomeNewBtn.addEventListener('click', () => document.getElementById('new-btn').click());
    const filesTabBtn = document.getElementById('sidebar-tab-files');
    if (filesTabBtn) filesTabBtn.addEventListener('click', () => setSidebarTab('files'));
    const outlineTabBtn = document.getElementById('sidebar-tab-outline');
    if (outlineTabBtn) outlineTabBtn.addEventListener('click', () => setSidebarTab('outline'));
    const tocCloseBtn = document.getElementById('toc-close-btn');
    if (tocCloseBtn) tocCloseBtn.addEventListener('click', toggleTOC);
    const tocOpenBtn = document.getElementById('toc-open-btn');
    if (tocOpenBtn) tocOpenBtn.addEventListener('click', toggleTOC);
    // Theme menu
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
            applyTheme(e.target.dataset.theme);
            toggleThemeMenu();
        });
    });

    // Toolbar density seg buttons
    document.querySelectorAll('.density-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const value = e.currentTarget.dataset.density;
            if (!value || value === currentToolbarDensity) return;
            applyToolbarDensity(value, { save: true, broadcast: true });
        });
    });

    // Typography font-family seg buttons
    document.querySelectorAll('.doc-font-option').forEach(btn => {
        btn.addEventListener('click', (e) => changeDocumentFont(e.currentTarget.dataset.font));
    });
    document.querySelectorAll('.ed-font-option').forEach(btn => {
        btn.addEventListener('click', (e) => changeEditorFont(e.currentTarget.dataset.font));
    });
    
    // Click outside theme menu to close
    document.addEventListener('click', (e) => {
        const themeMenu = document.getElementById('theme-menu');
        const themeBtn = document.getElementById('theme-btn');
        if (!themeMenu.contains(e.target) && e.target !== themeBtn && !themeBtn.contains(e.target)) {
            themeMenu.classList.remove('show');
        }
    });

    
    // Keyboard shortcuts (table-driven; more-specific variants must precede less-specific)
    setupKeyboardShortcuts([
        { key: 'f', ctrl: true, alt: true, action: () => { if (currentKind !== 'pdf') openFindAndReplace(); } },
        { key: 'f', ctrl: true, action: () => { if (currentKind !== 'pdf') openFindOverlay(); } },
        { key: 'g', ctrl: true, shift: true, action: () => { if (currentKind !== 'pdf') findPrevious(); } },
        { key: 'g', ctrl: true, action: () => { if (currentKind !== 'pdf') findNext(); } },
        { key: 'p', ctrl: true, action: () => { if (currentKind !== 'pdf') invoke('print_current_window').catch(err => console.error('Print failed:', err)); } },
        { key: 'o', ctrl: true, shift: true, action: () => openFolder() },
        { key: 'o', ctrl: true, action: () => openFileSmart() },
        { key: 'r', ctrl: true, action: () => refreshFile() },
        { key: 't', ctrl: true, action: () => toggleThemeMenu() },
        { key: 'e', ctrl: true, shift: true, action: () => exportHtml() },
        { key: 'e', ctrl: true, action: () => {
            const sel = window.getSelection && window.getSelection().toString();
            if (sel) { useSelectionForFind(sel); return; }
            openEditor();
        } },
        { key: 'n', ctrl: true, shift: true, action: () => invoke('create_new_window_command').catch(err => console.error('Failed to create new window:', err)) },
        { key: 'n', ctrl: true, action: () => createNewMarkdownFile() },
        { key: 'a', ctrl: true, action: () => selectAllDocument() },
        { key: 'w', ctrl: true, action: () => appWindow.close() },
    ]);

    // Command palette via Cmd+K Cmd+P chord
    setupChordShortcuts([{
        key1: 'k', ctrl1: true,
        secondKeys: [
            { key2: 'p', ctrl2: true, action: () => openPalette() },
        ],
    }]);
}

function buildPaletteActions() {
    const hasFile = !!currentFilePath;
    const isPdf = currentKind === 'pdf';
    const actions = [
        { id: 'open',        label: 'Open File…',            hint: '⌘O',     run: () => openFileSmart() },
        { id: 'open-dialog', label: 'Open File (Dialog)…',                   run: () => openFile() },
        { id: 'open-folder', label: 'Open Folder…',          hint: '⌘⇧O',    run: () => openFolder() },
        { id: 'new',         label: 'New File…',             hint: '⌘N',     run: () => createNewMarkdownFile() },
        { id: 'new-window',  label: 'New Window',            hint: '⌘⇧N',    run: () => invoke('create_new_window_command') },
    ];
    if (workspaceFolder) {
        actions.push({ id: 'close-folder', label: 'Close Folder', run: () => closeFolder() });
    }
    if (hasFile) {
        actions.push({ id: 'refresh', label: 'Refresh',       hint: '⌘R',    run: () => refreshFile() });
    }
    actions.push({ id: 'toggle-sidebar', label: 'Toggle Sidebar',   run: () => toggleTOC() });
    if (hasFile && !isPdf) {
        actions.push({ id: 'find',         label: 'Find…',            hint: '⌘F',   run: () => openFindOverlay() });
        actions.push({ id: 'find-next',    label: 'Find Next',        hint: '⌘G',   run: () => findNext() });
        actions.push({ id: 'find-prev',    label: 'Find Previous',    hint: '⇧⌘G',  run: () => findPrevious() });
        actions.push({ id: 'export-html',  label: 'Export as HTML…',  hint: '⌘⇧E',  run: () => exportHtml() });
        actions.push({ id: 'edit',         label: 'Edit…',                           run: () => openEditor() });
    }
    actions.push({ id: 'print',         label: 'Print…',             hint: '⌘P',  run: () => invoke('print_current_window').catch(console.error) });
    actions.push({ id: 'theme-light',   label: 'Theme: Light',                     run: () => applyTheme('light') });
    actions.push({ id: 'theme-dark',    label: 'Theme: Dark',                      run: () => applyTheme('dark') });
    actions.push({ id: 'theme-drac',    label: 'Theme: Drac',                      run: () => applyTheme('drac') });
    actions.push({ id: 'font-size-inc', label: 'Text Size: Increase',              run: () => changeFontSize(1) });
    actions.push({ id: 'font-size-dec', label: 'Text Size: Decrease',              run: () => changeFontSize(-1) });
    actions.push({ id: 'close',         label: 'Close Window',       hint: '⌘W',   run: () => appWindow.close() });
    return actions;
}

function ensureCommandPalette() {
    if (commandPalette) return commandPalette;
    commandPalette = createCommandPalette(document.body, buildPaletteActions);
    return commandPalette;
}

function openPalette() {
    ensureCommandPalette().open();
}

function selectAllDocument() {
    // Scope Select All to the rendered document; avoid dragging welcome buttons
    // into the selection when no file is open.
    const sel = window.getSelection();
    if (!sel) return;
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
        activeEl.select();
        return;
    }
    if (!currentFilePath) return;
    const container = document.getElementById('markdown-content');
    if (container) {
        const range = document.createRange();
        range.selectNodeContents(container);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

function isAllowedExternalUrl(url) {
    try {
        const u = new URL(url, 'http://placeholder');
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function attachLinkInterceptor() {
    const container = document.getElementById('markdown-content');
    if (!container || container.__linksBound) return;
    container.addEventListener('click', async (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (!a) return;
        // Let multi-click and selection-drags fall through so users can select link text.
        if (e.detail >= 2) return;
        const sel = window.getSelection && window.getSelection().toString();
        if (sel) return;
        const href = a.getAttribute('href') || '';
        e.preventDefault();
        if (isAllowedExternalUrl(href)) {
            try {
                await invoke('plugin:opener|open_url', { url: href });
            } catch (err) {
                console.error('Failed to open external link:', err);
            }
        }
        // Block all other schemes
    });
    container.__linksBound = true;
}

// Preserve HTML formatting when the user copies from the rendered preview.
// Without this, WebKit and WebView2 still copy plain text + HTML via the
// native path, but native Cmd+C on some WebView2 surfaces degrades to text
// only. Attaching a copy handler guarantees rich copy on both platforms.
function attachRichCopyHandler() {
    document.addEventListener('copy', (e) => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) return;
        const container = document.getElementById('markdown-content');
        if (!container) return;
        let anyInside = false;
        for (let i = 0; i < sel.rangeCount; i++) {
            if (container.contains(sel.getRangeAt(i).commonAncestorContainer)) {
                anyInside = true;
                break;
            }
        }
        if (!anyInside) return;
        const wrapper = document.createElement('div');
        for (let i = 0; i < sel.rangeCount; i++) {
            wrapper.appendChild(sel.getRangeAt(i).cloneContents());
        }
        if (!wrapper.childNodes.length) return;
        try {
            e.clipboardData.setData('text/html', wrapper.innerHTML);
            e.clipboardData.setData('text/plain', sel.toString());
            e.preventDefault();
        } catch (_) {
            // Fall back to native behavior if clipboardData is locked down.
        }
    });
}

async function startFileWatcher() {
    if (!currentFilePath) return;
    
    try {
        await invoke('start_file_watcher', {
            filePath: currentFilePath,
            windowLabel: appWindow.label
        });
    } catch (err) {
        console.error('Failed to start file watcher:', err);
    }
}

async function stopFileWatcher() {
    try {
        await invoke('stop_file_watcher', {
            windowLabel: appWindow.label
        });
    } catch (err) {
        console.error('Failed to stop file watcher:', err);
    }
}

// Window size persistence handled in Rust with debounce.


// Initialize app
window.addEventListener('DOMContentLoaded', async () => {
  try {

        setupEventListeners();
        attachLinkInterceptor();
        attachRichCopyHandler();
        await loadPreferences();
        await initWorkspace();
        // Initial button states
        currentWritable = await updateEditButtonState();
        updateFindButtonState();
        updateExportButtonState();
        // Cache content wrapper and attach scroll sync listener
        contentEl = document.querySelector('.content-wrapper');
        attachPreviewScrollSync();

        // Render recent files in the welcome card
        fetchRecents();
        try {
            await appWindow.onFocusChanged(({ payload: focused }) => {
                if (focused) {
                    fetchRecents();
                    // Pick up externally created/removed files (no recursive
                    // watcher in v1; focus refresh matches the recents pattern).
                    if (workspaceFolder && workspaceTabActive === 'files') {
                        refreshFileTree();
                    }
                }
            });
        } catch (err) {
            console.warn('Failed to bind focus-changed listener:', err);
        }

        // Listen for file change events -- auto-refresh the preview
        await listen(EVENT_FILE_CHANGED, async () => {
            const indicator = document.getElementById('refresh-indicator');
            if (indicator) indicator.classList.add('show');
            const pill = document.getElementById('update-status');
            if (pill) setBadgeState(pill, 'Updated', 'accent', false);
            await refreshFile();
            if (pill) {
                clearTimeout(updateStatusTimeout);
                updateStatusTimeout = setTimeout(() => {
                    setBadgeState(pill, '', null, true);
                }, 2500);
            }
        });

        // Render unsaved editor buffers on type (ahead of autosave + watcher).
        await listen(EVENT_EDITOR_BUFFER_CHANGED, (event) => {
            const p = event.payload || {};
            if (!currentFilePath || p.source === appWindow.label) return;
            if (p.file_path !== currentFilePath) return;
            if (currentKind === 'pdf') return;
            renderBufferToPreview(p.kind, p.content);
        });

        // Refresh once when this file's editor window closes, so the preview
        // shows the final saved state and the Edit button re-checks writability.
        // Both the editor's JS (onCloseRequested) and Rust (CloseRequested
        // handler) broadcast for the same close; collapse the pair.
        let lastEditorClosedAt = 0;
        await listen(EVENT_EDITOR_WINDOW_CLOSED, async (event) => {
            const p = event.payload || {};
            if (!currentFilePath || p.file_path !== currentFilePath) return;
            const now = Date.now();
            if (now - lastEditorClosedAt < 500) return;
            lastEditorClosedAt = now;
            await refreshFile();
        });

        // Listen for theme change events from other windows
        await listen(EVENT_THEME_CHANGED, async (event) => {
            // Skip if this window already applied this theme (avoids redundant
            // DOM work from our own broadcast echo).
            if (event.payload === currentTheme) return;
            currentTheme = event.payload;
            applyThemeToDocument(currentTheme);
            await ensureSyntaxCss(currentTheme);
            updateViewMenuState();
            reRenderMermaidForTheme().catch(() => {});
        });

        await listen(EVENT_FONT_SIZE_CHANGED, async (event) => {
            if (Number(event.payload) === currentFontSize) return;
            applyFontSize(event.payload);
        });

        await listen(EVENT_TOOLBAR_DENSITY_CHANGED, (event) => {
            if (event.payload === currentToolbarDensity) return;
            applyToolbarDensity(event.payload, { save: false, broadcast: false });
        });

        await listen(EVENT_FONT_FAMILY_CHANGED, (event) => {
            const p = event.payload || {};
            let changed = false;
            if (p.document && p.document !== currentDocFontId) {
                currentDocFontId = p.document;
                applyFontFamily({ documentId: currentDocFontId });
                changed = true;
            }
            if (p.editor && p.editor !== currentEdFontId) {
                currentEdFontId = p.editor;
                // The viewer doesn't render an editor; still track id so the
                // next broadcast echo is suppressed and the View popover stays
                // in sync with the authoritative pref.
                changed = true;
            }
            if (changed) updateViewMenuState();
        });

        await listen(EVENT_MENU_COMMAND_PALETTE, () => {
            if (!document.hasFocus()) return;
            openPalette();
        });


        // Listen for HTML export menu requests
        await listen(EVENT_MENU_EXPORT_HTML, () => {
            setTimeout(() => {
                if (!document.hasFocus()) return;
                exportHtml();
            }, 50);
        });

        // Listen for menu find
        await listen(EVENT_MENU_FIND, () => {
            if (!document.hasFocus()) return;
            if (currentKind !== 'pdf') openFindOverlay();
        });

        await listen(EVENT_MENU_FIND_NEXT, () => {
            if (!document.hasFocus()) return;
            if (currentKind !== 'pdf') findNext();
        });

        await listen(EVENT_MENU_FIND_PREV, () => {
            if (!document.hasFocus()) return;
            if (currentKind !== 'pdf') findPrevious();
        });

        await listen(EVENT_MENU_FIND_USE_SELECTION, () => {
            if (!document.hasFocus()) return;
            if (currentKind === 'pdf') return;
            const sel = window.getSelection && window.getSelection().toString();
            if (sel) useSelectionForFind(sel);
        });

        await listen(EVENT_MENU_FIND_REPLACE, () => {
            if (!document.hasFocus()) return;
            if (currentKind !== 'pdf') openFindAndReplace();
        });

        // Listen for File > Open menu action (fuzzy switcher with a workspace)
        await listen(EVENT_MENU_OPEN, () => {
            if (!document.hasFocus()) return;
            openFileSmart();
        });

        await listen(EVENT_MENU_OPEN_FOLDER, () => {
            if (!document.hasFocus()) return;
            openFolder();
        });

        // Listen for File > Close Window menu action
        await listen(EVENT_MENU_CLOSE, async () => {
            if (!document.hasFocus()) return;
            await appWindow.close();
        });

        // Listen for scroll sync events from other windows
        await listen(EVENT_SCROLL_SYNC, async (event) => {
            const payload = event.payload || {};
            if (!currentFilePath) return;
            if (payload.source === appWindow.label) return; // ignore self
            if (payload.file_path !== currentFilePath) return;
            if ((payload.kind === KIND_JSON || payload.kind === KIND_YAML || payload.kind === KIND_TXT) && typeof payload.line === 'number') {
                // Scroll preview to the requested line
                scrollPreviewToLine(payload.line);
                lastSyncedLine = payload.line;
            } else if (typeof payload.percent === 'number') {
                // Apply percentage scroll for markdown or others
                const scrollableHeight = contentEl.scrollHeight - contentEl.clientHeight;
                if (scrollableHeight <= 0) return;
                isProgrammaticScroll = true;
                contentEl.scrollTop = payload.percent * scrollableHeight;
                lastSyncedPercent = payload.percent;
                setTimeout(() => { isProgrammaticScroll = false; }, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
            }
        });
        
        // Get file path from window label (single source of truth)
        let filePath = null;
        try {
            filePath = await invoke('get_file_path_from_window_label');
        } catch (err) {
            console.error('Failed to get file path from window label:', err);
        }

        if (filePath) {
            // Rust registered this window-creation open; don't double-track.
            lastTrackedPath = filePath;
            try {
                await openFile(filePath);
            } catch (error) {
                console.error('Failed to open file:', error);
            }
        }
    } catch (error) {
        console.error('[CRITICAL ERROR] Initialization failed:', error);
    }
});

// Clean up on window close
window.addEventListener('beforeunload', () => {
    stopFileWatcher();
    if (currentPdfUrl) {
        try { URL.revokeObjectURL(currentPdfUrl); } catch {}
        currentPdfUrl = null;
    }
    document.body.classList.remove('pdf-mode');
});

// Send scroll position changes to editor (or other listeners)
function attachPreviewScrollSync() {
    if (!contentEl) return;
    contentEl.addEventListener('scroll', () => {
        // Update active TOC link on scroll
        if (tocScrollDebounce) clearTimeout(tocScrollDebounce);
        tocScrollDebounce = setTimeout(updateActiveTOCLink, 50);
        if (!currentFilePath || isProgrammaticScroll || currentKind === 'pdf') return;
        if (scrollDebounce) clearTimeout(scrollDebounce);
        scrollDebounce = setTimeout(async () => {
            const info = getTopLineForPreview();
            if (!info) return;

            // Filter micro-scrolls
            if (typeof info.line === 'number') {
                if (lastSyncedLine !== null && Math.abs(info.line - lastSyncedLine) < MIN_SCROLL_DELTA_LINES) {
                    return;
                }
                lastSyncedLine = info.line;
            } else if (typeof info.percent === 'number') {
                if (lastSyncedPercent !== null && Math.abs(info.percent - lastSyncedPercent) < MIN_SCROLL_DELTA_PERCENT) {
                    return;
                }
                lastSyncedPercent = info.percent;
            }

            const payload = {
                source: appWindow.label,
                file_path: currentFilePath,
                kind: info.kind,
                line: typeof info.line === 'number' ? info.line : null,
                percent: typeof info.percent === 'number' ? info.percent : null,
            };
            try {
                await invoke('broadcast_scroll_sync', { payload });
            } catch (e) {
                console.warn('Failed to broadcast scroll sync:', e);
            }
        }, SCROLL_SYNC_DEBOUNCE_MS);
    });
}

// --- Find overlay (preview) ---
let findSpans = [];
let currentFindIndex = -1;
let findMatchCase = false;
let findWholeWord = false;
let findTypeTimer = null;
let findReturnFocusEl = null;
let findCaseBtn = null;
let findWordBtn = null;

function ensureFindOverlay() {
    if (findOverlay) return;
    const slot = document.getElementById('find-bar-slot');
    const els = createFindOverlay(slot);
    findOverlay = els.overlay;
    findInput = els.input;
    findCaseBtn = els.caseBtn;
    findWordBtn = els.wordBtn;

    findInput.addEventListener('input', () => {
        if (findTypeTimer) clearTimeout(findTypeTimer);
        findTypeTimer = setTimeout(() => runFindFromInput(), FIND_TYPE_DEBOUNCE_MS);
    });
    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) findPrevious(); else findNext();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeFindOverlay();
        }
    });

    const toggle = (btn, setter, refresh = true) => {
        const next = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        btn.classList.toggle('active', next);
        setter(next);
        if (refresh) runFindFromInput();
        findInput.focus();
    };
    findCaseBtn.addEventListener('click', () => toggle(findCaseBtn, v => { findMatchCase = v; }));
    findWordBtn.addEventListener('click', () => toggle(findWordBtn, v => { findWholeWord = v; }));

    findOverlay.querySelector('#find-prev').addEventListener('click', findPrevious);
    findOverlay.querySelector('#find-next').addEventListener('click', findNext);
    findOverlay.querySelector('#find-close').addEventListener('click', closeFindOverlay);
}

function runFindFromInput() {
    if (!findInput) return;
    performFind(findInput.value);
}

function performFind(query) {
    clearFindHighlights();
    findSpans = [];
    currentFindIndex = -1;

    const regex = buildFindRegex(query, { matchCase: findMatchCase, wholeWord: findWholeWord });
    if (!regex) {
        updateFindCountDisplay();
        return;
    }

    const container = document.getElementById('markdown-content');
    if (!container) return;

    // Collect text nodes first so we can mutate without confusing the walker.
    const textNodes = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
            const parent = node.parentNode;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const tag = parent.nodeName;
            if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
            if (parent.classList && parent.classList.contains('find-match')) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    for (const node of textNodes) {
        const matches = collectFindMatches(node.nodeValue, regex);
        if (!matches.length) continue;
        const parent = node.parentNode;
        if (!parent) continue;
        const text = node.nodeValue;
        const frag = document.createDocumentFragment();
        let cursor = 0;
        for (const m of matches) {
            if (m.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
            const span = document.createElement('span');
            span.className = 'find-match';
            span.textContent = text.slice(m.start, m.end);
            frag.appendChild(span);
            findSpans.push(span);
            cursor = m.end;
        }
        if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
        parent.replaceChild(frag, node);
    }

    if (findSpans.length > 0) {
        currentFindIndex = 0;
        setActiveFindSpan();
    }
    updateFindCountDisplay();
}

function setActiveFindSpan() {
    findSpans.forEach((s, i) => s.classList.toggle('active', i === currentFindIndex));
    const span = findSpans[currentFindIndex];
    if (!span) return;
    span.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function findNext() {
    if (findSpans.length === 0) {
        runFindFromInput();
        return;
    }
    currentFindIndex = nextFindIndex(currentFindIndex, findSpans.length, 1);
    setActiveFindSpan();
    updateFindCountDisplay();
}

function findPrevious() {
    if (findSpans.length === 0) {
        runFindFromInput();
        return;
    }
    currentFindIndex = nextFindIndex(currentFindIndex, findSpans.length, -1);
    setActiveFindSpan();
    updateFindCountDisplay();
}

function clearFindHighlights() {
    if (findSpans.length === 0) return;
    const parents = new Set();
    for (const span of findSpans) {
        const parent = span.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parents.add(parent);
    }
    for (const p of parents) p.normalize();
    findSpans = [];
}

function clearFindResults() {
    clearFindHighlights();
    currentFindIndex = -1;
    updateFindCountDisplay();
}

function updateFindCountDisplay() {
    updateFindCount(findOverlay, findSpans, currentFindIndex);
}

function openFindOverlay() {
    ensureFindOverlay();
    if (!findVisible) {
        findReturnFocusEl = (document.activeElement && document.activeElement !== document.body)
            ? document.activeElement
            : null;
    }
    findOverlay.classList.add('show');
    findVisible = true;
    const sel = window.getSelection && window.getSelection().toString();
    if (sel) {
        findInput.value = sel;
        runFindFromInput();
    }
    findInput.focus();
    findInput.select();
}

function openFindAndReplace() {
    // Preview is read-only, so Find-and-Replace collapses to plain Find here.
    openFindOverlay();
}

function useSelectionForFind(selectionText) {
    ensureFindOverlay();
    findInput.value = selectionText;
    runFindFromInput();
    // Do not steal focus: if bar is hidden, keep it hidden so user can keep reading.
    if (findVisible) {
        findInput.focus();
        findInput.select();
    }
}

function toggleFindOverlay() {
    if (findVisible) closeFindOverlay(); else openFindOverlay();
}

function closeFindOverlay() {
    if (!findOverlay) return;
    findOverlay.classList.remove('show');
    findVisible = false;
    if (findTypeTimer) { clearTimeout(findTypeTimer); findTypeTimer = null; }
    clearFindResults();
    const returnTo = findReturnFocusEl;
    findReturnFocusEl = null;
    if (returnTo && document.contains(returnTo) && typeof returnTo.focus === 'function') {
        returnTo.focus();
    } else if (document.activeElement === findInput) {
        findInput.blur();
    }
}
