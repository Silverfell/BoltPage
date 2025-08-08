const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();

let currentFilePath = null;
let fileWatcher = null;
let currentTheme = 'system';

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
    
    // Update active theme indicator
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
    });
    
    // Re-render if we have a file open
    if (currentFilePath) {
        refreshFile();
    }
    
    // Notify all windows of theme change
    broadcastThemeChange(theme);
}

async function openFile(filePath) {
    if (!filePath) {
        filePath = await invoke('open_file_dialog');
        if (!filePath) return;
    }
    
    try {
        const content = await invoke('read_file', { path: filePath });
        const html = await invoke('parse_markdown_with_theme', { content, theme: currentTheme });
        
        currentFilePath = filePath;
        document.getElementById('markdown-content').innerHTML = html;
        
        // Update window title
        const filename = filePath.split(/[/\\]/).pop();
        appWindow.setTitle(`MarkRust - ${filename}`);
        
        // Start file watching
        await startFileWatcher();
        
    } catch (err) {
        console.error('Failed to open file:', err);
        alert(`Failed to open file: ${err}`);
    }
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

function setupEventListeners() {
    // Toolbar buttons
    document.getElementById('open-btn').addEventListener('click', () => openFile());
    document.getElementById('refresh-btn').addEventListener('click', refreshFile);
    document.getElementById('theme-btn').addEventListener('click', toggleThemeMenu);
    document.getElementById('edit-btn').addEventListener('click', openEditor);
    
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
    document.addEventListener('keydown', (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        
        if (ctrl && e.key === 'o') {
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

// Initialize app
window.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();
    await loadPreferences();
    
    // Listen for file change events
    await listen('file-changed', () => {
        // Show the refresh indicator
        document.getElementById('refresh-indicator').classList.add('show');
    });
    
    // Listen for theme change events from other windows
    await listen('theme-changed', (event) => {
        currentTheme = event.payload;
        document.documentElement.setAttribute('data-theme', currentTheme);
        
        // Update active theme indicator
        document.querySelectorAll('.theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === currentTheme);
        });
        
        // Re-render if we have a file open
        if (currentFilePath) {
            refreshFile();
        }
    });
    
    // Check if file was passed as argument
    if (window.__INITIAL_FILE_PATH__) {
        await openFile(window.__INITIAL_FILE_PATH__);
    }
});

// Clean up on window close
window.addEventListener('beforeunload', () => {
    stopFileWatcher();
});