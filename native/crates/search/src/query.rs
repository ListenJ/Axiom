use oc_shared::utils::tokenize_unique;
use rayon::prelude::*;
use std::collections::HashSet;

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

        for part in query.split_whitespace() {
            if part.starts_with("#") {
                tag_filters.push(part[1..].to_lowercase());
            } else if part.starts_with("para:") {
                para_filter = Some(part[5..].to_lowercase());
            } else if part.starts_with("-") {
                excluded.push(part[1..].to_lowercase());
            } else if part.starts_with('"') && part.ends_with('"') {
                exact_phrases.push(part[1..part.len() - 1].to_lowercase());
            } else {
                remaining.push_str(part);
                remaining.push(' ');
            }
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
