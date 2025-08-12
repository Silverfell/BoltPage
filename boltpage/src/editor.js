const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;

const appWindow = getCurrentWindow();
let currentFilePath = null;
let isDirty = false;
let saveTimeout = null;
let previewWindow = null;

// Get file path from window
async function initialize() {
    // Get file path from initialization script
    currentFilePath = window.__INITIAL_FILE_PATH__;
    previewWindow = window.__PREVIEW_WINDOW__;
    
    // Load file content
    if (currentFilePath) {
        try {
            const content = await invoke('read_file', { path: currentFilePath });
            document.getElementById('editor-textarea').value = content;
            updateStatus('Loaded');
            
            // Update window title
            const filename = currentFilePath.split(/[/\\]/).pop();
            appWindow.setTitle(`BoltPage Editor - ${filename}`);
        } catch (err) {
            console.error('Failed to load file:', err);
            updateStatus('Error loading file');
        }
    }
    
    // Load theme preference
    try {
        const prefs = await invoke('get_preferences');
        document.documentElement.setAttribute('data-theme', prefs.theme);
    } catch (err) {
        console.error('Failed to load preferences:', err);
    }
}

function updateStatus(status) {
    document.getElementById('editor-status').textContent = status;
}

function markDirty() {
    if (!isDirty) {
        isDirty = true;
        updateStatus('Modified');
    }
}

async function saveFile() {
    if (!currentFilePath || !isDirty) return;
    
    const content = document.getElementById('editor-textarea').value;
    
    try {
        await invoke('write_file', { path: currentFilePath, content });
        isDirty = false;
        updateStatus('Saved');
        
        // Notify preview window to refresh
        if (previewWindow) {
            await invoke('refresh_preview', { window: previewWindow });
        }
    } catch (err) {
        console.error('Failed to save file:', err);
        updateStatus('Error saving');
    }
}

function scheduleAutoSave() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    
    saveTimeout = setTimeout(() => {
        saveFile();
    }, 500); // Save after 500ms of inactivity
}

// Set up event listeners
document.addEventListener('DOMContentLoaded', async () => {
    await initialize();
    
    const textarea = document.getElementById('editor-textarea');
    
    // Track changes
    textarea.addEventListener('input', () => {
        markDirty();
        scheduleAutoSave();
    });
    
    // Handle close button
    document.getElementById('close-btn').addEventListener('click', async () => {
        if (isDirty) {
            await saveFile();
        }
        appWindow.close();
    });
    
    // Handle keyboard shortcuts
    document.addEventListener('keydown', async (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        
        if (ctrl && e.key === 's') {
            e.preventDefault();
            await saveFile();
        } else if (ctrl && e.key === 'w') {
            e.preventDefault();
            if (isDirty) {
                await saveFile();
            }
            appWindow.close();
        }
    });
    
    // Save on window close
    window.addEventListener('beforeunload', async (e) => {
        if (isDirty) {
            e.preventDefault();
            await saveFile();
        }
    });
});

// Listen for theme changes
listen('theme-changed', (event) => {
    document.documentElement.setAttribute('data-theme', event.payload);
});