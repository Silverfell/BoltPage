use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde_json as serde_json_crate;
use serde_yaml as serde_yaml_crate;
use std::sync::OnceLock;
use syntect::highlighting::ThemeSet;
use syntect::html::{css_for_theme_with_class_style, ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::{SyntaxDefinition, SyntaxSet};

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static THEME_SET: OnceLock<ThemeSet> = OnceLock::new();
static SANITIZER: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
static CALLOUT_RE: OnceLock<regex::Regex> = OnceLock::new();

// Vendored .sublime-syntax packs for languages absent from syntect's
// default-fancy bundle. Embedded at compile-time via include_str! so the
// shipped binary carries them without runtime filesystem access.
// Sources: sharkdp/bat (Apache-2.0) for INI/Kotlin/Swift/TypeScript/TSX;
// asbjornenge/Docker.tmbundle (MIT) for Dockerfile; braver/SublimeSass (MIT)
// for SCSS; sublimehq/Packages (permissive) for TOML.
const EXTRA_SYNTAXES: &[(&str, &str)] = &[
    ("INI", include_str!("../syntaxes/INI.sublime-syntax")),
    ("Kotlin", include_str!("../syntaxes/Kotlin.sublime-syntax")),
    ("Swift", include_str!("../syntaxes/Swift.sublime-syntax")),
    (
        "TypeScript",
        include_str!("../syntaxes/TypeScript.sublime-syntax"),
    ),
    (
        "TSX",
        include_str!("../syntaxes/TypeScriptReact.sublime-syntax"),
    ),
    (
        "Dockerfile",
        include_str!("../syntaxes/Dockerfile.sublime-syntax"),
    ),
    ("SCSS", include_str!("../syntaxes/SCSS.sublime-syntax")),
    ("TOML", include_str!("../syntaxes/TOML.sublime-syntax")),
];

fn get_syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(|| {
        let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
        for (name, src) in EXTRA_SYNTAXES {
            let def = SyntaxDefinition::load_from_str(src, true, Some(name))
                .unwrap_or_else(|e| panic!("bundled syntax {name} failed to parse: {e}"));
            builder.add(def);
        }
        builder.build()
    })
}

fn get_theme_set() -> &'static ThemeSet {
    THEME_SET.get_or_init(ThemeSet::load_defaults)
}

/// Cached ammonia sanitizer.
///
/// Adds `class` to the generic-attribute whitelist so that syntect's
/// `ClassedHTMLGenerator` output (many dot-split class names per token)
/// survives sanitization, along with our own trusted classes on
/// `<div class="callout …">`, `<span class="math …">`, `<pre class="mermaid">`.
/// Dangerous tags (script, iframe, object, etc.) are still excluded by
/// ammonia's default tag whitelist.
fn sanitizer() -> &'static ammonia::Builder<'static> {
    SANITIZER.get_or_init(|| {
        let mut b = ammonia::Builder::default();
        b.add_generic_attributes(&["class"]);
        // Task-list checkboxes emitted by pulldown-cmark's ENABLE_TASKLISTS
        // option: <input type="checkbox" disabled [checked]>. `input` is not
        // in ammonia's default tag set.
        b.add_tags(&["input"]);
        b.add_tag_attributes("input", &["type", "checked", "disabled"]);
        b
    })
}

fn callout_regex() -> &'static regex::Regex {
    CALLOUT_RE.get_or_init(|| {
        regex::Regex::new(
            r#"(?s)<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*?)</p>(.*?)</blockquote>"#,
        )
        .expect("callout regex must compile")
    })
}

fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#039;"),
            _ => out.push(ch),
        }
    }
    out
}

fn highlight_code(text: &str, syntax_tokens: &[&str], lang_class: &str) -> Result<String, String> {
    let syntax_set = get_syntax_set();
    let syntax = syntax_tokens
        .iter()
        .find_map(|token| syntax_set.find_syntax_by_token(token))
        .ok_or_else(|| format!("{lang_class} syntax not found"))?;

    let mut generator =
        ClassedHTMLGenerator::new_with_class_style(syntax, syntax_set, ClassStyle::Spaced);
    for line in text.lines() {
        let _ = generator.parse_html_for_line_which_includes_newline(&format!("{line}\n"));
    }
    let highlighted = generator.finalize();
    Ok(format!(
        "<div class=\"highlight\"><pre><code class=\"language-{lang_class}\">{highlighted}</code></pre></div>"
    ))
}

fn rewrite_callouts(input: &str) -> String {
    callout_regex()
        .replace_all(input, |caps: &regex::Captures| {
            let kind_raw = &caps[1];
            let kind_lower = kind_raw.to_ascii_lowercase();
            let first_para = &caps[2];
            let rest = &caps[3];
            format!(
                r#"<div class="callout callout-{kind_lower}"><div class="callout-title">{kind_raw}</div><div class="callout-body"><p>{first_para}</p>{rest}</div></div>"#
            )
        })
        .into_owned()
}

pub fn parse_markdown(content: &str) -> String {
    parse_markdown_with_theme(content, "light")
}

/// Theme is applied via CSS class on the frontend; param reserved for future per-render theming.
pub fn parse_markdown_with_theme(content: &str, _theme_name: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_MATH);

    let parser = Parser::new_ext(content, options);

    let mut in_code_block = false;
    let mut code_block_lang = String::new();
    let mut code_block_content = String::new();

    let mut events = Vec::new();

    for event in parser {
        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                in_code_block = true;
                code_block_lang = match kind {
                    pulldown_cmark::CodeBlockKind::Fenced(lang) => lang.to_string(),
                    _ => String::new(),
                };
                code_block_content.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                if code_block_lang == "mermaid" {
                    events.push(Event::Html(CowStr::from(format!(
                        r#"<pre class="mermaid">{}</pre>"#,
                        escape_html(&code_block_content)
                    ))));
                } else if !code_block_lang.is_empty() {
                    if let Ok(block) =
                        highlight_code(&code_block_content, &[&code_block_lang], &code_block_lang)
                    {
                        events.push(Event::Html(CowStr::from(block)));
                    } else {
                        events.push(Event::Start(Tag::CodeBlock(
                            pulldown_cmark::CodeBlockKind::Fenced(CowStr::from(
                                code_block_lang.clone(),
                            )),
                        )));
                        events.push(Event::Text(CowStr::from(code_block_content.clone())));
                        events.push(Event::End(TagEnd::CodeBlock));
                    }
                } else {
                    events.push(Event::Start(Tag::CodeBlock(
                        pulldown_cmark::CodeBlockKind::Fenced(CowStr::from(
                            code_block_lang.clone(),
                        )),
                    )));
                    events.push(Event::Text(CowStr::from(code_block_content.clone())));
                    events.push(Event::End(TagEnd::CodeBlock));
                }

                code_block_lang.clear();
                code_block_content.clear();
            }
            Event::Text(text) if in_code_block => {
                code_block_content.push_str(&text);
            }
            Event::InlineMath(text) => {
                events.push(Event::Html(CowStr::from(format!(
                    r#"<span class="math math-inline">{}</span>"#,
                    escape_html(&text)
                ))));
            }
            Event::DisplayMath(text) => {
                events.push(Event::Html(CowStr::from(format!(
                    r#"<div class="math math-display">{}</div>"#,
                    escape_html(&text)
                ))));
            }
            _ => events.push(event),
        }
    }

    let mut html_output = String::new();
    html::push_html(&mut html_output, events.into_iter());

    let with_callouts = rewrite_callouts(&html_output);
    sanitizer().clean(&with_callouts).to_string()
}

pub fn get_syntax_theme_css(theme_name: &str) -> Option<String> {
    let theme_set = get_theme_set();
    let theme = match theme_name {
        "dark" | "drac" => theme_set
            .themes
            .get("Monokai")
            .or_else(|| theme_set.themes.get("base16-ocean.dark"))
            .or_else(|| theme_set.themes.get("Solarized (dark)")),
        _ => theme_set
            .themes
            .get("InspiredGitHub")
            .or_else(|| theme_set.themes.get("base16-ocean.light"))
            .or_else(|| theme_set.themes.get("Solarized (light)")),
    }
    .or_else(|| theme_set.themes.values().next())?;

    let css = css_for_theme_with_class_style(theme, ClassStyle::Spaced).ok()?;
    Some(css)
}

/// Theme is applied via CSS class on the frontend; param reserved for future per-render theming.
pub fn parse_json_with_theme(content: &str, _theme_name: &str) -> Result<String, String> {
    let json_value: serde_json_crate::Value =
        serde_json_crate::from_str(content).map_err(|e| format!("Invalid JSON: {e}"))?;
    let pretty = serde_json_crate::to_string_pretty(&json_value)
        .map_err(|e| format!("Failed to pretty-print JSON: {e}"))?;
    highlight_code(&pretty, &["JSON", "json"], "json")
}

/// Theme is applied via CSS class on the frontend; param reserved for future per-render theming.
///
/// Note: serde_yaml 0.9 uses `IndexMap` for `Mapping`, so key insertion order
/// from the source document is preserved through the parse/serialize round-trip.
pub fn parse_yaml_with_theme(content: &str, _theme_name: &str) -> Result<String, String> {
    let yaml_value: serde_yaml_crate::Value =
        serde_yaml_crate::from_str(content).map_err(|e| format!("Invalid YAML: {e}"))?;
    let pretty = serde_yaml_crate::to_string(&yaml_value)
        .map_err(|e| format!("Failed to pretty-print YAML: {e}"))?;
    highlight_code(&pretty, &["YAML", "yaml", "yml"], "yaml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_math_emits_math_inline_span() {
        let out = parse_markdown("A $\\alpha + \\beta$ B");
        assert!(
            out.contains(r#"<span class="math math-inline">"#),
            "got: {out}"
        );
        assert!(out.contains(r"\alpha + \beta"), "got: {out}");
    }

    #[test]
    fn display_math_emits_math_display_div() {
        let out = parse_markdown("$$\\int_0^1 x\\,dx$$");
        assert!(
            out.contains(r#"<div class="math math-display">"#),
            "got: {out}"
        );
        assert!(out.contains(r"\int_0^1 x\,dx"), "got: {out}");
    }

    #[test]
    fn mermaid_fence_emits_pre_class() {
        let out = parse_markdown("```mermaid\ngraph TD;A-->B\n```\n");
        assert!(out.contains(r#"<pre class="mermaid">"#), "got: {out}");
        assert!(out.contains("graph TD;A--&gt;B"), "got: {out}");
    }

    #[test]
    fn callout_note_rewrites_blockquote() {
        let out = parse_markdown("> [!NOTE]\n> Hello\n");
        assert!(
            out.contains(r#"<div class="callout callout-note">"#),
            "got: {out}"
        );
        assert!(
            out.contains(r#"<div class="callout-title">NOTE</div>"#),
            "got: {out}"
        );
        assert!(out.contains("Hello"), "got: {out}");
    }

    #[test]
    fn callout_all_kinds_render() {
        for kind in ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] {
            let input = format!("> [!{kind}]\n> body\n");
            let out = parse_markdown(&input);
            let expected = format!(
                r#"<div class="callout callout-{}">"#,
                kind.to_ascii_lowercase()
            );
            assert!(out.contains(&expected), "kind={kind} got: {out}");
        }
    }

    #[test]
    fn syntect_classes_survive_sanitization() {
        let out = parse_markdown("```rust\nfn main() { println!(\"hi\"); }\n```\n");
        // syntect emits spans with `class="source rust …"` (ClassStyle::Spaced).
        // The old ammonia::clean stripped them; the Builder keeps class now.
        assert!(
            out.contains(r#"<span class="source rust"#),
            "syntect classes stripped; got: {out}"
        );
        assert!(
            out.contains(r#"class="language-rust""#),
            "language-rust class stripped; got: {out}"
        );
    }

    #[test]
    fn preserves_core_features() {
        let out = parse_markdown("| a | b |\n|---|---|\n| 1 | 2 |\n");
        assert!(out.contains("<table>"), "table missing: {out}");

        let out = parse_markdown("- [x] done\n- [ ] todo\n");
        assert!(
            out.contains(r#"type="checkbox""#),
            "task list missing: {out}"
        );

        let out = parse_markdown("~~gone~~\n");
        assert!(out.contains("<del>"), "strikethrough missing: {out}");

        let out = parse_markdown("ref[^1]\n\n[^1]: note\n");
        assert!(out.contains("footnote"), "footnote missing: {out}");
    }

    /// Verifies that the syntaxes we expect to be present in syntect's
    /// `default-fancy` feature are, in fact, present. These are the ones
    /// confirmed by an audit run against syntect 5.2 on 2026-04-23.
    #[test]
    fn syntax_set_covers_core_languages() {
        let set = SyntaxSet::load_defaults_newlines();
        let required = [
            "rust", "js", "python", "go", "c", "cpp", "java", "ruby", "bash", "sh", "html", "css",
            "json", "yaml", "md", "sql", "diff",
        ];
        let mut missing = Vec::new();
        for token in required {
            if set.find_syntax_by_token(token).is_none() {
                missing.push(token);
            }
        }
        assert!(
            missing.is_empty(),
            "core language missing from default-fancy: {missing:?}"
        );
    }

    /// Asserts that every token covered by the vendored `syntaxes/` pack is
    /// resolvable via `get_syntax_set()` — i.e. the previously-reported gaps
    /// (ts, tsx, swift, scss, kotlin, toml, dockerfile, ini) are all bundled.
    #[test]
    fn bundled_syntax_set_covers_previously_reported_gaps() {
        let set = get_syntax_set();
        let required = [
            "ts",
            "tsx",
            "swift",
            "scss",
            "kotlin",
            "toml",
            "dockerfile",
            "ini",
        ];
        let missing: Vec<&str> = required
            .into_iter()
            .filter(|tok| set.find_syntax_by_token(tok).is_none())
            .collect();
        assert!(
            missing.is_empty(),
            "vendored syntaxes fail to cover: {missing:?}"
        );
    }
}
