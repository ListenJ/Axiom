import { logger } from "./logger.js";

// ═══════════════════════════════════════════════════════════════
// 聚合存储类型 —— 按 labelKey 索引，消除每请求对象分配与 slice 重建
// ═══════════════════════════════════════════════════════════════

interface CounterEntry {
  value: number;
  labels?: Record<string, string>;
}

interface HistogramEntry {
  /** 累计 bucket 计数：前 N 项对应 histogramBuckets，最后一项为 +Inf */
  buckets: number[];
  count: number;
  sum: number;
  labels?: Record<string, string>;
}

interface GaugeEntry {
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

type MetricEntry = CounterEntry | HistogramEntry | GaugeEntry;

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  /** 按 labelKey 聚合的条目（旧实现为 MetricValue[] 时间序列，每请求 push + slice） */
  entries: Map<string, MetricEntry>;
}

/**
 * 将 labels 序列化为稳定 key（键排序，确保不同插入顺序产生相同 key）。
 */
function labelKey(labels?: Record<string, string>): string {
  if (!labels) return "";
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  keys.sort();
  let out = "";
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ",";
    out += keys[i] + "=" + labels[keys[i]];
  }
  return out;
}

class MetricsCollector {
  private metrics: Map<string, Metric> = new Map();
  private histogramBuckets = [0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100];

  register(metric: Omit<Metric, "entries">): void {
    if (!this.metrics.has(metric.name)) {
      this.metrics.set(metric.name, { ...metric, entries: new Map() });
    }
  }

  increment(
    name: string,
    value = 1,
    labels?: Record<string, string>
  ): void {
    const metric = this.metrics.get(name);
    if (!metric) {
      logger.warn(`Metric not registered: ${name}`);
      return;
    }

    if (metric.type !== "counter") {
      logger.warn(`Metric ${name} is not a counter`);
      return;
    }

    const key = labelKey(labels);
    const entry = metric.entries.get(key) as CounterEntry | undefined;
    if (entry) {
      entry.value += value; // 原地累加，零分配
    } else {
      metric.entries.set(key, { value, labels });
    }
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.metrics.get(name);
    if (!metric) {
      logger.warn(`Metric not registered: ${name}`);
      return;
    }

    if (metric.type !== "gauge") {
      logger.warn(`Metric ${name} is not a gauge`);
      return;
    }

    // 覆盖同 label 组合的旧值（O(1) Map.set，原实现为 O(n) filter + push）
    const key = labelKey(labels);
    metric.entries.set(key, { value, timestamp: Date.now(), labels });
  }

  histogram(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): void {
    const metric = this.metrics.get(name);
    if (!metric) {
      logger.warn(`Metric not registered: ${name}`);
      return;
    }

    if (metric.type !== "histogram") {
      logger.warn(`Metric ${name} is not a histogram`);
      return;
    }

    const key = labelKey(labels);
    let entry = metric.entries.get(key) as HistogramEntry | undefined;
    if (!entry) {
      entry = {
        buckets: new Array(this.histogramBuckets.length + 1).fill(0),
        count: 0,
        sum: 0,
        labels,
      };
      metric.entries.set(key, entry);
    }

    // 更新累计 bucket 计数（Prometheus 语义：le=X 包含所有 <= X 的观测值）
    entry.count++;
    entry.sum += value;
    for (let i = 0; i < this.histogramBuckets.length; i++) {
      if (value <= this.histogramBuckets[i]) {
        entry.buckets[i]++;
      }
    }
    entry.buckets[this.histogramBuckets.length]++; // +Inf
  }

  getPrometheusFormat(): string {
    const lines: string[] = [];

    for (const [name, metric] of this.metrics) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} ${metric.type}`);

      if (metric.type === "histogram") {
        for (const entry of metric.entries.values()) {
          const h = entry as HistogramEntry;
          // 每个 label 组合独立输出 bucket/count/sum（原实现仅用 values[0].labels，丢失多 label 组合）
          for (let i = 0; i < this.histogramBuckets.length; i++) {
            const bucketLabels: Record<string, string> = { le: String(this.histogramBuckets[i]) };
            if (h.labels) Object.assign(bucketLabels, h.labels);
            lines.push(`${name}_bucket{${this.formatLabels(bucketLabels)}} ${h.buckets[i]}`);
          }
          const infLabels: Record<string, string> = { le: "+Inf" };
          if (h.labels) Object.assign(infLabels, h.labels);
          lines.push(`${name}_bucket{${this.formatLabels(infLabels)}} ${h.buckets[this.histogramBuckets.length]}`);

          const labelStr = this.formatLabels(h.labels);
          lines.push(`${name}_count${labelStr ? "{" + labelStr + "}" : ""} ${h.count}`);
          lines.push(`${name}_sum${labelStr ? "{" + labelStr + "}" : ""} ${h.sum}`);
        }
      } else {
        for (const entry of metric.entries.values()) {
          const e = entry as CounterEntry | GaugeEntry;
          const labelStr = this.formatLabels(e.labels);
          lines.push(`${name}${labelStr ? "{" + labelStr + "}" : ""} ${e.value}`);
        }
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  getJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [name, metric] of this.metrics) {
      const values: Array<{ value: number; timestamp?: number; labels?: Record<string, string> }> = [];
      for (const entry of metric.entries.values()) {
        if (metric.type === "histogram") {
          const h = entry as HistogramEntry;
          values.push({ value: h.sum, labels: h.labels });
        } else if (metric.type === "gauge") {
          const g = entry as GaugeEntry;
          values.push({ value: g.value, timestamp: g.timestamp, labels: g.labels });
        } else {
          const c = entry as CounterEntry;
          values.push({ value: c.value, labels: c.labels });
        }
      }
      result[name] = { help: metric.help, type: metric.type, values };
    }

    return result;
  }

  private formatLabels(labels?: Record<string, string>): string {
    if (!labels) return "";
    return Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
  }
}

export const metrics = new MetricsCollector();

// Register default metrics
metrics.register({
  name: "http_requests_total",
  help: "Total HTTP requests",
  type: "counter",
});

metrics.register({
  name: "http_request_duration_seconds",
  help: "HTTP request duration",
  type: "histogram",
});

metrics.register({
  name: "websocket_connections",
  help: "Active WebSocket connections",
  type: "gauge",
});

metrics.register({
  name: "model_requests_total",
  help: "Total model API requests",
  type: "counter",
});

metrics.register({
  name: "memory_usage_bytes",
  help: "Memory usage in bytes",
  type: "gauge",
});

metrics.register({
  name: "routing_decisions_total",
  help: "Total routing decisions by source and role",
  type: "counter",
});

metrics.register({
  name: "routing_duration_seconds",
  help: "Time spent computing routing decision",
  type: "histogram",
});

metrics.register({
  name: "routing_fallback_total",
  help: "Total times a fallback model was used",
  type: "counter",
});
