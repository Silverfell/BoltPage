import {
    LINE_HEIGHT_FALLBACK_MULTIPLIER,
    MIN_FONT_SIZE,
    MAX_FONT_SIZE,
    parsePx,
    escapeHtml,
    directoryFromPath,
    kindFromPath,
    kindLabel,
    nextFindIndex,
    buildFindRegex,
    collectFindMatches,
    applyThemeToDocument,
    applyFontFamily,
    resolveFontStack,
    setupKeyboardShortcuts,
    setupChordShortcuts,
    createCommandPalette,
    setBadgeState,
} from './shared.js';
import {
    EVENT_FILE_CHANGED,
    EVENT_EDITOR_WINDOW_CLOSED,
    EVENT_EDITOR_BUFFER_CHANGED,
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
    KIND_PDF,
} from './constants.js';
import { createPreviewPatcher, collectRenderTargets } from './preview-patcher.js';
import { createScrollSync } from './scroll-sync.js';
import { createAppearance } from './appearance.js';
import { createFindBar } from './find-bar.js';
import { createCommands } from './commands.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

let currentFilePath = null;
// Last path registered with open_tracked_file. Window-created opens are
// registered by Rust, so this is seeded with the initial path at boot.
let lastTrackedPath = null;
let currentKind = KIND_MARKDOWN; // KIND_JSON | KIND_MARKDOWN | KIND_TXT | KIND_PDF
let currentPdfUrl = null;
let currentWritable = null;
let contentEl = null; // scrolling container (.content-wrapper)
let updateStatusTimeout = null;
let commandPalette = null;
let katexReady = null;
let mermaidReady = null;

// Cache offset calculations to avoid repeated DOM walking
let cachedPreMetrics = null;

// Theme, font size, fonts and toolbar density, synced across windows (see
// appearance.js). Each effect is what this window does to show a value.
const appearance = createAppearance({ invoke, listen, effects: {
    theme: async (theme) => {
        applyThemeToDocument(theme);
        updateViewMenuState();
        await ensureSyntaxCss(theme);
        reRenderMermaidForTheme().catch(() => {});
    },
    fontSize: (fontSize) => {
        const anchor = currentFilePath && contentEl ? scrollSync.top() : null;
        document.documentElement.style.setProperty('--document-font-size', `${fontSize}px`);
        cachedPreMetrics = null;
        updateViewMenuState();
        requestAnimationFrame(() => scrollSync.scrollTo(anchor));
    },
    toolbarDensity: (density) => {
        document.documentElement.dataset.toolbarDensity = density;
        updateViewMenuState();
    },
    documentFont: (id) => {
        applyFontFamily({ documentId: id });
        updateViewMenuState();
    },
    editorFont: (id) => {
        applyFontFamily({ editorId: id });
        updateViewMenuState();
    },
} });

async function savePreference(key, value) {
    try {
        await invoke('save_preference_key', { key, value });
    } catch (err) {
        console.error('Failed to save preference:', err);
    }
}

function changeFontSize(delta) {
    appearance.set('fontSize', appearance.get('fontSize') + delta);
}

function isCurrentFileViewOnly() {
    return currentKind === KIND_PDF || (currentFilePath && !isEditableType(currentFilePath));
}

function currentSidebarModeLabel() {
    if (!currentFilePath) return 'Context Rail';
    const headings = document.querySelectorAll('#markdown-content h1, #markdown-content h2, #markdown-content h3, #markdown-content h4, #markdown-content h5, #markdown-content h6');
    return currentKind === KIND_MARKDOWN && headings.length > 0 ? 'Contents Rail' : 'Info Rail';
}


function updateViewMenuState() {
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === appearance.get('theme'));
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
    const fontSize = appearance.get('fontSize');
    if (fontSizeIndicator) fontSizeIndicator.textContent = `${fontSize}px`;
    if (fontSizeDecreaseBtn) fontSizeDecreaseBtn.disabled = fontSize <= MIN_FONT_SIZE;
    if (fontSizeIncreaseBtn) fontSizeIncreaseBtn.disabled = fontSize >= MAX_FONT_SIZE;

    document.querySelectorAll('.density-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.density === appearance.get('toolbarDensity'));
    });

    document.querySelectorAll('.doc-font-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === appearance.get('documentFont'));
    });
    document.querySelectorAll('.ed-font-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.font === appearance.get('editorFont'));
    });
}


function updateExportButtonState() {
    const exportBtn = document.getElementById('export-btn');
    if (!exportBtn) return;
    if (!currentFilePath || currentKind === KIND_PDF) {
        exportBtn.setAttribute('disabled', 'true');
        exportBtn.title = currentKind === KIND_PDF
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
    if (currentKind === KIND_PDF) {
        findBtn.setAttribute('disabled', 'true');
        findBtn.title = 'Search is unavailable for PDF files';
        return;
    }
    findBtn.removeAttribute('disabled');
    findBtn.title = 'Find (Ctrl+F)';
}

async function ensureSyntaxCss(theme) {
    try {
        const css = await invoke('get_syntax_css', { theme });
        let styleEl = document.getElementById('syntax-css');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'syntax-css';
            document.head.appendChild(styleEl);
            // The user stylesheet must stay last in the cascade; this invoke
            // can resolve after ensureCustomCss appended it at boot.
            const userCss = document.getElementById('user-css');
            if (userCss) document.head.appendChild(userCss);
        }
        styleEl.textContent = css;
    } catch (err) {
        console.error('Failed to load syntax CSS:', err);
    }
}

/**
 * Load the user's custom stylesheet into a <style> appended (or re-appended)
 * at the end of <head>, so it always wins the cascade over theme and syntax
 * styles. Reloaded on window focus; editing it externally then switching
 * back picks the changes up.
 */
async function ensureCustomCss() {
    try {
        const css = await invoke('get_custom_css');
        let styleEl = document.getElementById('user-css');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'user-css';
        }
        if (styleEl.textContent !== css) styleEl.textContent = css;
        document.head.appendChild(styleEl);
    } catch (err) {
        console.error('Failed to load custom CSS:', err);
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

// Every preview render goes through the patcher (see preview-patcher.js).
const previewContainer = document.getElementById('markdown-content');
const previewPatcher = createPreviewPatcher({
    container: previewContainer,
    parse: (html) => {
        const range = document.createRange();
        range.selectNodeContents(previewContainer);
        return Array.from(range.createContextualFragment(html).childNodes);
    },
    enhancers: [renderMath, renderMermaid, hydrateLocalImages],
    find: { beforePatch: clearFindHighlights, afterPatch: () => findBar.contentChanged() },
    onOutlineChanged: buildTOC,
    onMetricsInvalidated: () => { cachedPreMetrics = null; },
});

function mermaidThemeForCurrent() {
    return appearance.get('theme') === 'light' ? 'default' : 'dark';
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
    if (currentKind === KIND_PDF) return;
    try {
        const documentFontStack = resolveFontStack('document', appearance.get('documentFont'));
        const result = await invoke('save_html_export', {
            path: currentFilePath,
            theme: appearance.get('theme'),
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
    const searchTab = document.getElementById('sidebar-tab-search');
    const outlineTab = document.getElementById('sidebar-tab-outline');
    const fileTree = document.getElementById('file-tree');
    const searchPanel = document.getElementById('search-panel');
    const tocNav = document.getElementById('toc-nav');
    if (!tabsRow || !fileTree || !tocNav) return;

    const hasWorkspace = !!workspaceFolder;
    tabsRow.hidden = !hasWorkspace;
    const showFiles = hasWorkspace && workspaceTabActive === 'files';
    const showSearch = hasWorkspace && workspaceTabActive === 'search';
    fileTree.hidden = !showFiles;
    if (searchPanel) searchPanel.hidden = !showSearch;
    tocNav.hidden = showFiles || showSearch;
    const setTabState = (tab, active) => {
        if (!tab) return;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
    };
    setTabState(filesTab, showFiles);
    setTabState(searchTab, showSearch);
    setTabState(outlineTab, !showFiles && !showSearch);
    if (showFiles || showSearch) {
        const sidebarLabel = document.querySelector('.sidebar-label');
        const sidebarCaption = document.querySelector('.sidebar-caption');
        if (sidebarLabel) sidebarLabel.textContent = showFiles ? 'Files' : 'Search';
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
    if (tab === 'search') {
        const input = document.getElementById('search-input');
        if (input) { input.focus(); input.select(); }
    }
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
    const searchResults = document.getElementById('search-results');
    if (searchResults) searchResults.innerHTML = '';
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.value = '';
    const searchStatus = document.getElementById('search-status');
    if (searchStatus) searchStatus.hidden = true;
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

// --- Workspace full-text search (Search tab) ---
const SEARCH_TYPE_DEBOUNCE_MS = 250;
let searchTypeTimer = null;
let searchPanelBound = false;
let lastSearchQuery = '';

function initSearchPanel() {
    if (searchPanelBound) return;
    const input = document.getElementById('search-input');
    if (!input) return;
    searchPanelBound = true;
    input.addEventListener('input', () => {
        if (searchTypeTimer) clearTimeout(searchTypeTimer);
        searchTypeTimer = setTimeout(() => runWorkspaceSearch(input.value), SEARCH_TYPE_DEBOUNCE_MS);
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (searchTypeTimer) clearTimeout(searchTypeTimer);
            runWorkspaceSearch(input.value);
        }
    });
}

async function runWorkspaceSearch(query) {
    const results = document.getElementById('search-results');
    const status = document.getElementById('search-status');
    if (!results || !workspaceFolder) return;
    lastSearchQuery = query;
    let res;
    try {
        res = await invoke('search_workspace', { query });
    } catch (err) {
        console.error('Workspace search failed:', err);
        return;
    }
    if (query !== lastSearchQuery) return; // a newer search superseded this one
    results.innerHTML = '';
    const hits = res.hits || [];
    if (status) {
        const trimmed = query.trim();
        if (trimmed.length < 2) {
            status.hidden = true;
        } else {
            status.hidden = false;
            status.textContent = hits.length === 0
                ? 'No matches'
                : `${hits.length} match${hits.length === 1 ? '' : 'es'}${res.truncated ? ' (truncated)' : ''}`;
        }
    }
    const frag = document.createDocumentFragment();
    for (const hit of hits) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'search-hit';
        row.setAttribute('role', 'listitem');
        const loc = document.createElement('span');
        loc.className = 'search-hit-loc';
        loc.textContent = `${hit.name}:${hit.line}`;
        const preview = document.createElement('span');
        preview.className = 'search-hit-preview';
        preview.textContent = hit.preview;
        row.appendChild(loc);
        row.appendChild(preview);
        row.title = `${hit.name}:${hit.line}`;
        row.addEventListener('click', async () => {
            await openFile(hit.path);
            if (query.trim()) findBar.open(query.trim());
        });
        frag.appendChild(row);
    }
    results.appendChild(frag);
}

/** Cmd+Shift+F: reveal the sidebar's Search tab (workspace required). */
function openWorkspaceSearch() {
    if (!workspaceFolder) {
        console.info('Workspace search needs an open folder (Cmd+Shift+O).');
        return;
    }
    if (!tocVisible) {
        toggleTOC();
        // With no file open toggleTOC only flips the pref; buildTOC applies
        // the sidebar's show class (same pattern as openFolder).
        buildTOC();
    }
    setSidebarTab('search');
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
    scrollSync.programmatic(() => contentEl.scrollTo({ top: target, behavior: 'smooth' }));
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
        // window registry / session / recents tracking correct for this window.
        if (filePath !== lastTrackedPath) {
            try {
                await invoke('open_tracked_file', { path: filePath });
            } catch (e) {
                console.error('Failed to register file open:', e);
            }
            lastTrackedPath = filePath;
        }

        currentKind = kindFromPath(filePath) || KIND_MARKDOWN;

        // Preserve scroll anchor if reloading same file
        let anchor = null;
        if (currentKind !== KIND_PDF && currentFilePath && currentFilePath === filePath && contentEl) {
            anchor = scrollSync.top();
        }
        let html;
        let usedPdf = false;
        if (currentKind === KIND_PDF) {
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
                html = await invoke('render_file_to_html', { path: filePath });
            } catch (e) {
                console.error('Failed to render file:', e);
                const msg = typeof e === 'string' ? e : (e && e.message) ? e.message : 'Failed to render file';
                html = `<div class="markdown-body"><pre style="color: var(--danger, #c00); white-space: pre-wrap;">${escapeHtml(String(msg))}</pre></div>`;
            }
        }

        currentFilePath = filePath;
        // A full swap (file/kind switches drive sidebar visibility and labels)
        // or a changed heading outline rebuilds the table of contents inside
        // the patcher.
        let fullSwap = true;
        if (usedPdf) {
            // PDFs keep the simple full swap; nothing in them is patchable.
            previewPatcher.swap(html);
        } else {
            // Patch only the changed top-level blocks; math/mermaid re-render
            // inside the patch, scoped to inserted nodes.
            fullSwap = previewPatcher.patch(html, { outlineOnFull: true }).full;
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
        updateTreeActiveFile();
        // Restore scroll position only after a full swap; patches leave the
        // scroll untouched and the percent-based anchor would jolt it.
        if (fullSwap) scrollSync.scrollTo(anchor);

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

const scrollSync = createScrollSync({
    adapter: {
        label: appWindow.label,
        filePath: () => currentFilePath,
        kind: () => (currentKind === KIND_PDF ? null : currentKind),
        topLine() {
            const m = getPreAndMetrics();
            if (!m) return null;
            const offset = Math.max(0, contentEl.scrollTop - m.preTop);
            return Math.floor(offset / m.lineHeight) + 1;
        },
        topPercent() {
            const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
            return Math.max(0, Math.min(1, contentEl.scrollTop / maxScroll));
        },
        scrollToLine(line) {
            const m = getPreAndMetrics();
            if (!m) return false;
            contentEl.scrollTop = m.preTop + (Math.max(1, line) - 1) * m.lineHeight;
        },
        scrollToPercent(percent) {
            const scrollableHeight = contentEl.scrollHeight - contentEl.clientHeight;
            if (scrollableHeight <= 0) return false;
            contentEl.scrollTop = percent * scrollableHeight;
        },
    },
    emit: (payload) => invoke('broadcast_scroll_sync', { payload })
        .catch((e) => console.warn('Failed to broadcast scroll sync:', e)),
    listen,
    clock: window,
});

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
        try {
            html = await invoke('render_buffer_to_html', { kind, content });
        } catch (err) {
            // Mid-typing JSON/YAML is usually invalid; keep the last good render.
            if (kind === KIND_JSON || kind === KIND_YAML) return;
            throw err;
        }
        previewPatcher.patch(html);
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
    const kind = kindFromPath(filePath);
    return kind !== null && kind !== KIND_PDF;
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
    if (findBtn) findBtn.addEventListener('click', findBar.toggle);
    const welcomeOpenBtn = document.getElementById('welcome-open-btn');
    if (welcomeOpenBtn) welcomeOpenBtn.addEventListener('click', () => document.getElementById('open-btn').click());
    const welcomeFolderBtn = document.getElementById('welcome-folder-btn');
    if (welcomeFolderBtn) welcomeFolderBtn.addEventListener('click', openFolder);
    const welcomeNewBtn = document.getElementById('welcome-new-btn');
    if (welcomeNewBtn) welcomeNewBtn.addEventListener('click', () => document.getElementById('new-btn').click());
    const filesTabBtn = document.getElementById('sidebar-tab-files');
    if (filesTabBtn) filesTabBtn.addEventListener('click', () => setSidebarTab('files'));
    const searchTabBtn = document.getElementById('sidebar-tab-search');
    if (searchTabBtn) searchTabBtn.addEventListener('click', () => setSidebarTab('search'));
    const outlineTabBtn = document.getElementById('sidebar-tab-outline');
    if (outlineTabBtn) outlineTabBtn.addEventListener('click', () => setSidebarTab('outline'));
    initSearchPanel();
    const tocCloseBtn = document.getElementById('toc-close-btn');
    if (tocCloseBtn) tocCloseBtn.addEventListener('click', toggleTOC);
    const tocOpenBtn = document.getElementById('toc-open-btn');
    if (tocOpenBtn) tocOpenBtn.addEventListener('click', toggleTOC);
    // Theme menu
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
            appearance.set('theme', e.target.dataset.theme);
            toggleThemeMenu();
        });
    });

    // Toolbar density seg buttons
    document.querySelectorAll('.density-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
            appearance.set('toolbarDensity', e.currentTarget.dataset.density);
        });
    });

    // Typography font-family seg buttons
    document.querySelectorAll('.doc-font-option').forEach(btn => {
        btn.addEventListener('click', (e) => appearance.set('documentFont', e.currentTarget.dataset.font));
    });
    document.querySelectorAll('.ed-font-option').forEach(btn => {
        btn.addEventListener('click', (e) => appearance.set('editorFont', e.currentTarget.dataset.font));
    });
    
    // Click outside theme menu to close
    document.addEventListener('click', (e) => {
        const themeMenu = document.getElementById('theme-menu');
        const themeBtn = document.getElementById('theme-btn');
        if (!themeMenu.contains(e.target) && e.target !== themeBtn && !themeBtn.contains(e.target)) {
            themeMenu.classList.remove('show');
        }
    });

    
    setupKeyboardShortcuts(commands.shortcuts);
    setupChordShortcuts(commands.chords);
}

// --- Commands (viewer): keys, menu events and palette entries ---
const notPdf = () => currentKind !== KIND_PDF;
const hasTextFile = () => !!currentFilePath && currentKind !== KIND_PDF;

// Palette order is table order.
const commands = createCommands([
    { id: 'open',        keys: 'Mod+O',       menu: EVENT_MENU_OPEN,        label: 'Open File…',          action: () => openFileSmart() },
    { id: 'open-dialog',                                                    label: 'Open File (Dialog)…', action: () => openFile() },
    { id: 'open-folder', keys: 'Mod+Shift+O', menu: EVENT_MENU_OPEN_FOLDER, label: 'Open Folder…',        action: () => openFolder() },
    { id: 'new',         keys: 'Mod+N',                                     label: 'New File…',           action: () => createNewMarkdownFile() },
    { id: 'new-window',  keys: 'Mod+Shift+N',                               label: 'New Window',
      action: () => invoke('create_new_window_command').catch(err => console.error('Failed to create new window:', err)) },
    { id: 'ws-search',   keys: 'Mod+Shift+F', label: 'Search in Workspace…', listed: () => !!workspaceFolder, action: () => openWorkspaceSearch() },
    { id: 'close-folder',                     label: 'Close Folder',      available: () => !!workspaceFolder, action: () => closeFolder() },
    { id: 'refresh',     keys: 'Mod+R',       label: 'Refresh',              listed: () => !!currentFilePath, action: () => refreshFile() },
    { id: 'toggle-sidebar',                   label: 'Toggle Sidebar',                                        action: () => toggleTOC() },
    { id: 'find',        keys: 'Mod+F',       menu: EVENT_MENU_FIND,      label: 'Find…',
      available: notPdf, listed: hasTextFile, action: () => findBar.open() },
    { id: 'find-next',   keys: 'Mod+G',       menu: EVENT_MENU_FIND_NEXT, label: 'Find Next',
      available: notPdf, listed: hasTextFile, action: () => findBar.next() },
    { id: 'find-prev',   keys: 'Mod+Shift+G', menu: EVENT_MENU_FIND_PREV, label: 'Find Previous',
      available: notPdf, listed: hasTextFile, action: () => findBar.previous() },
    { id: 'export-html', keys: 'Mod+Shift+E', menu: EVENT_MENU_EXPORT_HTML, menuDelay: 50, label: 'Export as HTML…',
      listed: hasTextFile, action: () => exportHtml() },
    { id: 'edit',                             label: 'Edit…', available: hasTextFile, action: () => openEditor() },
    // Cmd+P does nothing on a PDF; the palette entry is always there.
    { id: 'print',       keys: 'Mod+P',       label: 'Print…', available: notPdf, listed: () => true,
      action: () => invoke('print_current_window').catch(err => console.error('Print failed:', err)) },
    { id: 'custom-css',    label: 'Edit Custom CSS…',    action: () => invoke('open_custom_css').catch(console.error) },
    { id: 'reload-css',    label: 'Reload Custom CSS',   action: () => ensureCustomCss() },
    { id: 'theme-light',   label: 'Theme: Light',        action: () => appearance.set('theme', 'light') },
    { id: 'theme-dark',    label: 'Theme: Dark',         action: () => appearance.set('theme', 'dark') },
    { id: 'theme-drac',    label: 'Theme: Drac',         action: () => appearance.set('theme', 'drac') },
    { id: 'font-size-inc', label: 'Text Size: Increase', action: () => changeFontSize(1) },
    { id: 'font-size-dec', label: 'Text Size: Decrease', action: () => changeFontSize(-1) },
    { id: 'close',       keys: 'Mod+W',       menu: EVENT_MENU_CLOSE, label: 'Close Window', action: () => appWindow.close() },
    // Not in the palette.
    { id: 'replace',     keys: 'Mod+Alt+F',   menu: EVENT_MENU_FIND_REPLACE, action: () => findBar.openReplace() },
    { id: 'use-selection-or-edit', keys: 'Mod+E', action: () => { if (!findBar.useSelection()) openEditor(); } },
    { id: 'use-selection', menu: EVENT_MENU_FIND_USE_SELECTION, action: () => findBar.useSelection() },
    { id: 'theme-menu',  keys: 'Mod+T',       action: () => toggleThemeMenu() },
    { id: 'select-all',  keys: 'Mod+A',       action: () => selectAllDocument() },
    { id: 'palette',     keys: 'Mod+K Mod+P', menu: EVENT_MENU_COMMAND_PALETTE, action: () => openPalette() },
], { mac: true, hasFocus: () => document.hasFocus() });

function ensureCommandPalette() {
    if (commandPalette) return commandPalette;
    commandPalette = createCommandPalette(document.body, commands.paletteActions);
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

// --- In-document anchors and relative links ---

/** Scroll to a `#name` anchor. The Rust render already rewrote links to
 *  heading-slug form, so the prefixed id is the only lookup. */
function navigateToAnchor(rawName) {
    let name;
    try { name = decodeURIComponent(rawName); } catch (_) { name = rawName; }
    const target = document.getElementById('md-' + name);
    if (target) scrollContentToHeading(target);
}

/** Resolve a relative link against the current document and open it in-window.
 *  Percent-decoding and fragment/query stripping happen in Rust (URL join). */
async function openRelativeLink(href) {
    if (!currentFilePath || currentKind === KIND_PDF) return;
    try {
        const resolved = await invoke('resolve_doc_link', { base: currentFilePath, href });
        if (resolved) await openFile(resolved);
    } catch (err) {
        console.warn('Cannot open link:', href, err);
    }
}

/**
 * Swap relative <img> sources for data: URIs read through Rust (the webview
 * origin can't reach the filesystem; CSP allows data: images). Scoped to
 * inserted nodes, concurrent across images, keyed to the doc path so a
 * mid-flight file switch can't paint stale images.
 */
async function hydrateLocalImages(scope) {
    if (!currentFilePath || currentKind === KIND_PDF) return;
    const docPath = currentFilePath;
    const imgs = collectRenderTargets(scope, 'img').filter(img => {
        const src = img.getAttribute('src') || '';
        return src && !/^(data:|blob:|https?:)/i.test(src);
    });
    if (!imgs.length) return;
    // Small worker pool: each load can move a ~27MB base64 payload over IPC,
    // so an image-heavy document must not fire them all at once.
    const MAX_CONCURRENT_IMAGE_LOADS = 4;
    let next = 0;
    const worker = async () => {
        while (next < imgs.length) {
            const img = imgs[next++];
            const src = img.getAttribute('src');
            try {
                const asset = await invoke('load_doc_asset', { base: docPath, src });
                if (currentFilePath !== docPath) return;
                img.src = `data:${asset.mime};base64,${asset.data_b64}`;
            } catch (err) {
                img.title = String(err);
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT_IMAGE_LOADS, imgs.length) }, worker)
    );
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
        } else if (href.startsWith('#')) {
            navigateToAnchor(href.slice(1));
        } else if (href && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
            // Relative path: resolve against the current document (Rust
            // validates containment and grants). Other schemes stay blocked.
            await openRelativeLink(href);
        }
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
  let filePath = null;
  try {

        setupEventListeners();
        attachLinkInterceptor();
        attachRichCopyHandler();
        const prefs = await appearance.start();
        tocVisible = prefs?.toc_visible !== false;
        updateViewMenuState();
        await ensureCustomCss();
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
                    ensureCustomCss();
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
            if (currentKind === KIND_PDF) return;
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

        // Menu events that run commands
        await commands.listenMenu(listen);

        // Listen for scroll sync events from other windows
        await scrollSync.listening;
        
        // Rust sets the initial file in the window's initialization script.
        filePath = window.__INITIAL_FILE_PATH__ || null;

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
    // No-file (welcome / blank) windows are created hidden like document
    // windows; show once the card is ready so the startup gate can veto it.
    // Runs outside the try so a mid-init exception still surfaces the window.
    if (!filePath) {
        try {
            const visible = await appWindow.isVisible();
            if (!visible) {
                await invoke('show_window', { windowLabel: appWindow.label });
            }
        } catch (err) {
            console.error('Failed to show window:', err);
        }
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
        scrollSync.onScroll();
    });
}

// --- Find bar (preview): matches are wrapped in highlight spans ---
let findSpans = [];
let currentFindIndex = -1;

function highlightFindMatches(query, { matchCase, wholeWord, keepPosition }) {
    const keptIndex = currentFindIndex;
    clearFindHighlights();
    currentFindIndex = -1;

    const regex = buildFindRegex(query, { matchCase, wholeWord });
    if (!regex) return 0;

    // Collect text nodes first so we can mutate without confusing the walker.
    const textNodes = [];
    const walker = document.createTreeWalker(previewContainer, NodeFilter.SHOW_TEXT, {
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
        currentFindIndex = keepPosition ? Math.min(Math.max(keptIndex, 0), findSpans.length - 1) : 0;
        setActiveFindSpan(!keepPosition);
    }
    return findSpans.length;
}

function setActiveFindSpan(scroll) {
    findSpans.forEach((s, i) => s.classList.toggle('active', i === currentFindIndex));
    const span = findSpans[currentFindIndex];
    if (!span || !scroll) return;
    scrollSync.programmatic(() => span.scrollIntoView({ behavior: 'smooth', block: 'center' }));
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

const findBar = createFindBar({
    document,
    parent: document.getElementById('find-bar-slot'),
    adapter: {
        available: () => !!currentFilePath && currentKind !== KIND_PDF,
        search: highlightFindMatches,
        step(direction) {
            if (direction !== 0) {
                currentFindIndex = nextFindIndex(currentFindIndex, findSpans.length, direction);
                setActiveFindSpan(true);
            }
            return currentFindIndex;
        },
        clear() {
            clearFindHighlights();
            currentFindIndex = -1;
        },
        selectionText: () => window.getSelection().toString(),
        jumpToSelection: true,
    },
});
