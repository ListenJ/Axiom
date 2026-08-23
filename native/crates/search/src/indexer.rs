use dashmap::DashMap;
use oc_shared::types::LiteNote;
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

/// In-memory index for vault notes — zero-allocation lookups
pub struct VaultIndex {
    notes: DashMap<String, Arc<LiteNote>>,
    title_word: DashMap<String, HashSet<String>>,
    tag: DashMap<String, HashSet<String>>,
    wiki_out: DashMap<String, HashSet<String>>,
    wiki_in: DashMap<String, HashSet<String>>,
    para: DashMap<String, HashSet<String>>,
    last_modified: RwLock<u64>,
    vault_path: PathBuf,
}

impl VaultIndex {
    pub fn new(vault_path: impl AsRef<Path>) -> Self {
        let path = vault_path.as_ref().to_path_buf();
        let this = Self {
            notes: DashMap::new(),
            title_word: DashMap::new(),
            tag: DashMap::new(),
            wiki_out: DashMap::new(),
            wiki_in: DashMap::new(),
            para: DashMap::new(),
            last_modified: RwLock::new(0),
            vault_path: path,
        };
        let _ = this.rebuild();
        this
    }

    pub fn rebuild(&self) -> oc_shared::Result<usize> {
        let start = std::time::Instant::now();
        let scanned = self.scan_dir(&self.vault_path, "")?;
        self.build_backlinks();
        let elapsed = start.elapsed();
        tracing::info!(
            "VaultIndex rebuilt: {} notes in {:?}",
            scanned,
            elapsed
        );
        Ok(scanned)
    }

    fn scan_dir(&self, base: &Path, rel: &str) -> oc_shared::Result<usize> {
        let full = base.join(rel);
        let entries = std::fs::read_dir(&full)?;
        let mut count = 0usize;

        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = entry.metadata()?;
            if meta.is_dir() {
                if name.starts_with('.') {
                    continue;
                }
                let child_rel = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", rel, name)
                };
                count += self.scan_dir(base, &child_rel)?;
            } else if name.ends_with(".md") {
                let note_path = if rel.is_empty() {
                    name.clone()
                } else {
                    format!("{}/{}", rel, name)
                };
                if let Ok(content) = std::fs::read_to_string(entry.path()) {
                    self.index_note(&note_path, &content);
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    fn index_note(&self, path: &str, content: &str) {
        let (frontmatter, body) = parse_frontmatter(content);
        let title = frontmatter
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                Path::new(path)
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            });
        let tags: Vec<String> = frontmatter
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_lowercase()))
                    .collect()
            })
            .unwrap_or_default();
        let wiki_links = extract_wiki_links(body);
        let word_count = body.split_whitespace().count();
        // M9：modified_at 必须取文件真实 mtime，而非索引时刻（否则每次重建都视为"刚修改"）
        let modified_at = std::fs::metadata(self.vault_path.join(path))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let note = Arc::new(LiteNote {
            path: path.to_string(),
            title: title.clone(),
            frontmatter,
            tags: tags.clone(),
            wiki_links: wiki_links.clone(),
            backlinks: vec![],
            word_count,
            modified_at,
        });

        self.notes.insert(path.to_string(), note);

        // Title word index
        for word in oc_shared::utils::tokenize_unique(&title) {
            self.title_word
                .entry(word)
                .or_default()
                .insert(path.to_string());
        }

        // Tag index
        for tag in &tags {
            self.tag.entry(tag.clone()).or_default().insert(path.to_string());
        }

        // Wiki-link out index
        for link in &wiki_links {
            self.wiki_out
                .entry(link.clone())
                .or_default()
                .insert(path.to_string());
        }

        // PARA category
        if let Some(para) = detect_para(path) {
            self.para.entry(para).or_default().insert(path.to_string());
        }
    }

    fn build_backlinks(&self) {
        // Clear existing backlinks first
        for mut note in self.notes.iter_mut() {
            Arc::make_mut(&mut *note).backlinks.clear();
        }
        // Build from wiki_out
        for link_entry in self.wiki_out.iter() {
            let target = link_entry.key();
            for source in link_entry.value().iter() {
                if let Some(mut note_arc) = self.notes.get_mut(target) {
                    let note = Arc::make_mut(&mut *note_arc);
                    if !note.backlinks.contains(source) {
                        note.backlinks.push(source.clone());
                    }
                }
            }
        }
    }

    pub fn get(&self, path: &str) -> Option<Arc<LiteNote>> {
        self.notes.get(path).map(|r| r.clone())
    }

    pub fn len(&self) -> usize {
        self.notes.len()
    }

    pub fn title_word_index(&self) -> &DashMap<String, HashSet<String>> {
        &self.title_word
    }
    pub fn tag_index(&self) -> &DashMap<String, HashSet<String>> {
        &self.tag
    }
    pub fn wiki_out_index(&self) -> &DashMap<String, HashSet<String>> {
        &self.wiki_out
    }
    pub fn wiki_in_index(&self) -> &DashMap<String, HashSet<String>> {
        &self.wiki_in
    }
    pub fn para_index(&self) -> &DashMap<String, HashSet<String>> {
        &self.para
    }
    pub fn notes(&self) -> &DashMap<String, Arc<LiteNote>> {
        &self.notes
    }
}

fn parse_frontmatter(content: &str) -> (HashMap<String, serde_json::Value>, &str) {
    if !content.starts_with("---\n") {
        return (HashMap::new(), content);
    }
    if let Some(end) = content[4..].find("\n---\n") {
        let yaml_str = &content[4..4 + end];
        let body = &content[4 + end + 5..];
        match serde_yaml::from_str(yaml_str) {
            Ok(map) => return (map, body),
            Err(_) => return (HashMap::new(), content),
        }
    }
    (HashMap::new(), content)
}

fn extract_wiki_links(content: &str) -> Vec<String> {
    let mut links = vec![];
    let mut chars = content.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '[' {
            if chars.peek().map(|(_, ch)| *ch) == Some('[') {
                chars.next(); // consume second [
                let start = i + 2;
                let mut end = start;
                while let Some((j, ch)) = chars.next() {
                    if ch == ']' && chars.peek().map(|(_, c2)| *c2) == Some(']') {
                        chars.next();
                        end = j;
                        break;
                    }
                }
                let link = content[start..end].trim();
                let normalized = if let Some(pipe) = link.find('|') {
                    &link[..pipe]
                } else {
                    link
                };
                links.push(normalized.to_string());
            }
        }
    }
    links
}

fn detect_para(path: &str) -> Option<String> {
    let lower = path.to_lowercase();
    if lower.starts_with("00-meta/") {
        Some("meta".to_string())
    } else if lower.starts_with("01-projects/") {
        Some("projects".to_string())
    } else if lower.starts_with("02-areas/") {
        Some("areas".to_string())
    } else if lower.starts_with("03-resources/") {
        Some("resources".to_string())
    } else if lower.starts_with("04-conversations/") {
        Some("conversations".to_string())
    } else if lower.starts_with("05-archives/") {
        Some("archives".to_string())
    } else if lower.starts_with("memory/") {
        Some("memory".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_frontmatter_empty() {
        let (fm, body) = parse_frontmatter("Just content");
        assert!(fm.is_empty());
        assert_eq!(body, "Just content");
    }

    #[test]
    fn test_parse_frontmatter_with_yaml() {
        let text = "---\ntitle: Hello\ntags: [a, b]\n---\nBody here";
        let (fm, body) = parse_frontmatter(text);
        assert_eq!(fm.get("title").unwrap().as_str().unwrap(), "Hello");
        assert_eq!(body, "Body here");
    }

    #[test]
    fn test_extract_wiki_links() {
        let content = "See [[Other Note]] and [[Another|alias]]";
        let links = extract_wiki_links(content);
        assert_eq!(links, vec!["Other Note", "Another"]);
    }

    #[test]
    fn test_detect_para() {
        assert_eq!(detect_para("01-projects/AI.md"), Some("projects".to_string()));
        assert_eq!(detect_para("02-areas/Health.md"), Some("areas".to_string()));
        assert_eq!(detect_para("03-resources/Code.md"), Some("resources".to_string()));
        assert_eq!(detect_para("random.md"), None);
    }

    #[test]
    fn test_tokenize() {
        let tokens = oc_shared::utils::tokenize("Hello World!");
        assert_eq!(tokens, vec!["hello", "world"]);
    }

    #[test]
    fn test_slugify() {
        assert_eq!(oc_shared::utils::slugify("Hello World"), "hello-world");
    }

    #[test]
    fn modified_at_uses_file_mtime_not_index_time() {
        let dir = std::env::temp_dir().join(format!("oc-mtime-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.md");
        std::fs::write(&p, "---\ntitle: A\n---\nbody\n").unwrap();
        let older = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        set_mtime(&p, older);

        let idx = VaultIndex::new(&dir);
        let note = idx.get("a.md").unwrap();
        let want = older
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        assert_eq!(note.modified_at, want, "modified_at 必须等于文件 mtime");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn set_mtime(p: &std::path::Path, t: std::time::SystemTime) {
        let f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
}
