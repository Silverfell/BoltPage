use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd, CowStr};
use syntect::parsing::SyntaxSet;
use syntect::highlighting::ThemeSet;
use syntect::html::{ClassedHTMLGenerator, ClassStyle, css_for_theme_with_class_style};
use once_cell::sync::Lazy;
use serde_json as serde_json_crate;

static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(|| SyntaxSet::load_defaults_newlines());
static THEME_SET: Lazy<ThemeSet> = Lazy::new(|| ThemeSet::load_defaults());

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
    
    for event in parser {
        match event {
            // Drop any raw HTML from the source markdown (inline or block)
            Event::Html(_) | Event::InlineHtml(_) => {
                // Skip dangerous raw HTML entirely
            }
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
                // Highlight using class-based HTML to allow CSS-only theme switching
                if !code_block_lang.is_empty() {
                    if let Some(syntax) = SYNTAX_SET.find_syntax_by_token(&code_block_lang) {
                        let mut generator = ClassedHTMLGenerator::new_with_class_style(
                            syntax,
                            &SYNTAX_SET,
                            ClassStyle::Spaced,
                        );
                        for line in code_block_content.lines() {
                            let _ = generator.parse_html_for_line_which_includes_newline(&format!("{}\n", line));
                        }
                        let highlighted = generator.finalize();
                        let block = format!(
                            "<div class=\"highlight\"><pre><code class=\"language-{}\">{}</code></pre></div>",
                            code_block_lang,
                            highlighted
                        );
                        events.push(Event::Html(CowStr::from(block)));
                    } else {
                        // Unknown language, fallback to plain fenced block
                        events.push(Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(CowStr::from(code_block_lang.clone())))));
                        events.push(Event::Text(CowStr::from(code_block_content.clone())));
                        events.push(Event::End(TagEnd::CodeBlock));
                    }
                } else {
                    // No language, fallback to plain fenced block
                    events.push(Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(CowStr::from(code_block_lang.clone())))));
                    events.push(Event::Text(CowStr::from(code_block_content.clone())));
                    events.push(Event::End(TagEnd::CodeBlock));
                }
                
                code_block_lang.clear();
                code_block_content.clear();
            }
            // Sanitize links and images: only allow safe schemes
            Event::Start(Tag::Link { link_type, dest_url, title, id }) => {
                let safe = is_safe_href(dest_url.as_ref());
                let new_dest: CowStr = if safe { dest_url } else { CowStr::from("#") };
                events.push(Event::Start(Tag::Link { link_type, dest_url: new_dest, title, id }));
            }
            Event::Start(Tag::Image { link_type, dest_url, title, id }) => {
                let safe = is_safe_img_src(dest_url.as_ref());
                let new_dest: CowStr = if safe { dest_url } else { CowStr::from("") };
                events.push(Event::Start(Tag::Image { link_type, dest_url: new_dest, title, id }));
            }
            Event::Text(text) if in_code_block => {
                code_block_content.push_str(&text);
            }
            _ => events.push(event),
        }
    }
    
    let mut html_output = String::new();
    html::push_html(&mut html_output, events.into_iter());

    // Final pass: neutralize any remaining unsafe href/src patterns in the generated HTML
    sanitize_generated_html(&html_output)
}

// Export theme names for the UI
pub fn get_syntax_themes() -> Vec<&'static str> {
    vec!["InspiredGitHub", "Monokai", "Solarized (dark)", "Solarized (light)"]
}

// Generate CSS for the given theme to style class-based highlighted code.
pub fn get_syntax_theme_css(theme_name: &str) -> Option<String> {
    // Pick a theme similar to earlier selection behavior
    let theme = match theme_name {
        "dark" | "drac" => {
            THEME_SET.themes.get("Monokai")
                .or_else(|| THEME_SET.themes.get("base16-ocean.dark"))
                .or_else(|| THEME_SET.themes.get("Solarized (dark)"))
        }
        _ => {
            THEME_SET.themes.get("InspiredGitHub")
                .or_else(|| THEME_SET.themes.get("base16-ocean.light"))
                .or_else(|| THEME_SET.themes.get("Solarized (light)"))
        }
    }.or_else(|| THEME_SET.themes.values().next())?;

    let css = css_for_theme_with_class_style(theme, ClassStyle::Spaced).ok()?;
    Some(css)
}

/// Pretty-print JSON and return class-based highlighted HTML for the JSON syntax
pub fn parse_json_with_theme(content: &str, _theme_name: &str) -> Result<String, String> {
    // Pretty-print
    let json_value: serde_json_crate::Value = serde_json_crate::from_str(content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    let pretty = serde_json_crate::to_string_pretty(&json_value)
        .map_err(|e| format!("Failed to pretty-print JSON: {}", e))?;

    // Highlight as JSON
    let syntax = SYNTAX_SET
        .find_syntax_by_token("JSON")
        .or_else(|| SYNTAX_SET.find_syntax_by_token("json"))
        .ok_or_else(|| "JSON syntax not found".to_string())?;

    let mut generator = ClassedHTMLGenerator::new_with_class_style(
        syntax,
        &SYNTAX_SET,
        ClassStyle::Spaced,
    );

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

// --- Helpers: URL and HTML sanitization ---
fn is_safe_href(dest: &str) -> bool {
    let d = dest.trim().to_lowercase();
    d.starts_with("http:") || d.starts_with("https:") || d.starts_with("mailto:")
}

fn is_safe_img_src(dest: &str) -> bool {
    let d = dest.trim().to_lowercase();
    if d.starts_with("http:") || d.starts_with("https:") {
        return true;
    }
    if let Some(rest) = d.strip_prefix("data:") {
        // allow data:image/* only
        return rest.starts_with("image/");
    }
    false
}

fn sanitize_generated_html(html: &str) -> String {
    // Best-effort sanitizer for href/src attributes; keeps UTF-8 intact.
    let mut out = String::with_capacity(html.len());
    let mut pos = 0usize;
    let pat_href = "href=\"";
    let pat_src = "src=\"";
    loop {
        // Find next href or src occurrence
        let slice = &html[pos..];
        let next_href = slice.find(pat_href).map(|i| (i, 0));
        let next_src = slice.find(pat_src).map(|i| (i, 1));
        let next = match (next_href, next_src) {
            (Some(h), Some(s)) => if h.0 <= s.0 { Some((h.0, 0)) } else { Some((s.0, 1)) },
            (Some(h), None) => Some((h.0, 0)),
            (None, Some(s)) => Some((s.0, 1)),
            (None, None) => None,
        };
        if let Some((idx, kind)) = next {
            let abs = pos + idx;
            // copy text before the attribute unchanged
            out.push_str(&html[pos..abs]);
            if kind == 0 {
                // href
                out.push_str(pat_href);
                let val_start = abs + pat_href.len();
                if let Some(end_rel) = html[val_start..].find('"') {
                    let val_end = val_start + end_rel;
                    let val = &html[val_start..val_end];
                    if is_safe_href(val) {
                        out.push_str(val);
                    } else {
                        out.push('#');
                    }
                    out.push('"');
                    pos = val_end + 1; // past closing quote
                } else {
                    // no closing quote, stop processing
                    out.push_str(&html[val_start..]);
                    break;
                }
            } else {
                // src
                out.push_str(pat_src);
                let val_start = abs + pat_src.len();
                if let Some(end_rel) = html[val_start..].find('"') {
                    let val_end = val_start + end_rel;
                    let val = &html[val_start..val_end];
                    if is_safe_img_src(val) {
                        out.push_str(val);
                    } else {
                        // leave empty src
                    }
                    out.push('"');
                    pos = val_end + 1;
                } else {
                    out.push_str(&html[val_start..]);
                    break;
                }
            }
        } else {
            // no more attributes; copy rest
            out.push_str(slice);
            break;
        }
    }
    out
}
