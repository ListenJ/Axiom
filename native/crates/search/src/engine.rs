use crate::indexer::VaultIndex;
use crate::query::QueryPlan;
use lru::LruCache;
use oc_shared::types::{LiteNote, SearchOptions, SearchResult, VaultNote};
use parking_lot::Mutex;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;
use std::sync::Arc;

/// Deterministic search engine — zero-vector, zero-probability
pub struct DeterministicEngine {
    index: Arc<VaultIndex>,
    content_cache: Mutex<LruCache<String, String>>,
    vault_path: String,
    metrics: Arc<oc_shared::metrics::MetricsRegistry>,
}

impl DeterministicEngine {
    pub fn new(vault_path: String) -> Self {
        let index = Arc::new(VaultIndex::new(&vault_path));
        let cache_size = NonZeroUsize::new(256).unwrap();
        Self {
            index,
            content_cache: Mutex::new(LruCache::new(cache_size)),
            vault_path,
            metrics: Arc::new(oc_shared::metrics::MetricsRegistry::new()),
        }
    }

    pub fn search(&self, query: &str, opts: &SearchOptions) -> Vec<SearchResult> {
        let start = std::time::Instant::now();
        let plan = QueryPlan::parse(query);

        if plan.is_empty() {
            return vec![];
        }

        let mut candidates = self.collect_candidates(&plan, opts);
        self.score_and_rank(&mut candidates, &plan, opts);

        let results: Vec<SearchResult> = candidates
            .into_iter()
            .take(opts.limit)
            .map(|(note, score, reasons)| {
                let content = self.read_content(&note.path);
                let excerpt = oc_shared::utils::extract_excerpt(&content, &plan.tokens, 120);
                SearchResult {
                    note: VaultNote {
                        path: note.path.clone(),
                        title: note.title.clone(),
                        content,
                        frontmatter: note.frontmatter.clone(),
                        tags: note.tags.clone(),
                        wiki_links: note.wiki_links.clone(),
                        backlinks: note.backlinks.clone(),
                        word_count: note.word_count,
                        modified_at: note.modified_at,
                    },
                    score,
                    reasons,
                    excerpt,
                }
            })
            .collect();

        let elapsed = start.elapsed().as_micros() as u64;
        self.metrics.histogram("search.latency_us", vec![100, 500, 1000, 5000, 10000, 50000])
            .observe(elapsed);
        self.metrics.counter("search.total").inc();

        results
    }

    fn collect_candidates(
        &self,
        plan: &QueryPlan,
        opts: &SearchOptions,
    ) -> Vec<(Arc<LiteNote>, f64, Vec<String>)> {
        let mut paths: HashSet<String> = HashSet::new();
        let mut reasons_map: HashMap<String, Vec<String>> = HashMap::new();

        // 1. Exact match on path / title
        for entry in self.index.notes().iter() {
            let path = entry.key().clone();
            let note = entry.value().clone();
            let lower_path = path.to_lowercase();
            let lower_title = note.title.to_lowercase();

            for token in &plan.tokens {
                if lower_path.contains(token) || lower_title.contains(token) {
                    paths.insert(path.clone());
                    reasons_map
                        .entry(path.clone())
                        .or_default()
                        .push(format!("path/title match: {}", token));
                }
            }

            for phrase in &plan.exact_phrases {
                if lower_title.contains(phrase) {
                    paths.insert(path.clone());
                    reasons_map
                        .entry(path.clone())
                        .or_default()
                        .push(format!("exact title: {}", phrase));
                }
            }
        }

        // 2. Title word index
        for token in &plan.tokens {
            if let Some(set) = self.index.title_word_index().get(token) {
                for p in set.iter() {
                    paths.insert(p.clone());
                    reasons_map
                        .entry(p.clone())
                        .or_default()
                        .push(format!("title word: {}", token));
                }
            }
        }

        // 3. Tag filter (AND)
        if !plan.tag_filters.is_empty() {
            let mut tag_paths: Option<HashSet<String>> = None;
            for tag in &plan.tag_filters {
                let current: HashSet<String> = self
                    .index
                    .tag_index()
                    .get(tag)
                    .map(|s| s.iter().cloned().collect())
                    .unwrap_or_default();
                tag_paths = match tag_paths {
                    Some(prev) => Some(prev.intersection(&current).cloned().collect()),
                    None => Some(current),
                };
            }
            if let Some(tp) = tag_paths {
                paths = paths.intersection(&tp).cloned().collect();
            }
        }

        // 4. PARA filter
        if let Some(ref para) = opts.para_category {
            let para_paths: HashSet<String> = self
                .index
                .para_index()
                .get(para)
                .map(|s| s.iter().cloned().collect())
                .unwrap_or_default();
            paths = paths.intersection(&para_paths).cloned().collect();
        }

        // 5. Excluded words
        for ex in &plan.excluded {
            if let Some(set) = self.index.title_word_index().get(ex) {
                for p in set.iter() {
                    paths.remove(p);
                }
            }
        }

        // 6. Wiki-link propagation (2-hop)
        let mut hop2: HashSet<String> = HashSet::new();
        for p in &paths {
            if let Some(note) = self.index.get(p) {
                for link in &note.wiki_links {
                    hop2.insert(link.clone());
                    reasons_map
                        .entry(link.clone())
                        .or_default()
                        .push(format!("wiki-link from: {}", p));
                }
                for back in &note.backlinks {
                    hop2.insert(back.clone());
                    reasons_map
                        .entry(back.clone())
                        .or_default()
                        .push(format!("backlink from: {}", p));
                }
            }
        }
        for h in &hop2 {
            if !paths.contains(h) {
                paths.insert(h.clone());
            }
        }

        paths
            .into_iter()
            .filter_map(|p| {
                self.index.get(&p).map(|note| {
                    let reasons = reasons_map.get(&p).cloned().unwrap_or_default();
                    (note, 0.0, reasons)
                })
            })
            .collect()
    }

    fn score_and_rank(
        &self,
        candidates: &mut [(Arc<LiteNote>, f64, Vec<String>)],
        plan: &QueryPlan,
        _opts: &SearchOptions,
    ) {

        candidates.par_iter_mut().for_each(|(note, score, reasons)| {
            let title_tokens = oc_shared::utils::tokenize_unique(&note.title);
            let title_score = oc_shared::utils::score_tokens(
                &plan.tokens,
                &title_tokens,
            );

            let mut s = title_score * 30.0; // title weight

            // Tag match
            let tag_matches = plan
                .tokens
                .iter()
                .filter(|t| note.tags.iter().any(|tag| tag == *t))
                .count();
            s += tag_matches as f64 * 25.0;

            // Wiki-link relevance
            let link_matches = note
                .wiki_links
                .iter()
                .filter(|l| plan.tokens.iter().any(|t| l.to_lowercase().contains(t)))
                .count();
            s += link_matches as f64 * 10.0;

            // Backlink boost
            s += note.backlinks.len() as f64 * 4.0;

            // PARA semantic boost
            if let Some(para) = oc_shared::utils::slugify(&note.path).split('/').next() {
                if plan.tokens.iter().any(|t| para.contains(t)) {
                    s += 5.0;
                }
            }

            // Recency
            let now = std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let age_days = (now.saturating_sub(note.modified_at)) / 86400;
            s += (30.0 / (1.0 + age_days as f64)).min(5.0);

            *score = s;

            // Add score reason
            reasons.push(format!("score={:.1}", s));
        });

        candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    }

    fn read_content(&self, path: &str) -> String {
        {
            let mut cache = self.content_cache.lock();
            if let Some(content) = cache.get(path) {
                self.metrics.counter("content.cache_hit").inc();
                return content.clone();
            }
        }

        let full = std::path::Path::new(&self.vault_path).join(path);
        let content = std::fs::read_to_string(&full).unwrap_or_default();

        let mut cache = self.content_cache.lock();
        cache.put(path.to_string(), content.clone());
        self.metrics.counter("content.cache_miss").inc();
        content
    }

    pub fn stats(&self) -> HashMap<String, serde_json::Value> {
        let mut stats = HashMap::new();
        stats.insert("total_notes".to_string(), self.index.len().into());
        stats.insert(
            "cache_size".to_string(),
            self.content_cache.lock().len().into(),
        );
        stats
    }

    pub fn rebuild(&self) -> oc_shared::Result<usize> {
        self.index.rebuild()
    }
}
