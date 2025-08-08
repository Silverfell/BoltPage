use pulldown_cmark::{html, Event, Options, Parser, Tag, TagEnd, CowStr};
use syntect::parsing::SyntaxSet;
use syntect::highlighting::ThemeSet;
use syntect::html::highlighted_html_for_string;
use once_cell::sync::Lazy;

static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(|| SyntaxSet::load_defaults_newlines());
static THEME_SET: Lazy<ThemeSet> = Lazy::new(|| ThemeSet::load_defaults());

pub fn parse_markdown(content: &str) -> String {
    parse_markdown_with_theme(content, "light")
}

pub fn parse_markdown_with_theme(content: &str, theme_name: &str) -> String {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    
    let parser = Parser::new_ext(content, options);
    
    // Try to choose syntect theme based on app theme - make it optional to prevent crashes
    let syntax_theme = match theme_name {
        "dark" | "drac" => {
            // Try dark themes first
            THEME_SET.themes.get("Monokai")
                .or_else(|| THEME_SET.themes.get("base16-ocean.dark"))
                .or_else(|| THEME_SET.themes.get("Solarized (dark)"))
                .or_else(|| THEME_SET.themes.values().next())
        },
        _ => {
            // Try light themes first  
            THEME_SET.themes.get("InspiredGitHub")
                .or_else(|| THEME_SET.themes.get("base16-ocean.light"))
                .or_else(|| THEME_SET.themes.get("Solarized (light)"))
                .or_else(|| THEME_SET.themes.values().next())
        }
    };
    
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
                
                // Try to highlight the code block
                let highlighted = if !code_block_lang.is_empty() && syntax_theme.is_some() {
                    if let Some(syntax) = SYNTAX_SET.find_syntax_by_token(&code_block_lang) {
                        highlighted_html_for_string(
                            &code_block_content,
                            &SYNTAX_SET,
                            syntax,
                            syntax_theme.unwrap(),
                        ).ok()
                    } else {
                        None
                    }
                } else {
                    None
                };
                
                // If highlighting succeeded, use it; otherwise fall back to plain code
                if let Some(html) = highlighted {
                    // Remove the wrapping <pre> tags as pulldown-cmark will add them
                    let html = html.trim_start_matches("<pre style=\"background-color:#");
                    let html = if let Some(pos) = html.find("\">") {
                        &html[pos + 2..]
                    } else {
                        &html
                    };
                    let html = html.trim_end_matches("</pre>\n");
                    
                    events.push(Event::Html(CowStr::from(format!("<div class=\"highlight\">{}</div>", html))));
                } else {
                    // Fallback to plain code
                    events.push(Event::Start(Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(CowStr::from(code_block_lang.clone())))));
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
    
    html_output
}

// Export theme names for the UI
pub fn get_syntax_themes() -> Vec<&'static str> {
    vec!["InspiredGitHub", "Monokai", "Solarized (dark)", "Solarized (light)"]
}