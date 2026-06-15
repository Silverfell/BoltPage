#!/bin/sh
# Builds the vendored CodeMirror 6 bundle at src/assets/vendor/codemirror/.
# Versions are pinned exactly; bump them here, re-run, and re-audit.
# The bundle is committed; this script only needs to run when upgrading.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$PROJECT_DIR/src/assets/vendor/codemirror"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

cd "$WORK_DIR"
npm init -y --silent > /dev/null

# Pinned exact versions (audited 2026-06-11: no eval / new Function).
npm install --silent --save-exact \
  codemirror@6.0.2 \
  @codemirror/view@6.43.1 \
  @codemirror/state@6.6.0 \
  @codemirror/commands@6.10.3 \
  @codemirror/language@6.12.3 \
  @codemirror/lang-markdown@6.5.0 \
  @codemirror/search@6.7.0 \
  @lezer/highlight@1.2.3

cat > entry.js << 'EOF'
// Explicit exports only. basicSetup is deliberately excluded: its searchKeymap
// (Mod-F) would conflict with BoltPage's docked find bar.
export {
    EditorView, keymap, lineNumbers, drawSelection, placeholder,
    rectangularSelection, crosshairCursor,
    highlightActiveLine, highlightActiveLineGutter, scrollPastEnd,
} from '@codemirror/view';
export { EditorState, Compartment, EditorSelection } from '@codemirror/state';
export {
    history, defaultKeymap, historyKeymap, undo, redo, indentWithTab,
} from '@codemirror/commands';
export {
    codeFolding, foldGutter, foldKeymap, foldAll, unfoldAll,
    syntaxHighlighting, HighlightStyle,
} from '@codemirror/language';
export { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
export {
    search, SearchQuery, setSearchQuery, getSearchQuery,
    findNext, findPrevious, replaceNext, replaceAll,
    highlightSelectionMatches,
} from '@codemirror/search';
export { classHighlighter, tags } from '@lezer/highlight';
EOF

npx --yes esbuild entry.js --bundle --minify --format=esm \
  --outfile=codemirror.min.js

# Vendor audit: the CSP (script-src 'self', no unsafe-eval) must hold.
if grep -q "eval(" codemirror.min.js || grep -q "new Function" codemirror.min.js; then
  echo "ERROR: bundle contains eval/new Function; aborting." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cp codemirror.min.js "$OUT_DIR/"

# Collect licenses (all MIT).
{
  for pkg in codemirror @codemirror/view @codemirror/state @codemirror/commands \
             @codemirror/language @codemirror/lang-markdown @codemirror/search \
             @lezer/highlight @lezer/common @lezer/markdown @lezer/lr \
             @codemirror/lang-html @codemirror/lang-css @codemirror/lang-javascript \
             @codemirror/autocomplete @codemirror/lint style-mod w3c-keyname crelt; do
    f="node_modules/$pkg/LICENSE"
    if [ -f "$f" ]; then
      echo "=== $pkg $(node -p "require('./node_modules/$pkg/package.json').version") ==="
      cat "$f"
      echo
    fi
  done
} > "$OUT_DIR/LICENSES.txt"

echo "Vendored $(wc -c < "$OUT_DIR/codemirror.min.js" | tr -d ' ') bytes to $OUT_DIR/codemirror.min.js"
