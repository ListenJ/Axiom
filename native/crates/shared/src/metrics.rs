use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Default)]
pub struct Counter {
    value: AtomicU64,
}

impl Counter {
    pub fn new() -> Self {
        Self {
            value: AtomicU64::new(0),
        }
    }
    pub fn inc(&self) -> u64 {
        self.value.fetch_add(1, Ordering::Relaxed) + 1
    }
    pub fn add(&self, n: u64) -> u64 {
        self.value.fetch_add(n, Ordering::Relaxed) + n
    }
    pub fn get(&self) -> u64 {
        self.value.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Default)]
pub struct Histogram {
    buckets: Vec<AtomicU64>,
    bucket_bounds: Vec<u64>,
    sum: AtomicU64,
    count: AtomicU64,
}

impl Histogram {
    pub fn new(bounds: Vec<u64>) -> Self {
        let n = bounds.len() + 1;
        Self {
            buckets: (0..n).map(|_| AtomicU64::new(0)).collect(),
            bucket_bounds: bounds,
            sum: AtomicU64::new(0),
            count: AtomicU64::new(0),
        }
    }

    pub fn observe(&self, value: u64) {
        let idx = self
            .bucket_bounds
            .iter()
            .position(|&b| value <= b)
            .unwrap_or(self.buckets.len() - 1);
        self.buckets[idx].fetch_add(1, Ordering::Relaxed);
        self.sum.fetch_add(value, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn p95(&self) -> u64 {
        self.quantile(0.95)
    }

    pub fn p99(&self) -> u64 {
        self.quantile(0.99)
    }

    fn quantile(&self, q: f64) -> u64 {
        let total = self.count.load(Ordering::Relaxed) as f64;
        if total == 0.0 {
            return 0;
        }
        let target = (total * q) as u64;
        let mut accum = 0u64;
        for (i, b) in self.buckets.iter().enumerate() {
            accum += b.load(Ordering::Relaxed);
            if accum >= target {
                return self.bucket_bounds.get(i).copied().unwrap_or(u64::MAX);
            }
        }
        self.bucket_bounds.last().copied().unwrap_or(u64::MAX)
    }
}

#[derive(Debug, Clone)]
pub struct MetricsRegistry {
    counters: dashmap::DashMap<String, Arc<Counter>>,
    histograms: dashmap::DashMap<String, Arc<Histogram>>,
}

impl Default for MetricsRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl MetricsRegistry {
    pub fn new() -> Self {
        Self {
            counters: dashmap::DashMap::new(),
            histograms: dashmap::DashMap::new(),
        }
    }

    pub fn counter(&self, name: &str) -> Arc<Counter> {
        self.counters
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(Counter::new()))
            .clone()
    }

    pub fn histogram(&self, name: &str, bounds: Vec<u64>) -> Arc<Histogram> {
        self.histograms
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(Histogram::new(bounds)))
            .clone()
    }
}
