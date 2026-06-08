use aho_corasick::AhoCorasick;
use regex::Regex;
use std::sync::OnceLock;

pub fn tokenize(text: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());
    re.find_iter(text)
        .map(|m| m.as_str().to_lowercase())
        .collect()
}

pub fn tokenize_unique(text: &str) -> Vec<String> {
    let mut tokens = tokenize(text);
    tokens.sort_unstable();
    tokens.dedup();
    tokens
}

pub fn score_tokens(query_tokens: &[String], target_tokens: &[String]) -> f64 {
    if query_tokens.is_empty() || target_tokens.is_empty() {
        return 0.0;
    }
    let matches = query_tokens
        .iter()
        .filter(|qt| target_tokens.iter().any(|tt| tt == *qt))
        .count();
    matches as f64 / query_tokens.len().max(target_tokens.len()) as f64
}

pub fn extract_excerpt(content: &str, query_tokens: &[String], radius: usize) -> String {
    let lower = content.to_lowercase();
    let positions: Vec<usize> = query_tokens
        .iter()
        .filter_map(|t| lower.find(t))
        .collect();
    if positions.is_empty() {
        return content.chars().take(200).collect();
    }
    let mut ranges: Vec<(usize, usize)> = positions
        .iter()
        .map(|&p| {
            let start = p.saturating_sub(radius);
            let end = (p + radius).min(content.len());
            (start, end)
        })
        .collect();
    ranges.sort_by_key(|r| r.0);
    let mut merged = vec![];
    for (s, e) in ranges {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }
    merged
        .iter()
        .map(|(s, e)| &content[*s..*e])
        .collect::<Vec<_>>()
        .join(" ... ")
}

pub fn slugify(input: &str) -> String {
    input
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .replace("--", "-")
        .trim_matches('-')
        .to_string()
}
