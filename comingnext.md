# BoltPage — Upcoming Feature Candidates

## High Impact — Differentiators

| Feature | Why it matters |
|---------|---------------|
| **Find and Replace** (editor) | Currently find-only. Basic expectation for any editor. |
| **Mermaid / diagram rendering** | Mermaid, PlantUML, or at minimum fenced code block diagrams. Major draw for technical users. |
| **Export to PDF / HTML** | Users expect to share rendered output. Print exists but dedicated export with styling is more useful. |
| **Table of Contents sidebar** | Auto-generated from headings. Clickable navigation. Essential for long documents. |
| **Tabs / multi-file** | Open multiple files in one window instead of spawning separate windows. |

## Medium Impact — Polish

| Feature | Why it matters |
|---------|---------------|
| **Line numbers in editor** | Standard expectation. Helps with JSON/YAML especially. |
| **Word count / reading time** | Small status bar addition. Writers expect it. |
| **Zoom in/out** (Ctrl+=/Ctrl+-) | Content scaling. Currently missing. |
| **Recent files list** | File > Open Recent. Reduces friction for repeat use. |
| **Drag and drop** | Drop a file onto the window to open it. |
| **Image preview in markdown** | Render local images inline (currently may not resolve relative paths). |
| **Auto-pair brackets/quotes** in editor | `(`, `[`, `"`, `` ` `` auto-close. Small but expected. |

## Lower Effort — Quick Wins

| Feature | Why it matters |
|---------|---------------|
| **Keyboard shortcut overlay** (Ctrl+?) | Discoverability. Shows all available shortcuts. |
| **Go to line** (Ctrl+G) in editor | Standard editor feature. |
| **Word wrap toggle** in editor | Some users want no-wrap for tables/code. |
| **Syntax highlighting in editor** | Even basic keyword coloring in the textarea (or switch to a lightweight code editor component). |

## Strategic Decision

The biggest architectural decision is whether BoltPage stays a **viewer with light editing** or moves toward being a **full editing environment**. The current textarea-based editor limits what's possible (no syntax highlighting, no line numbers, no multi-cursor). Switching to a proper editor component (CodeMirror, Monaco) would unlock most of the editor features above but is a significant change.
