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
    let lower_string = content.to_lowercase();
    let content_chars: Vec<char> = content.chars().collect();

    // 审计 K-2（2026-08-24）：此前按字节偏移直接切片 `&content[s..e]`，
    // 匹配位置 ±radius 极易落在多字节字符（如中文）中间，触发
    // `byte index not a char boundary` panic。现全部改为字符索引空间：
    // 字节偏移 → char index → 在 content 的 char 向量上取窗。
    // 极少数 Unicode 大小写映射会改变字符数（如 İ），此时退化为确定性前缀。
    let lower_chars: Vec<char> = lower_string.chars().collect();
    if lower_chars.len() != content_chars.len() {
        return content.chars().take(200).collect();
    }

    let positions: Vec<usize> = query_tokens
        .iter()
        .filter_map(|t| {
            lower_string
                .find(t.as_str())
                .map(|byte_pos| lower_string[..byte_pos].chars().count())
        })
        .collect();
    if positions.is_empty() {
        return content.chars().take(200).collect();
    }
    let mut ranges: Vec<(usize, usize)> = positions
        .iter()
        .map(|&p| {
            let start = p.saturating_sub(radius);
            let end = (p + radius).min(content_chars.len());
            (start, end)
        })
        .collect();
    ranges.sort_by_key(|r| r.0);
    let mut merged: Vec<(usize, usize)> = vec![];
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
        .map(|(s, e)| content_chars[*s..*e].iter().collect::<String>())
        .collect::<Vec<_>>()
        .join(" ... ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excerpt_cjk_does_not_panic_and_returns_window() {
        // 修复前：中文多字节边界切片必 panic（byte index not a char boundary）
        let content = "这是一段很长的中文内容，其中包含关键词条目，用于验证字符边界安全性。";
        let tokens = tokenize("关键词");
        let out = extract_excerpt(content, &tokens, 4);
        assert!(out.contains("关键词"));
    }

    #[test]
    fn excerpt_mixed_cjk_ascii_no_panic() {
        let content = "前言 ABCD 后记 更多中文内容 結尾";
        let tokens = tokenize("ABCD");
        let out = extract_excerpt(content, &tokens, 4);
        assert!(out.contains("ABCD"));
    }

    #[test]
    fn excerpt_no_match_returns_prefix() {
        assert_eq!(extract_excerpt("纯中文内容", &["absent".to_string()], 5), "纯中文内容");
    }
}

pub fn slugify(input: &str) -> String {
    input
        .to_lowercase()
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .replace("--", "-")
        .trim_matches('-')
        .to_string()
}
