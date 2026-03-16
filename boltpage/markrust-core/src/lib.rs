use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use serde_json as serde_json_crate;
use serde_yaml as serde_yaml_crate;
use std::sync::OnceLock;
use syntect::highlighting::ThemeSet;
use syntect::html::{css_for_theme_with_class_style, ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static THEME_SET: OnceLock<ThemeSet> = OnceLock::new();

fn get_syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn get_theme_set() -> &'static ThemeSet {
    THEME_SET.get_or_init(ThemeSet::load_defaults)
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
                if !code_block_lang.is_empty() {
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
            _ => events.push(event),
        }
    }

    let mut html_output = String::new();
    html::push_html(&mut html_output, events.into_iter());

    ammonia::clean(&html_output)
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
