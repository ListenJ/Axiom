use std::collections::HashMap;

#[derive(Debug, Default)]
pub struct TrieNode {
    pub children: HashMap<String, TrieNode>,
    pub param: Option<String>,
    pub handler_id: Option<String>,
    pub wildcard: Option<String>,
}

impl TrieNode {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, segments: &[&str], handler_id: String) {
        if segments.is_empty() {
            self.handler_id = Some(handler_id);
            return;
        }
        let seg = segments[0];
        if seg.starts_with(':') {
            self.param = Some(seg[1..].to_string());
            if segments.len() == 1 {
                self.handler_id = Some(handler_id);
            } else {
                self.insert(&segments[1..], handler_id);
            }
            return;
        }
        if seg == "**" {
            self.wildcard = Some(handler_id);
            return;
        }
        let child = self.children.entry(seg.to_string()).or_default();
        child.insert(&segments[1..], handler_id);
    }

    pub fn match_path<'a>(&'a self, segments: &[&str]) -> Option<(&'a str, HashMap<String, String>)> {
        self.match_recursive(segments, HashMap::new())
    }

    fn match_recursive<'a>(&'a self, segments: &[&str], mut params: HashMap<String, String>) -> Option<(&'a str, HashMap<String, String>)> {
        if segments.is_empty() {
            return self.handler_id.as_ref().map(|id| (id.as_str(), params));
        }
        let seg = segments[0];

        // Exact match
        if let Some(child) = self.children.get(seg) {
            if let Some(result) = child.match_recursive(&segments[1..], params.clone()) {
                return Some(result);
            }
        }

        // Param match
        if let Some(ref param_name) = self.param {
            params.insert(param_name.clone(), seg.to_string());
            if let Some(result) = self.match_recursive(&segments[1..], params) {
                return Some(result);
            }
        }

        // Wildcard
        if let Some(ref id) = self.wildcard {
            return Some((id.as_str(), params));
        }

        None
    }
}

pub struct MethodRouter {
    root: TrieNode,
}

impl MethodRouter {
    pub fn new() -> Self {
        Self { root: TrieNode::new() }
    }

    pub fn register(&mut self, path: &str, handler_id: String) {
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        self.root.insert(&segments, handler_id);
    }

    pub fn lookup(&self, path: &str) -> Option<(&str, HashMap<String, String>)> {
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        self.root.match_path(&segments)
    }
}
