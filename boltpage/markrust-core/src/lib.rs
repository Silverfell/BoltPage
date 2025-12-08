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

pub fn parse_markdown(content: &str) -> String {
    parse_markdown_with_theme(content, "light")
}

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
    let syntax_set = get_syntax_set();

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
                    if let Some(syntax) = syntax_set.find_syntax_by_token(&code_block_lang) {
                        let mut generator = ClassedHTMLGenerator::new_with_class_style(
                            syntax,
                            syntax_set,
                            ClassStyle::Spaced,
                        );
                        for line in code_block_content.lines() {
                            let _ = generator
                                .parse_html_for_line_which_includes_newline(&format!("{}\n", line));
                        }
                        let highlighted = generator.finalize();
                        let block = format!(
                            "<div class=\"highlight\"><pre><code class=\"language-{}\">{}</code></pre></div>",
                            code_block_lang,
                            highlighted
                        );
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

pub fn get_syntax_themes() -> Vec<&'static str> {
    vec![
        "InspiredGitHub",
        "Monokai",
        "Solarized (dark)",
        "Solarized (light)",
    ]
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

pub fn parse_json_with_theme(content: &str, _theme_name: &str) -> Result<String, String> {
    let json_value: serde_json_crate::Value =
        serde_json_crate::from_str(content).map_err(|e| format!("Invalid JSON: {}", e))?;
    let pretty = serde_json_crate::to_string_pretty(&json_value)
        .map_err(|e| format!("Failed to pretty-print JSON: {}", e))?;

    let syntax_set = get_syntax_set();
    let syntax = syntax_set
        .find_syntax_by_token("JSON")
        .or_else(|| syntax_set.find_syntax_by_token("json"))
        .ok_or_else(|| "JSON syntax not found".to_string())?;

    let mut generator =
        ClassedHTMLGenerator::new_with_class_style(syntax, syntax_set, ClassStyle::Spaced);

    for line in pretty.lines() {
        let _ = generator.parse_html_for_line_which_includes_newline(&format!("{}\n", line));
    }

    let highlighted = generator.finalize();
    let html = format!(
        "<div class=\"highlight\"><pre><code class=\"language-json\">{}</code></pre></div>",
        highlighted
    );
    Ok(html)
}

pub fn parse_yaml_with_theme(content: &str, _theme_name: &str) -> Result<String, String> {
    let yaml_value: serde_yaml_crate::Value =
        serde_yaml_crate::from_str(content).map_err(|e| format!("Invalid YAML: {}", e))?;

    let pretty = serde_yaml_crate::to_string(&yaml_value)
        .map_err(|e| format!("Failed to pretty-print YAML: {}", e))?;

    let syntax_set = get_syntax_set();
    let syntax = syntax_set
        .find_syntax_by_token("YAML")
        .or_else(|| syntax_set.find_syntax_by_token("yaml"))
        .or_else(|| syntax_set.find_syntax_by_token("yml"))
        .ok_or_else(|| "YAML syntax not found".to_string())?;

    let mut generator =
        ClassedHTMLGenerator::new_with_class_style(syntax, syntax_set, ClassStyle::Spaced);

    for line in pretty.lines() {
        let _ = generator.parse_html_for_line_which_includes_newline(&format!("{}\n", line));
    }

    let highlighted = generator.finalize();
    let html = format!(
        "<div class=\"highlight\"><pre><code class=\"language-yaml\">{}</code></pre></div>",
        highlighted
    );
    Ok(html)
}
