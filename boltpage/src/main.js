const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

let currentFilePath = null;
let fileWatcher = null;
let currentTheme = 'system';
let currentKind = 'markdown'; // 'json' | 'markdown' | 'txt'
let isProgrammaticScroll = false;
let scrollDebounce = null;
let contentEl = null; // scrolling container (.content-wrapper)
let scrollLinkEnabled = true;
let findOverlay = null;
let findInput = null;
let findVisible = false;

// Suppress noisy [DEBUG] logs in production unless window.__DEV__ is true
(function () {
  try {
    const orig = console.log;
    console.log = function (...args) {
      if (!window.__DEV__ && String(args[0] || '').includes('[DEBUG]')) return;
      return orig.apply(console, args);
    };
  } catch {}
})();


function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function loadPreferences() {
    try {
        const prefs = await invoke('get_preferences');
        applyTheme(prefs.theme);
    } catch (err) {
        console.error('Failed to load preferences:', err);
        applyTheme('system');
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
        const prefs = await invoke('get_preferences');
        prefs[key] = value;
        await invoke('save_preferences', { preferences: prefs });
    } catch (err) {
        console.error('Failed to save preference:', err);
    }
}

function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
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

async function openFile(filePath) {
    console.log('[DEBUG] openFile called with:', filePath);
    if (!filePath) {
        filePath = await invoke('open_file_dialog');
        if (!filePath) return;
    }
    
    try {
        console.log('[DEBUG] About to call read_file with path:', filePath);
        const content = await invoke('read_file', { path: filePath });
        console.log('[DEBUG] read_file returned content length:', content.length);

        const lowerPath = String(filePath).toLowerCase();
        let html;
        if (lowerPath.endsWith('.json')) {
            currentKind = 'json';
            console.log('[DEBUG] About to call parse_json_with_theme');
            try {
                html = await invoke('parse_json_with_theme', { content, theme: currentTheme });
                console.log('[DEBUG] parse_json_with_theme returned HTML length:', html.length);
            } catch (e) {
                console.error('[DEBUG] parse_json_with_theme failed:', e);
                const msg = typeof e === 'string' ? e : (e && e.message) ? e.message : 'Invalid JSON';
                html = `<div class="markdown-body"><pre style="color: var(--danger, #c00); white-space: pre-wrap;">JSON error: ${escapeHtml(String(msg))}</pre></div>`;
            }
        } else if (lowerPath.endsWith('.yaml') || lowerPath.endsWith('.yml')) {
            currentKind = 'yaml';
            console.log('[DEBUG] About to call parse_yaml_with_theme');
            try {
                html = await invoke('parse_yaml_with_theme', { content, theme: currentTheme });
                console.log('[DEBUG] parse_yaml_with_theme returned HTML length:', html.length);
            } catch (e) {
                console.error('[DEBUG] parse_yaml_with_theme failed:', e);
                const msg = typeof e === 'string' ? e : (e && e.message) ? e.message : 'Invalid YAML';
                html = `<div class="markdown-body"><pre style="color: var(--danger, #c00); white-space: pre-wrap;">YAML error: ${escapeHtml(String(msg))}</pre></div>`;
            }
        } else if (lowerPath.endsWith('.txt')) {
            currentKind = 'txt';
            // Render plain text in a pre block with escaping
            const escaped = escapeHtml(content);
            html = `<div class="markdown-body"><pre class="plain-text">${escaped}</pre></div>`;
        } else {
            currentKind = 'markdown';
            console.log('[DEBUG] About to call parse_markdown_with_theme');
            html = await invoke('parse_markdown_with_theme', { content, theme: currentTheme });
            console.log('[DEBUG] parse_markdown_with_theme returned HTML length:', html.length);
        }

        currentFilePath = filePath;
        console.log('[DEBUG] About to set innerHTML');
        document.getElementById('markdown-content').innerHTML = html;
        console.log('[DEBUG] innerHTML set successfully');
        // Ensure link interception remains active after content swap
        attachLinkInterceptor();
        // Update edit button availability based on file writability
        updateEditButtonState();
        
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

function parsePx(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

function getPreAndMetrics() {
    let pre = null;
    if (currentKind === 'json' || currentKind === 'yaml') {
        pre = document.querySelector('#markdown-content .highlight pre');
    } else if (currentKind === 'txt') {
        pre = document.querySelector('#markdown-content pre.plain-text');
    }
    if (!pre) return null;
    const cs = window.getComputedStyle(pre);
    let lh = parsePx(cs.lineHeight);
    if (!lh) {
        // fallback: 1.2 * font-size
        lh = 1.2 * parsePx(cs.fontSize || '16');
    }
    // compute pre's top relative to the scrolling container
    const preTop = offsetTopWithin(contentEl, pre);
    return { pre, lineHeight: lh, preTop };
}

function getTopLineForPreview() {
    if (currentKind === 'json' || currentKind === 'yaml' || currentKind === 'txt') {
        const m = getPreAndMetrics();
        if (!m) return null;
        const offset = Math.max(0, contentEl.scrollTop - m.preTop);
        const line = Math.floor(offset / m.lineHeight) + 1;
        return { kind: currentKind, line };
    }
    // Fallback: percent scroll for markdown
    const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
    const percent = Math.max(0, Math.min(1, contentEl.scrollTop / maxScroll));
    return { kind: 'markdown', percent };
}

function scrollPreviewToLine(line) {
    const m = getPreAndMetrics();
    if (!m) return;
    const y = m.preTop + (Math.max(1, line) - 1) * m.lineHeight;
    isProgrammaticScroll = true;
    contentEl.scrollTo({ top: y, behavior: 'auto' });
    setTimeout(() => { isProgrammaticScroll = false; }, 0);
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

async function updateEditButtonState() {
    const editBtn = document.getElementById('edit-btn');
    if (!editBtn) return;
    if (!currentFilePath) {
        editBtn.setAttribute('disabled', 'true');
        return;
    }
    // Disable for non-editable types (e.g., pdf)
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
    const linkBtn = document.getElementById('link-scroll-btn');
    if (linkBtn) {
        linkBtn.addEventListener('click', async () => {
            scrollLinkEnabled = !scrollLinkEnabled;
            updateLinkScrollButton();
            try { await invoke('broadcast_scroll_link', { enabled: scrollLinkEnabled }); } catch {}
        });
    }
    
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
    
    // Keyboard shortcuts
    document.addEventListener('keydown', async (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        
        if (ctrl && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            openFindOverlay();
        } else if (ctrl && e.key.toLowerCase() === 'p') {
            e.preventDefault();
            // Print the preview (this window)
            window.print();
        } else if (ctrl && e.key === 'o') {
            e.preventDefault();
            openFile();
        } else if (ctrl && e.key === 'r') {
            e.preventDefault();
            refreshFile();
        } else if (ctrl && e.key === 't') {
            e.preventDefault();
            toggleThemeMenu();
        } else if (ctrl && e.key === 'e') {
            e.preventDefault();
            openEditor();
        } else if (ctrl && e.key === 'l') {
            e.preventDefault();
            if (linkBtn) linkBtn.click();
        } else if (ctrl && e.key.toLowerCase() === 'z' && e.shiftKey) {
            // Redo (Shift+Cmd/Ctrl+Z)
            e.preventDefault();
            performEditAction('redo');
        } else if (ctrl && e.key.toLowerCase() === 'z') {
            // Undo
            e.preventDefault();
            performEditAction('undo');
        } else if (ctrl && e.key.toLowerCase() === 'y') {
            // Redo on Windows/Linux
            e.preventDefault();
            performEditAction('redo');
        } else if (ctrl && e.key === 'n') {
            e.preventDefault();
            // Create new window
            try {
                await invoke('create_new_window_command');
            } catch (err) {
                console.error('Failed to create new window:', err);
            }
        } else if (ctrl && e.key === 'w') {
            e.preventDefault();
            // Close current window
            try {
                await appWindow.close();
            } catch (err) {
                console.error('Failed to close window:', err);
            }
        }
    });
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

// Initialize app
window.addEventListener('DOMContentLoaded', async () => {
  try {
        
        setupEventListeners();
        attachLinkInterceptor();
        await loadPreferences();
        // Initial edit button state
        updateEditButtonState();
        // Cache content wrapper and attach scroll sync listener
        contentEl = document.querySelector('.content-wrapper');
        attachPreviewScrollSync();
    
        // Listen for file change events
        await listen('file-changed', () => {
            // Show the refresh indicator
            document.getElementById('refresh-indicator').classList.add('show');
        });
        
        // Listen for theme change events from other windows
        await listen('theme-changed', async (event) => {
            currentTheme = event.payload;
            document.documentElement.setAttribute('data-theme', currentTheme);
            await ensureSyntaxCss(currentTheme);
            
            // Update active theme indicator
            document.querySelectorAll('.theme-option').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.theme === currentTheme);
            });
            // No need to re-render; CSS-only theme swap
        });

        // Listen for edit menu actions (cut/copy/paste/select-all)
        await listen('menu-edit', async (event) => {
            if (!document.hasFocus()) return;
            const action = String(event.payload || '');
            performEditAction(action);
        });

        // Listen for scroll-link state changes
        await listen('scroll-link-changed', (event) => {
            scrollLinkEnabled = !!event.payload;
            updateLinkScrollButton();
        });

        // Listen for print menu requests
        await listen('menu-print', () => {
            // This is the preview window; print directly
            window.print();
        });

        // Listen for menu find
        await listen('menu-find', () => {
            openFindOverlay();
        });

        // Listen for scroll sync events from other windows
        await listen('scroll-sync', async (event) => {
            const payload = event.payload || {};
            if (!currentFilePath || !scrollLinkEnabled) return;
            if (payload.source === appWindow.label) return; // ignore self
            if (payload.file_path !== currentFilePath) return;
            if ((payload.kind === 'json' || payload.kind === 'yaml') && typeof payload.line === 'number') {
                // Scroll preview to the requested line
                scrollPreviewToLine(payload.line);
            } else if (typeof payload.percent === 'number') {
                // Apply percentage scroll for markdown or others
                const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
                isProgrammaticScroll = true;
                contentEl.scrollTo({ top: payload.percent * maxScroll, behavior: 'auto' });
                setTimeout(() => { isProgrammaticScroll = false; }, 0);
            }
        });
        
        // Check for file parameter in querystring (new approach for Opened event handling)
        console.log('[DEBUG] window.location.search:', window.location.search);
        const params = new URLSearchParams(window.location.search);
        const fileParam = params.get('file');
        console.log('[DEBUG] Raw fileParam:', fileParam);
        let filePath = null;
        
        if (fileParam) {
            // Decode the file path from querystring
            filePath = decodeURIComponent(fileParam);
            console.log('[DEBUG] Decoded file path from querystring:', filePath);
        } else {
            console.log('[DEBUG] No file parameter found in querystring');
        }
        
    
    // Debug logging for file path initialization
    console.log('[DEBUG] Window initialized. __INITIAL_FILE_PATH__:', window.__INITIAL_FILE_PATH__);
    
    // If no querystring file, try to get file path from window label (fallback method)
    if (!filePath) {
        try {
            filePath = await invoke('get_file_path_from_window_label');
            console.log('[DEBUG] File path from window label:', filePath);
        } catch (err) {
            console.error('[DEBUG] Failed to get file path from window label:', err);
        }
    }
    
        // Use the querystring approach first, then window label, then legacy methods
        if (filePath) {
            console.log('[DEBUG] About to call openFile with:', filePath);
            try {
                await openFile(filePath);
                console.log('[DEBUG] openFile completed successfully');
            } catch (error) {
                console.error('[DEBUG] openFile failed:', error);
            }
        } else if (window.__INITIAL_FILE_PATH__) {
        console.log('[DEBUG] Opening file from __INITIAL_FILE_PATH__ (legacy):', window.__INITIAL_FILE_PATH__);
        await openFile(window.__INITIAL_FILE_PATH__);
    } else {
        console.log('[DEBUG] No file path found, trying opened files retry logic');
        // Check for files opened via "Open With" or double-click
        // Try multiple times in case RunEvent::Opened is still processing
        let attempts = 0;
        const maxAttempts = 10;
        
        while (attempts < maxAttempts) {
            try {
                const openedFiles = await invoke('get_opened_files');
                if (openedFiles && openedFiles.length > 0) {
                    // Open the first file in this window
                    await openFile(openedFiles[0]);
                    // Clear the opened files list
                    await invoke('clear_opened_files');
                    break;
                }
            } catch (err) {
                console.error('Failed to check for opened files:', err);
            }
            
            attempts++;
            if (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }
    } catch (error) {
        console.error('[CRITICAL ERROR] Initialization failed:', error);
    }
});

// Clean up on window close
window.addEventListener('beforeunload', () => {
    stopFileWatcher();
});

// Send scroll position changes to editor (or other listeners)
function attachPreviewScrollSync() {
    if (!contentEl) return;
    contentEl.addEventListener('scroll', () => {
        if (!currentFilePath || isProgrammaticScroll || !scrollLinkEnabled) return;
        if (scrollDebounce) cancelAnimationFrame(scrollDebounce);
        scrollDebounce = requestAnimationFrame(async () => {
            const info = getTopLineForPreview();
            if (!info) return;
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
        });
    });
}

function updateLinkScrollButton() {
    const btn = document.getElementById('link-scroll-btn');
    if (!btn) return;
    btn.classList.toggle('active', scrollLinkEnabled);
    btn.setAttribute('aria-pressed', String(scrollLinkEnabled));
}

// Edit command helpers
async function tryPasteFallback() {
    try {
        const text = await navigator.clipboard.readText();
        const a = document.activeElement;
        if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel|password|email)$/i.test(a.type)))) {
            const start = a.selectionStart ?? 0;
            const end = a.selectionEnd ?? 0;
            const val = a.value ?? '';
            a.value = val.slice(0, start) + text + val.slice(end);
            const pos = start + text.length;
            a.setSelectionRange(pos, pos);
            a.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } catch {}
}

function performEditAction(action) {
    try {
        switch (action) {
            case 'undo':
                document.execCommand('undo');
                break;
            case 'redo':
                document.execCommand('redo');
                break;
            case 'copy':
                document.execCommand('copy');
                break;
            case 'cut':
                document.execCommand('cut');
                break;
            case 'paste':
                try { if (document.execCommand('paste')) break; } catch {}
                tryPasteFallback();
                break;
            case 'select-all':
                document.execCommand('selectAll');
                break;
        }
    } catch {}
}

// --- Find overlay (preview) ---
let findResults = [];
let currentFindIndex = -1;
let lastSearchQuery = '';

function ensureFindOverlay() {
    if (findOverlay) return;
    findOverlay = document.createElement('div');
    findOverlay.className = 'find-overlay';
    findOverlay.innerHTML = `
        <input id="find-input" class="find-input" type="text" placeholder="Find..." />
        <span class="find-count" id="find-count"></span>
        <button class="find-btn" id="find-prev" title="Previous">&#8593;</button>
        <button class="find-btn" id="find-next" title="Next">&#8595;</button>
        <button class="find-btn" id="find-close" title="Close">&#10005;</button>
    `;
    document.body.appendChild(findOverlay);
    findInput = findOverlay.querySelector('#find-input');

    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const backwards = !!e.shiftKey;
            if (backwards) {
                findPrevious();
            } else {
                findNext();
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeFindOverlay();
        }
    });
    
    findOverlay.querySelector('#find-prev').addEventListener('click', () => {
        findPrevious();
    });
    findOverlay.querySelector('#find-next').addEventListener('click', () => {
        findNext();
    });
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
    
    updateFindCount();
    
    if (findResults.length > 0) {
        currentFindIndex = 0;
        highlightCurrentFind();
    }
}

function findNext() {
    const currentQuery = findInput.value;
    
    // If query changed, perform new search
    if (currentQuery !== lastSearchQuery) {
        performFind(currentQuery);
        return;
    }
    
    // If no results, perform search
    if (findResults.length === 0) {
        performFind(currentQuery);
        return;
    }
    
    currentFindIndex = (currentFindIndex + 1) % findResults.length;
    highlightCurrentFind();
    updateFindCount();
}

function findPrevious() {
    const currentQuery = findInput.value;
    
    // If query changed, perform new search
    if (currentQuery !== lastSearchQuery) {
        performFind(currentQuery);
        return;
    }
    
    // If no results, perform search
    if (findResults.length === 0) {
        performFind(currentQuery);
        return;
    }
    
    currentFindIndex = currentFindIndex <= 0 ? findResults.length - 1 : currentFindIndex - 1;
    highlightCurrentFind();
    updateFindCount();
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
    updateFindCount();
}

function updateFindCount() {
    const countEl = findOverlay?.querySelector('#find-count');
    if (countEl) {
        if (findResults.length === 0) {
            countEl.textContent = '';
        } else {
            countEl.textContent = `${currentFindIndex + 1}/${findResults.length}`;
        }
    }
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

// Legacy function for backward compatibility
function doFind(q, forward) {
    if (!q) return;
    
    if (q !== lastSearchQuery) {
        performFind(q);
    }
    
    if (forward) {
        findNext();
    } else {
        findPrevious();
    }
}
