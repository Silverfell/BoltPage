use syntect::highlighting::ThemeSet;

fn main() {
    let theme_set = ThemeSet::load_defaults();
    println!("Available themes:");
    for (name, _) in &theme_set.themes {
        println!("  - {}", name);
    }
}