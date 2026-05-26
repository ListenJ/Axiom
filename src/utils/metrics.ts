import { logger } from "./logger.js";

interface MetricValue {
  value: number;
  timestamp: number;
  labels?: Record<string, string>;
}

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge" | "histogram";
  values: MetricValue[];
}

class MetricsCollector {
  private metrics: Map<string, Metric> = new Map();
  private histogramBuckets = [0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100];

  register(metric: Omit<Metric, "values">): void {
    if (!this.metrics.has(metric.name)) {
      this.metrics.set(metric.name, { ...metric, values: [] });
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

    metric.values.push({
      value,
      timestamp: Date.now(),
      labels,
    });

    // Keep last 1000 values
    if (metric.values.length > 1000) {
      metric.values = metric.values.slice(-1000);
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

    // Remove old values with same labels
    metric.values = metric.values.filter(
      (v) => !labels || !this.matchLabels(v.labels, labels)
    );

    metric.values.push({
      value,
      timestamp: Date.now(),
      labels,
    });
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

    metric.values.push({
      value,
      timestamp: Date.now(),
      labels,
    });

    if (metric.values.length > 10000) {
      metric.values = metric.values.slice(-10000);
    }
  }

  getPrometheusFormat(): string {
    const lines: string[] = [];

    for (const [name, metric] of this.metrics) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} ${metric.type}`);

      if (metric.type === "histogram") {
        const labelStr = this.formatLabels(metric.values[0]?.labels);
        const buckets = this.calculateHistogramBuckets(metric.values);

        for (const [le, count] of Object.entries(buckets)) {
          lines.push(
            `${name}_bucket{le="${le}"${labelStr ? "," + labelStr : ""}} ${count}`
          );
        }
        lines.push(`${name}_count${labelStr ? "{" + labelStr + "}" : ""} ${metric.values.length}`);
        const sum = metric.values.reduce((a, b) => a + b.value, 0);
        lines.push(`${name}_sum${labelStr ? "{" + labelStr + "}" : ""} ${sum}`);
      } else {
        for (const value of metric.values) {
          const labelStr = this.formatLabels(value.labels);
          lines.push(
            `${name}${labelStr ? "{" + labelStr + "}" : ""} ${value.value}`
          );
        }
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  getJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [name, metric] of this.metrics) {
      result[name] = {
        help: metric.help,
        type: metric.type,
        values: metric.values,
      };
    }

    return result;
  }

  private matchLabels(
    a?: Record<string, string>,
    b?: Record<string, string>
  ): boolean {
    if (!a || !b) return !a && !b;
    return Object.entries(a).every(([k, v]) => b[k] === v);
  }

  private formatLabels(labels?: Record<string, string>): string {
    if (!labels) return "";
    return Object.entries(labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(",");
  }

  private calculateHistogramBuckets(
    values: MetricValue[]
  ): Record<string, number> {
    const buckets: Record<string, number> = {};

    for (const bucket of this.histogramBuckets) {
      buckets[bucket] = values.filter((v) => v.value <= bucket).length;
    }

    buckets["+Inf"] = values.length;

    return buckets;
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
