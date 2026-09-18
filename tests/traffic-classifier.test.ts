/**
 * 流量分类器测试 — 多维度特征流量识别引擎
 *
 * 测试目标：TrafficClassifier 的分类准确性、性能、规则覆盖
 * 测试维度：合法流量 / 路径遍历 / SQL 注入 / XSS / 命令注入 / SSRF / 恶意 UA / 可疑路径
 *
 * 覆盖组件：src/utils/traffic-classifier.ts
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { TrafficClassifier, type TrafficFeatures } from "../src/utils/traffic-classifier.js";

function makeFeatures(overrides: Partial<TrafficFeatures> = {}): TrafficFeatures {
  return {
    method: "GET",
    path: "/api/chat",
    userAgent: "AxiomAgent/1.0",
    contentType: "application/json",
    payloadSize: 256,
    query: "",
    remoteAddress: "192.168.1.100",
    ...overrides,
  };
}

describe("TrafficClassifier", () => {
  let classifier: TrafficClassifier;

  beforeEach(() => {
    classifier = new TrafficClassifier();
  });

  describe("合法流量分类", () => {
    test("正常 API 请求分类为 legitimate", () => {
      const result = classifier.classify(makeFeatures());
      expect(result.classification).toBe("legitimate");
      expect(result.score).toBeLessThan(0.3);
      expect(result.reasons).toHaveLength(0);
    });

    test("POST 请求带 JSON body 分类为 legitimate", () => {
      const result = classifier.classify(makeFeatures({
        method: "POST",
        path: "/api/chat",
        payloadSize: 2048,
        contentType: "application/json",
      }));
      expect(result.classification).toBe("legitimate");
    });

    test("浏览器请求分类为 legitimate", () => {
      const result = classifier.classify(makeFeatures({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      }));
      expect(result.classification).toBe("legitimate");
    });
  });

  describe("路径遍历检测", () => {
    test("../../../etc/passwd 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/../../../etc/passwd",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("path_traversal");
    });

    test("URL 编码的路径遍历 %2e%2e%2f 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/%2e%2e%2f%2e%2e%2fetc/passwd",
      }));
      expect(result.classification).not.toBe("legitimate");
      expect(result.reasons).toContain("path_traversal");
    });

    test("..%2f 混合编码检测为 suspicious+", () => {
      const result = classifier.classify(makeFeatures({
        path: "/files/..%2f..%2fsecret",
      }));
      expect(result.score).toBeGreaterThan(0.5);
      expect(result.reasons).toContain("path_traversal");
    });
  });

  describe("SQL 注入检测", () => {
    test("' OR 1=1 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        method: "POST",
        path: "/api/login",
        query: "username=admin' OR 1=1--",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("sql_injection");
    });

    test("UNION SELECT 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/search",
        query: "q=test UNION SELECT * FROM users",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("sql_injection");
    });

    test(";DROP TABLE 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/search",
        query: "q=test; DROP TABLE users",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("sql_injection");
    });
  });

  describe("XSS 检测", () => {
    test("<script> 标签检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/chat",
        query: "msg=<script>alert(1)</script>",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("xss");
    });

    test("javascript: 协议检测", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/redirect",
        query: "url=javascript:alert(1)",
      }));
      expect(result.score).toBeGreaterThan(0.5);
      expect(result.reasons).toContain("xss");
    });

    test("onerror= 事件处理器检测", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/chat",
        query: "msg=<img onerror=alert(1) src=x>",
      }));
      expect(result.reasons).toContain("xss");
    });
  });

  describe("命令注入检测", () => {
    test(";cat /etc/passwd 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/exec",
        query: "cmd=ls;cat /etc/passwd",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("cmd_injection");
    });

    test("|whoami 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/exec",
        query: "cmd=test|whoami",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("cmd_injection");
    });
  });

  describe("SSRF 检测", () => {
    test("169.254.169.254 元数据服务检测", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/fetch",
        query: "url=http://169.254.169.254/latest/meta-data/",
      }));
      expect(result.score).toBeGreaterThan(0.5);
      expect(result.reasons).toContain("ssrf");
    });

    test("localhost SSRF 检测", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/fetch",
        query: "url=http://localhost:8080/admin",
      }));
      expect(result.reasons).toContain("ssrf");
    });
  });

  describe("恶意 User-Agent 检测", () => {
    test("sqlmap UA 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        userAgent: "sqlmap/1.5",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("malicious_ua");
    });

    test("nikto UA 检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        userAgent: "Nikto/2.1.6",
      }));
      expect(result.classification).toBe("malicious");
    });

    test("nmap UA 检测为 suspicious+", () => {
      const result = classifier.classify(makeFeatures({
        userAgent: "Nmap Scripting Engine",
      }));
      expect(result.score).toBeGreaterThan(0.5);
      expect(result.reasons).toContain("malicious_ua");
    });
  });

  describe("可疑路径检测", () => {
    test(".env 访问检测为 malicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/.env",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("suspicious_path");
    });

    test(".git 目录访问检测", () => {
      const result = classifier.classify(makeFeatures({
        path: "/.git/config",
      }));
      expect(result.classification).toBe("malicious");
      expect(result.reasons).toContain("suspicious_path");
    });

    test("wp-admin 探测检测", () => {
      const result = classifier.classify(makeFeatures({
        path: "/wp-admin/",
      }));
      expect(result.score).toBeGreaterThan(0.4);
      expect(result.reasons).toContain("suspicious_path");
    });
  });

  describe("异常载荷大小检测", () => {
    test("超过 100KB 的非上传请求标记为 suspicious", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/chat",
        payloadSize: 200 * 1024, // 200KB
      }));
      expect(result.score).toBeGreaterThan(0.3);
      expect(result.reasons).toContain("oversized_payload");
    });

    test("上传端点允许大载荷", () => {
      const result = classifier.classify(makeFeatures({
        path: "/api/upload",
        payloadSize: 5 * 1024 * 1024, // 5MB
        contentType: "multipart/form-data",
      }));
      expect(result.reasons).not.toContain("oversized_payload");
    });
  });

  describe("分类性能", () => {
    test("分类延迟 ≤ 100ms", () => {
      const features = makeFeatures({
        path: "/api/../../../etc/passwd",
        query: "q=' OR 1=1--",
        userAgent: "sqlmap/1.5",
      });
      const result = classifier.classify(features);
      expect(result.durationMs).toBeLessThan(100);
    });

    test("1000 次分类总延迟 ≤ 500ms", () => {
      const features = makeFeatures();
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        classifier.classify(features);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("统计与指标", () => {
    test("stats() 返回分类统计", () => {
      classifier.classify(makeFeatures()); // legitimate
      classifier.classify(makeFeatures({ path: "/.env" })); // malicious
      classifier.classify(makeFeatures({ path: "/api/chat" })); // legitimate

      const stats = classifier.stats();
      expect(stats.total).toBe(3);
      expect(stats.legitimate).toBe(2);
      expect(stats.malicious).toBe(1);
      expect(stats.suspicious).toBe(0);
    });

    test("stats() 返回攻击类型 Top-N", () => {
      classifier.classify(makeFeatures({ path: "/.env" }));
      classifier.classify(makeFeatures({ path: "/.git/config" }));
      classifier.classify(makeFeatures({ userAgent: "sqlmap/1.5" }));

      const stats = classifier.stats();
      expect(stats.topAttackTypes.length).toBeGreaterThan(0);
      const pathCount = stats.topAttackTypes.find(a => a.type === "suspicious_path");
      expect(pathCount).toBeDefined();
      expect(pathCount!.count).toBe(2);
    });

    test("reset() 清空统计", () => {
      classifier.classify(makeFeatures());
      classifier.reset();
      const stats = classifier.stats();
      expect(stats.total).toBe(0);
    });
  });
});
