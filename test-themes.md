# Theme Testing Document

This document tests all themes with various Markdown elements.

## Code Blocks with Syntax Highlighting

### JavaScript
```javascript
// Test JavaScript syntax highlighting
const app = {
    name: 'BoltPage',
    version: '1.0.0',
    themes: ['light', 'dark', 'system', 'drac'],
    
    initialize() {
        console.log(`Starting ${this.name} v${this.version}`);
        this.loadTheme();
    },
    
    loadTheme() {
        const theme = localStorage.getItem('theme') || 'system';
        document.documentElement.setAttribute('data-theme', theme);
    }
};

app.initialize();
```

### Rust
```rust
// Test Rust syntax highlighting
use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct Theme {
    name: String,
    colors: HashMap<String, String>,
}

impl Theme {
    fn new(name: &str) -> Self {
        let mut colors = HashMap::new();
        match name {
            "drac" => {
                colors.insert("bg".to_string(), "#282a36".to_string());
                colors.insert("fg".to_string(), "#f8f8f2".to_string());
                colors.insert("purple".to_string(), "#bd93f9".to_string());
                colors.insert("cyan".to_string(), "#8be9fd".to_string());
            }
            _ => {}
        }
        
        Self {
            name: name.to_string(),
            colors,
        }
    }
}
```

### Python
```python
# Test Python syntax highlighting
class ThemeManager:
    def __init__(self):
        self.themes = {
            'light': '#ffffff',
            'dark': '#0d1117', 
            'drac': '#282a36'
        }
        self.current_theme = 'system'
    
    def set_theme(self, theme_name):
        """Set the current theme"""
        if theme_name in self.themes:
            self.current_theme = theme_name
            print(f"Theme changed to: {theme_name}")
            return True
        return False
    
    def get_theme_color(self, theme_name):
        return self.themes.get(theme_name, '#ffffff')

# Test usage
manager = ThemeManager()
manager.set_theme('drac')
```

## Tables

| Theme | Background | Text Color | Accent |
|-------|------------|------------|---------|
| Light | `#ffffff` | `#24292e` | `#0366d6` |
| Dark | `#0d1117` | `#c9d1d9` | `#58a6ff` |
| Drac | `#282a36` | `#f8f8f2` | `#bd93f9` |
| System | *Auto* | *Auto* | *Auto* |

## Task Lists

- [x] Implement light theme
- [x] Implement dark theme  
- [x] Implement system theme
- [x] Implement Dracula theme
- [x] Add theme persistence
- [x] Add cross-window synchronization
- [ ] Add theme customization options

## Blockquotes

> The Dracula theme is a dark theme for many editors, shells, and more.
> 
> > It uses a specific color palette that's easy on the eyes:
> > - Background: `#282a36`
> > - Foreground: `#f8f8f2` 
> > - Purple: `#bd93f9`
> > - Cyan: `#8be9fd`

## Links and Emphasis

Test **bold text**, *italic text*, and ***bold italic text*** in different themes.

Here's a [link to Dracula theme](https://draculatheme.com/) for reference.

## Code Spans

Use `Ctrl+T` to cycle themes, or `document.documentElement.setAttribute('data-theme', 'drac')` in the console.

---

Switch between themes using the theme button in the toolbar to see how syntax highlighting adapts!