use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

struct CacheEntry {
    value: String,
    created_at: Instant,
}

pub struct RouteCache {
    store: DashMap<String, CacheEntry>,
    max_size: usize,
    ttl_ms: u64,
    hits: AtomicU64,
    misses: AtomicU64,
}

impl RouteCache {
    pub fn new(max_size: usize, ttl_ms: u64) -> Self {
        Self {
            store: DashMap::new(),
            max_size,
            ttl_ms,
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let entry = self.store.get(key)?;
        if entry.created_at.elapsed() > Duration::from_millis(self.ttl_ms) {
            drop(entry);
            self.store.remove(key);
            self.misses.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        self.hits.fetch_add(1, Ordering::Relaxed);
        Some(entry.value.clone())
    }

    pub fn put(&self, key: String, value: String) {
        if self.store.len() >= self.max_size {
            // Simple eviction: remove a random entry
            if let Some(first) = self.store.iter().next() {
                let k = first.key().clone();
                drop(first);
                self.store.remove(&k);
            }
        }
        self.store.insert(key, CacheEntry {
            value,
            created_at: Instant::now(),
        });
    }

    pub fn clear(&self) {
        self.store.clear();
        self.hits.store(0, Ordering::Relaxed);
        self.misses.store(0, Ordering::Relaxed);
    }

    pub fn hits(&self) -> u64 {
        self.hits.load(Ordering::Relaxed)
    }

    pub fn misses(&self) -> u64 {
        self.misses.load(Ordering::Relaxed)
    }

    pub fn len(&self) -> usize {
        self.store.len()
    }
}
