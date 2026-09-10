use oc_shared::utils::tokenize_unique;

#[derive(Debug, Clone)]
pub struct QueryPlan {
    pub tokens: Vec<String>,
    pub exact_phrases: Vec<String>,
    pub excluded: Vec<String>,
    pub tag_filters: Vec<String>,
    pub para_filter: Option<String>,
}

impl QueryPlan {
    pub fn parse(query: &str) -> Self {
        let mut exact_phrases = vec![];
        let mut excluded = vec![];
        let mut tag_filters = vec![];
        let mut para_filter = None;
        let mut remaining = String::new();
        let mut open_phrase: Option<String> = None;

        for part in query.split_whitespace() {
            if let Some(mut acc) = open_phrase.take() {
                acc.push(' ');
                if part.ends_with('"') && part.len() >= 2 {
                    acc.push_str(&part[..part.len() - 1]);
                    exact_phrases.push(acc.to_lowercase());
                } else {
                    acc.push_str(part);
                    open_phrase = Some(acc);
                }
                continue;
            }
            if part.starts_with("#") {
                tag_filters.push(part[1..].to_lowercase());
            } else if part.starts_with("para:") {
                para_filter = Some(part[5..].to_lowercase());
            } else if part.starts_with("-") {
                excluded.push(part[1..].to_lowercase());
            } else if part.len() >= 2 && part.starts_with('"') && part.ends_with('"') {
                exact_phrases.push(part[1..part.len() - 1].to_lowercase());
            } else if part.len() >= 2 && part.starts_with('"') {
                open_phrase = Some(part[1..].to_string());
            } else {
                remaining.push_str(part);
                remaining.push(' ');
            }
        }

        if let Some(acc) = open_phrase {
            remaining.push('"');
            remaining.push_str(&acc);
            remaining.push(' ');
        }

        let tokens = tokenize_unique(&remaining);
        Self {
            tokens,
            exact_phrases,
            excluded,
            tag_filters,
            para_filter,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
            && self.exact_phrases.is_empty()
            && self.tag_filters.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_quote_token_does_not_panic() {
        let plan = QueryPlan::parse("\"");
        assert!(plan.exact_phrases.is_empty());
        let plan2 = QueryPlan::parse("\"exact phrase\"");
        assert_eq!(plan2.exact_phrases, vec!["exact phrase".to_string()]);
    }
}
