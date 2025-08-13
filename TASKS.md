# Task List

1. Preview PDF files (no edit)
   - Display `.pdf` files in preview mode only; disable or hide the Edit button.
   - Approach: use the webview's native PDF rendering by loading a Blob URL in an `<iframe>`/`<object>` sourced from file bytes read in Rust. Avoid bundling PDF.js/CMaps to keep the app small and fast.
   - Acceptance criteria:
     - Opening a `.pdf` shows the document with selectable/searchable text via the built-in viewer.
     - The Edit button is disabled/hidden for PDFs.
     - File watcher refresh works after external changes.

2. JSON preview and editing
   - Render `.json` via Rust: pretty-print with `serde_json` and convert to class-based highlighted HTML using `syntect` (JSON syntax). Inject HTML into the viewer; keep Edit enabled to use the existing text editor window.
   - Acceptance criteria:
     - Opening a `.json` shows highlighted HTML; theme switching updates styles without re-render logic.
     - Edit button opens the editor; saving updates the preview window automatically.
     - Invalid JSON displays a readable error block in the preview instead of crashing.

3. TXT preview and editing
   - Render `.txt` files with basic themed styling matching Markdown (same fonts, sizes, colors); display as escaped text in a `<pre>` container. Keep Edit enabled using the existing editor window.
   - Acceptance criteria:
     - Opening a `.txt` shows legible, themed text (no syntax highlighting) consistent with Markdown typography.
     - Edit button opens the editor; saving updates the preview window automatically.
   - Build size impact: ~0–30 KB (code only; no large assets added).

4. DOCX preview (Mammoth.js, no edit)
   - Integrate Mammoth to convert `.docx` to HTML client-side; load the library only when a `.docx` is opened. Preview only; Edit disabled.
   - Acceptance criteria:
     - Opening a `.docx` renders readable HTML (body text, headings, inline images where supported by Mammoth).
     - Edit button is disabled/hidden for `.docx`.
     - Library is lazy-loaded to minimize startup cost; added bundle size kept ≤ ~0.4 MB.

5. DOCX quick edit (Mammoth round-trip)
   - Allow text edits in a plain text editor view and write back to `.docx` using Mammoth-compatible round-trip where possible (body text, headings). No WYSIWYG.
   - Acceptance criteria:
     - Editing updates body text and headings and saves back to the `.docx` while preserving styles and structure to the extent supported by Mammoth.
     - Non-text elements (tables, images, footnotes, headers/footers) are preserved but not editable.
     - Clear limitations documented in UI.

