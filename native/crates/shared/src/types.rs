use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultNote {
    pub path: String,
    pub title: String,
    pub content: String,
    pub frontmatter: HashMap<String, serde_json::Value>,
    pub tags: Vec<String>,
    pub wiki_links: Vec<String>,
    pub backlinks: Vec<String>,
    pub word_count: usize,
    pub modified_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub note: VaultNote,
    pub score: f64,
    pub reasons: Vec<String>,
    pub excerpt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiteNote {
    pub path: String,
    pub title: String,
    pub frontmatter: HashMap<String, serde_json::Value>,
    pub tags: Vec<String>,
    pub wiki_links: Vec<String>,
    pub backlinks: Vec<String>,
    pub word_count: usize,
    pub modified_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchOptions {
    pub limit: usize,
    pub types: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    pub para_category: Option<String>,
    pub date_range: Option<DateRange>,
    pub include_reasons: bool,
    /// M9：是否启用时间衰减新近度加分（默认关闭以保严格确定性）
    #[serde(default)]
    pub include_recency: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DateRange {
    pub after: Option<String>,
    pub before: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteRecord {
    pub method: String,
    pub path: String,
    pub handler_id: String,
    pub meta: Option<RouteMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteMeta {
    pub description: Option<String>,
    pub cacheable: bool,
    pub cache_ttl_ms: u64,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerfMetrics {
    pub total_requests: u64,
    pub total_latency_us: u64,
    pub avg_latency_us: u64,
    pub p95_latency_us: u64,
    pub p99_latency_us: u64,
    pub errors: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStatus {
    pub version: String,
    pub edition: String,
    pub uptime_secs: u64,
    pub memory_mb: usize,
    pub cpu_percent: f32,
    pub vault_notes: usize,
    pub active_connections: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DeploymentEdition {
    Local,
    Cloud,
}

impl std::fmt::Display for DeploymentEdition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeploymentEdition::Local => write!(f, "local"),
            DeploymentEdition::Cloud => write!(f, "cloud"),
        }
    }
}
