use crate::trie::MethodRouter;
use crate::cache::RouteCache;
use dashmap::DashMap;
use oc_shared::types::{PerfMetrics, RouteRecord};
use std::collections::HashMap;
use std::sync::Arc;

pub struct RouterEngine {
    methods: DashMap<String, MethodRouter>,
    cache: RouteCache,
    perf: DashMap<String, Vec<u64>>,
    error_counts: DashMap<String, u64>,
    request_counts: DashMap<String, u64>,
    registry: Arc<oc_shared::metrics::MetricsRegistry>,
}

impl RouterEngine {
    pub fn new() -> Self {
        Self {
            methods: DashMap::new(),
            cache: RouteCache::new(500, 30_000),
            perf: DashMap::new(),
            error_counts: DashMap::new(),
            request_counts: DashMap::new(),
            registry: Arc::new(oc_shared::metrics::MetricsRegistry::new()),
        }
    }

    pub fn register(&self, record: RouteRecord) {
        let method = record.method.to_uppercase();
        let mut router = self.methods.entry(method).or_insert_with(MethodRouter::new);
        router.register(&record.path, record.handler_id.clone());
    }

    pub fn register_batch(&self, records: Vec<RouteRecord>) {
        for r in records {
            self.register(r);
        }
    }

    pub fn lookup(&self, method: &str, path: &str) -> Option<(String, HashMap<String, String>)> {
        let start = std::time::Instant::now();
        let key = format!("{}:{}", method, path);

        // Cache check for GET
        if method.eq_ignore_ascii_case("GET") {
            if let Some(cached) = self.cache.get(&key) {
                self.registry.counter("route.cache_hit").inc();
                return Some((cached, HashMap::new()));
            }
        }

        let router = self.methods.get(method)?;
        let result = router.lookup(path);

        let latency = start.elapsed().as_micros() as u64;
        let endpoint = Self::normalize_endpoint(path);
        self.perf.entry(endpoint.clone()).or_default().push(latency);
        self.request_counts.entry(endpoint).and_modify(|c| *c += 1).or_insert(1);

        result.map(|(handler_id, params)| {
            if method.eq_ignore_ascii_case("GET") {
                self.cache.put(key, handler_id.to_string());
            }
            (handler_id.to_string(), params)
        })
    }

    pub fn get_perf_report(&self) -> HashMap<String, PerfMetrics> {
        let mut report = HashMap::new();
        for entry in self.perf.iter() {
            let endpoint = entry.key().clone();
            let mut latencies = entry.value().clone();
            if latencies.is_empty() { continue; }
            latencies.sort_unstable();
            let n = latencies.len() as u64;
            let total: u64 = latencies.iter().sum();
            let avg = total / n;
            let p95_idx = (n as f64 * 0.95) as usize;
            let p99_idx = (n as f64 * 0.99) as usize;
            let p95 = latencies.get(p95_idx.min(latencies.len() - 1)).copied().unwrap_or(0);
            let p99 = latencies.get(p99_idx.min(latencies.len() - 1)).copied().unwrap_or(0);
            let errors = self.error_counts.get(&endpoint).map(|e| *e).unwrap_or(0);
            let total_req = self.request_counts.get(&endpoint).map(|r| *r).unwrap_or(0);

            report.insert(endpoint, PerfMetrics {
                total_requests: total_req,
                total_latency_us: total,
                avg_latency_us: avg,
                p95_latency_us: p95,
                p99_latency_us: p99,
                errors,
                cache_hits: self.cache.hits(),
                cache_misses: self.cache.misses(),
            });
        }
        report
    }

    pub fn get_hotspot_report(&self) -> Vec<(String, u64, u64, String)> {
        let mut hotspots: Vec<(String, u64, u64, String)> = self
            .request_counts
            .iter()
            .map(|entry| {
                let endpoint = entry.key().clone();
                let count = *entry.value();
                let avg = self.perf.get(&endpoint)
                    .map(|v| if v.is_empty() { 0 } else { v.iter().sum::<u64>() / v.len() as u64 })
                    .unwrap_or(0);
                let suggestion = if avg > 5000 {
                    "Consider caching or optimize handler".to_string()
                } else if count > 1000 {
                    "High traffic — consider dedicated worker".to_string()
                } else {
                    "OK".to_string()
                };
                (endpoint, count, avg, suggestion)
            })
            .collect();
        hotspots.sort_by(|a, b| b.1.cmp(&a.1));
        hotspots.truncate(20);
        hotspots
    }

    pub fn get_routes(&self) -> Vec<(String, String)> {
        let mut routes = vec![];
        for entry in self.methods.iter() {
            let method = entry.key().clone();
            // We don't expose trie internals, just return method entries
            routes.push((method, "<trie>".to_string()));
        }
        routes
    }

    pub fn clear_cache(&self) {
        self.cache.clear();
    }

    fn normalize_endpoint(path: &str) -> String {
        let parts = path.split('/').collect::<Vec<_>>();
        let normalized: Vec<String> = parts
            .iter()
            .map(|part| {
            if part.parse::<u64>().is_ok() || part.len() == 36 && part.contains('-') {
                    ":id".to_string()
                } else {
                    (*part).to_string()
                }
            })
            .collect();
        normalized.join("/")
    }
}
