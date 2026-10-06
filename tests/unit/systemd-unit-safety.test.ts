/**
 * systemd 单元安全门（2026-10-07）
 *
 * 动因（实测事故）：`deploy/systemd/axiom@.service` 的 `ReadWritePaths` 列了
 * `axiom-memory.db-wal` / `-shm`、`.tmp` 等**运行时才存在**的路径。不带 `-` 前缀时，
 * 只要其中之一缺失（本机重启后 `.tmp` 被清理即满足），systemd 就在 NAMESPACE 阶段失败
 * （`status=226/NAMESPACE`）；叠加 `Restart=always` 变成崩溃循环 —— 实测连续重启 256 次、
 * 服务全程不可用，且 `/health` 探针全部 `000`，极易被误判成端口/构建问题。
 *
 * 本门只做一件事：模板里每条 `ReadWritePaths` 必须带 `-` 前缀（路径不存在时忽略）。
 * 边界：不校验路径是否真实存在（机器相关），也不替代 `systemd-analyze verify`。
 */
import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";

const UNITS = ["deploy/systemd/axiom@.service", "deploy/systemd/axiom-embed@.service"];

describe("systemd 单元安全门 · ReadWritePaths 容错", () => {
  for (const rel of UNITS) {
    it(`${rel}：ReadWritePaths 全部带 '-' 前缀`, () => {
      expect(existsSync(rel), `${rel} 应在库`).toBe(true);
      const lines = readFileSync(rel, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("ReadWritePaths="));
      // 覆盖面自证：一条都没有时先红，不允许靠“扫到 0 条”变绿
      expect(lines.length).toBeGreaterThan(0);
      const bad = lines.filter((l) => !l.startsWith("ReadWritePaths=-"));
      expect(bad, `缺 '-' 前缀会在路径缺失时导致 226/NAMESPACE 崩溃循环`).toEqual([]);
    });
  }
});
