import {
    SCROLL_SYNC_DEBOUNCE_MS,
    PROGRAMMATIC_SCROLL_TIMEOUT_MS,
    MIN_SCROLL_DELTA_LINES,
    MIN_SCROLL_DELTA_PERCENT,
    LINE_HEIGHT_FALLBACK_MULTIPLIER,
    parsePx,
    escapeHtml,
    createFindOverlay,
    updateFindCount,
    nextFindIndex,
    applyThemeToDocument,
    setupKeyboardShortcuts,
} from './shared.js';
import {
    EVENT_FILE_CHANGED,
    EVENT_THEME_CHANGED,
    EVENT_SCROLL_SYNC,
    EVENT_MENU_OPEN,
    EVENT_MENU_CLOSE,
    EVENT_MENU_FIND,
    EVENT_MENU_EDIT,
    EVENT_MENU_EXPORT_HTML,
    ACTION_UNDO,
    ACTION_REDO,
    ACTION_CUT,
    ACTION_COPY,
    ACTION_PASTE,
    ACTION_SELECT_ALL,
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
let currentTheme = 'drac';
let currentKind = KIND_MARKDOWN; // KIND_JSON | KIND_MARKDOWN | KIND_TXT | 'pdf'
let currentPdfUrl = null;
let isProgrammaticScroll = false;
let scrollDebounce = null;
let contentEl = null; // scrolling container (.content-wrapper)
let findOverlay = null;
let findInput = null;
let findVisible = false;

// Track last synced position to filter micro-scrolls
let lastSyncedLine = null;
let lastSyncedPercent = null;
// Cache offset calculations to avoid repeated DOM walking
let cachedPreMetrics = null;

async function loadPreferences() {
    try {
        const prefs = await invoke('get_preferences');
        applyTheme(prefs.theme);
        tocVisible = prefs.toc_visible !== false;
    } catch (err) {
        console.error('Failed to load preferences:', err);
        applyTheme('drac');
    }
}

async function broadcastThemeChange(theme) {
    try {
        await invoke('broadcast_theme_change', { theme });
    } catch (err) {
        console.error('Failed to broadcast theme change:', err);
    }
}

async function savePreference(key, value) {
    try {
        await invoke('save_preference_key', { key, value });
    } catch (err) {
        console.error('Failed to save preference:', err);
    }
}

function applyTheme(theme) {
    currentTheme = theme;
    applyThemeToDocument(theme);
    savePreference('theme', theme);
    // Ensure syntax CSS for this theme is loaded
    ensureSyntaxCss(theme);
    
    // Update active theme indicator
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
    });
    
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

async function exportHtml() {
    if (!currentFilePath) return;
    if (currentKind === 'pdf') return;
    try {
        await invoke('save_html_export', {
            path: currentFilePath,
            theme: currentTheme,
        });
    } catch (err) {
        console.error('HTML export failed:', err);
    }
}

let tocScrollDebounce = null;
let tocVisible = true;

function buildTOC() {
    const tocNav = document.getElementById('toc-nav');
    const tocBtn = document.getElementById('toc-btn');
    const tocSidebar = document.getElementById('toc-sidebar');
    if (!tocNav) return;

    tocNav.innerHTML = '';

    if (currentKind !== KIND_MARKDOWN) {
        if (tocBtn) { tocBtn.style.display = 'none'; tocBtn.classList.remove('active'); }
        if (tocSidebar) tocSidebar.classList.remove('show');
        return;
    }

    const headings = document.querySelectorAll('#markdown-content h1, #markdown-content h2, #markdown-content h3, #markdown-content h4, #markdown-content h5, #markdown-content h6');
    if (headings.length === 0) {
        if (tocBtn) { tocBtn.style.display = 'none'; tocBtn.classList.remove('active'); }
        if (tocSidebar) tocSidebar.classList.remove('show');
        return;
    }

    if (tocBtn) tocBtn.style.display = '';
    if (tocVisible) {
        if (tocSidebar) tocSidebar.classList.add('show');
        if (tocBtn) tocBtn.classList.add('active');
    } else {
        if (tocSidebar) tocSidebar.classList.remove('show');
        if (tocBtn) tocBtn.classList.remove('active');
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
            heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        tocNav.appendChild(link);
    });
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
    const tocBtn = document.getElementById('toc-btn');
    if (sidebar) sidebar.classList.toggle('show');
    tocVisible = sidebar && sidebar.classList.contains('show');
    if (tocBtn) tocBtn.classList.toggle('active', tocVisible);
    savePreference('toc_visible', tocVisible);
}

async function openFile(filePath) {
    if (!filePath) {
        filePath = await invoke('open_file_dialog');
        if (!filePath) return;
    }
    
    try {
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
        // Clear any in-flight find results that reference old DOM nodes
        clearFindResults();
        const container = document.getElementById('markdown-content');
        const range = document.createRange();
        range.selectNodeContents(container);
        const fragment = range.createContextualFragment(html);
        container.replaceChildren(fragment);
        // Invalidate cached metrics after DOM change
        cachedPreMetrics = null;
        // Toggle PDF layout mode
        if (usedPdf) {
            document.body.classList.add('pdf-mode');
        } else {
            document.body.classList.remove('pdf-mode');
        }
        // Ensure link interception remains active after content swap (non-PDF only)
        if (!usedPdf) attachLinkInterceptor();
        // Update edit button availability based on file writability
        updateEditButtonState();
        // Build table of contents from headings
        buildTOC();
        // Restore scroll position if applicable
        if (anchor) {
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
        
        // Title is already set during window creation - no need to set it again
        
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
        console.log('[DEBUG] File watcher started');
        
    } catch (err) {
        console.error('[DEBUG] Failed to open file:', err);
        alert(`Failed to open file: ${err}`);
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

function toggleThemeMenu() {
    const menu = document.getElementById('theme-menu');
    menu.classList.toggle('show');
}

async function openEditor() {
    if (!currentFilePath) {
        alert('Please open a file first');
        return;
    }
    // Block if file type isn't editable
    if (!isEditableType(currentFilePath)) {
        alert('This file type is view-only and cannot be edited.');
        return;
    }
    // Block if file is not writable
    try {
        const writable = await invoke('is_writable', { path: currentFilePath });
        if (!writable) {
            alert('This file is write-protected and cannot be edited.');
            return;
        }
    } catch (_) {
        // If we cannot confirm writability, be conservative and block
        alert('Unable to verify edit permission for this file.');
        return;
    }
    
    try {
        await invoke('open_editor_window', { 
            filePath: currentFilePath,
            previewWindow: appWindow.label
        });
    } catch (err) {
        console.error('Failed to open editor:', err);
        alert('Failed to open editor: ' + err);
    }
}

async function createNewMarkdownFile() {
    try {
        const windowLabel = await invoke('create_new_markdown_file');
        return windowLabel || null;
    } catch (err) {
        console.error('Failed to create new file:', err);
        alert('Failed to create new file: ' + err);
        return null;
    }
}

async function updateEditButtonState() {
    const editBtn = document.getElementById('edit-btn');
    if (!editBtn) return;
    if (!currentFilePath) {
        editBtn.setAttribute('disabled', 'true');
        return;
    }
    // Disable for non-editable types
    if (!isEditableType(currentFilePath)) {
        editBtn.setAttribute('disabled', 'true');
        return;
    }
    try {
        const writable = await invoke('is_writable', { path: currentFilePath });
        if (writable) {
            editBtn.removeAttribute('disabled');
        } else {
            editBtn.setAttribute('disabled', 'true');
        }
    } catch (e) {
        // On error, be conservative and disable
        editBtn.setAttribute('disabled', 'true');
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
    document.getElementById('refresh-btn').addEventListener('click', refreshFile);
    document.getElementById('theme-btn').addEventListener('click', toggleThemeMenu);
    document.getElementById('edit-btn').addEventListener('click', openEditor);
    const findBtn = document.getElementById('find-btn');
    if (findBtn) findBtn.addEventListener('click', toggleFindOverlay);
    const tocBtn = document.getElementById('toc-btn');
    if (tocBtn) tocBtn.addEventListener('click', toggleTOC);
    // Theme menu
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.addEventListener('click', (e) => {
            applyTheme(e.target.dataset.theme);
            toggleThemeMenu();
        });
    });
    
    // Click outside theme menu to close
    document.addEventListener('click', (e) => {
        const themeMenu = document.getElementById('theme-menu');
        const themeBtn = document.getElementById('theme-btn');
        if (!themeMenu.contains(e.target) && e.target !== themeBtn && !themeBtn.contains(e.target)) {
            themeMenu.classList.remove('show');
        }
    });
    
    // Keyboard shortcuts (table-driven, shift variants before non-shift for same key)
    setupKeyboardShortcuts([
        { key: 'f', ctrl: true, action: () => { if (currentKind !== 'pdf') openFindOverlay(); } },
        { key: 'p', ctrl: true, action: () => { if (currentKind !== 'pdf') invoke('print_current_window').catch(err => console.error('Print failed:', err)); } },
        { key: 'o', ctrl: true, action: () => openFile() },
        { key: 'r', ctrl: true, action: () => refreshFile() },
        { key: 't', ctrl: true, action: () => toggleThemeMenu() },
        { key: 'e', ctrl: true, shift: true, action: () => exportHtml() },
        { key: 'e', ctrl: true, action: () => openEditor() },
        { key: 'n', ctrl: true, shift: true, action: () => invoke('create_new_window_command').catch(err => console.error('Failed to create new window:', err)) },
        { key: 'n', ctrl: true, action: () => createNewMarkdownFile() },
        { key: 'w', ctrl: true, action: () => appWindow.close() },
    ]);
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
        const href = a.getAttribute('href') || '';
        e.preventDefault();
        if (isAllowedExternalUrl(href)) {
            try {
                await invoke('plugin:opener|open', { target: href });
            } catch (err) {
                console.error('Failed to open external link:', err);
            }
        }
        // Block all other schemes
    });
    container.__linksBound = true;
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

async function checkAndPromptCliSetup() {
    try {
        // Check if CLI is actually installed
        const isInstalled = await invoke('is_cli_installed');

        if (isInstalled) {
            // CLI is installed, nothing to do
            return;
        }

        // CLI not installed - reset the declined flag in case it was set from a failed previous attempt
        // Check if user has declined THIS SESSION
        const prefs = await invoke('get_preferences');
        if (prefs.cli_setup_prompted === true) {
            // User declined in this session, don't ask again
            return;
        }

        // Show dialog asking if user wants to set up CLI access
        const message = 'Command-line access for BoltPage is not configured.\n\n' +
                       'Would you like to enable it? This will allow you to open files from your terminal:\n' +
                       '  boltpage myfile.md\n\n' +
                       'You can set this up later from the Help menu.';

        if (confirm(message)) {
            try {
                const result = await invoke('setup_cli_access');
                console.log('CLI setup:', result);
            } catch (err) {
                if (!String(err).includes('cancelled')) {
                    console.error('CLI setup failed:', err);
                }
                await invoke('mark_cli_setup_declined');
            }
        } else {
            // User declined, remember for this session
            await invoke('mark_cli_setup_declined');
        }
    } catch (err) {
        console.error('Failed to check CLI setup:', err);
    }
}

// Initialize app
window.addEventListener('DOMContentLoaded', async () => {
  try {

        setupEventListeners();
        attachLinkInterceptor();
        await loadPreferences();
        // Initial button states
        updateEditButtonState();
        // Cache content wrapper and attach scroll sync listener
        contentEl = document.querySelector('.content-wrapper');
        attachPreviewScrollSync();

        // Check if we should prompt for CLI setup (first run)
        setTimeout(() => checkAndPromptCliSetup(), 2000);
    
        // Listen for file change events -- auto-refresh the preview
        await listen(EVENT_FILE_CHANGED, async () => {
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

            // Update active theme indicator
            document.querySelectorAll('.theme-option').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.theme === currentTheme);
            });
        });

        // Listen for edit menu actions (cut/copy/paste/select-all)
        await listen(EVENT_MENU_EDIT, async (event) => {
            if (!document.hasFocus()) return;
            const action = String(event.payload || '');
            performEditAction(action);
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

        // Listen for File > Open menu action
        await listen(EVENT_MENU_OPEN, () => {
            if (!document.hasFocus()) return;
            openFile();
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

// Edit command helpers using modern Clipboard API
async function performEditAction(action) {
    try {
        const selection = window.getSelection();
        const activeEl = document.activeElement;

        switch (action) {
            case ACTION_UNDO:
            case ACTION_REDO:
                // Preview is read-only: undo/redo are not applicable
                break;
            case ACTION_COPY:
                if (selection && selection.toString()) {
                    await navigator.clipboard.writeText(selection.toString());
                }
                break;
            case ACTION_CUT:
                // Preview is read-only: copy selection to clipboard without modifying DOM
                if (selection && selection.toString()) {
                    await navigator.clipboard.writeText(selection.toString());
                }
                break;
            case ACTION_PASTE:
                try {
                    const text = await navigator.clipboard.readText();
                    if (activeEl && (activeEl.tagName === 'TEXTAREA' ||
                        (activeEl.tagName === 'INPUT' && /^(text|search|url|tel|password|email)$/i.test(activeEl.type)))) {
                        const start = activeEl.selectionStart ?? 0;
                        const end = activeEl.selectionEnd ?? 0;
                        const val = activeEl.value ?? '';
                        activeEl.value = val.slice(0, start) + text + val.slice(end);
                        const pos = start + text.length;
                        activeEl.setSelectionRange(pos, pos);
                        activeEl.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                } catch (err) {
                    console.error('Paste failed:', err);
                }
                break;
            case ACTION_SELECT_ALL:
                if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
                    activeEl.select();
                } else {
                    const contentContainer = document.getElementById('markdown-content');
                    if (contentContainer) {
                        selection.selectAllChildren(contentContainer);
                    }
                }
                break;
        }
    } catch (err) {
        console.error('Edit action failed:', err);
    }
}

// --- Find overlay (preview) ---
let findResults = [];
let currentFindIndex = -1;
let lastSearchQuery = '';

function ensureFindOverlay() {
    if (findOverlay) return;
    const els = createFindOverlay();
    findOverlay = els.overlay;
    findInput = els.input;

    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) findPrevious(); else findNext();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeFindOverlay();
        }
    });

    findOverlay.querySelector('#find-prev').addEventListener('click', findPrevious);
    findOverlay.querySelector('#find-next').addEventListener('click', findNext);
    findOverlay.querySelector('#find-close').addEventListener('click', closeFindOverlay);
}

function performFind(query) {
    if (!query.trim()) {
        clearFindResults();
        return;
    }
    
    lastSearchQuery = query;
    findResults = [];
    currentFindIndex = -1;
    
    // Clear any existing highlights
    clearFindHighlights();
    
    // Find all instances in the content
    const content = document.getElementById('markdown-content');
    if (!content) return;
    
    const walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );
    
    let node;
    let offset = 0;
    
    while (node = walker.nextNode()) {
        const text = node.textContent;
        const lowerText = text.toLowerCase();
        const lowerQuery = query.toLowerCase();
        let index = 0;
        
        while ((index = lowerText.indexOf(lowerQuery, index)) !== -1) {
            findResults.push({
                node: node,
                start: index,
                end: index + query.length,
                offset: offset + index
            });
            index += 1;
        }
        
        offset += text.length;
    }
    
    updateFindCountDisplay();
    
    if (findResults.length > 0) {
        currentFindIndex = 0;
        highlightCurrentFind();
    }
}

function findNext() {
    const currentQuery = findInput.value;
    if (currentQuery !== lastSearchQuery || findResults.length === 0) {
        performFind(currentQuery);
        return;
    }
    currentFindIndex = nextFindIndex(currentFindIndex, findResults.length, 1);
    highlightCurrentFind();
    updateFindCountDisplay();
}

function findPrevious() {
    const currentQuery = findInput.value;
    if (currentQuery !== lastSearchQuery || findResults.length === 0) {
        performFind(currentQuery);
        return;
    }
    currentFindIndex = nextFindIndex(currentFindIndex, findResults.length, -1);
    highlightCurrentFind();
    updateFindCountDisplay();
}

function highlightCurrentFind() {
    if (currentFindIndex < 0 || currentFindIndex >= findResults.length) return;
    
    const result = findResults[currentFindIndex];
    const range = document.createRange();
    range.setStart(result.node, result.start);
    range.setEnd(result.node, result.end);
    
    // Clear previous selection
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    
    // Scroll into view
    result.node.parentElement?.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
    });
}

function clearFindHighlights() {
    const selection = window.getSelection();
    selection.removeAllRanges();
}

function clearFindResults() {
    findResults = [];
    currentFindIndex = -1;
    clearFindHighlights();
    updateFindCountDisplay();
}

function updateFindCountDisplay() {
    updateFindCount(findOverlay, findResults, currentFindIndex);
}

function openFindOverlay() {
    ensureFindOverlay();
    findOverlay.classList.add('show');
    findVisible = true;
    // prefill from selection if any
    const sel = window.getSelection && window.getSelection().toString();
    if (sel) findInput.value = sel;
    findInput.focus();
    findInput.select();
}

function toggleFindOverlay() {
    if (findVisible) closeFindOverlay(); else openFindOverlay();
}

function closeFindOverlay() {
    if (!findOverlay) return;
    findOverlay.classList.remove('show');
    findVisible = false;
    clearFindResults();
}

