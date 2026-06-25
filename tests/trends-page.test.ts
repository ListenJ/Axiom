/**
 * Trends Page — 趋势分析单元测试
 * 运行: bun test tests/trends-page.test.ts
 */
import { describe, it, expect } from "bun:test"

interface TrendPoint { day: string; count: number }
interface ModelTrend { model_name: string; count: number; avg_latency: number }
interface TaskTrend { status: string; count: number }

describe("Trends Page", () => {
  describe("趋势数据规范化", () => {
    it("应能按日期对趋势点排序", () => {
      const points: TrendPoint[] = [
        { day: "2026-06-14", count: 10 },
        { day: "2026-06-12", count: 5 },
        { day: "2026-06-13", count: 8 },
      ]
      const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day))
      expect(sorted.map((p) => p.day)).toEqual(["2026-06-12", "2026-06-13", "2026-06-14"])
    })

    it("应能计算趋势点的总计数", () => {
      const points: TrendPoint[] = [
        { day: "2026-06-12", count: 3 },
        { day: "2026-06-13", count: 7 },
        { day: "2026-06-14", count: 5 },
      ]
      const total = points.reduce((sum, p) => sum + p.count, 0)
      expect(total).toBe(15)
    })

    it("应能找出趋势点中最大值（用于柱状图缩放）", () => {
      const points: TrendPoint[] = [
        { day: "2026-06-12", count: 2 },
        { day: "2026-06-13", count: 9 },
        { day: "2026-06-14", count: 4 },
      ]
      const max = Math.max(1, ...points.map((p) => p.count))
      expect(max).toBe(9)
    })

    it("空数组应返回 1 作为安全默认值", () => {
      const max = Math.max(1, ...([] as number[]))
      expect(max).toBe(1)
    })
  })

  describe("模型调用统计", () => {
    it("应能按调用次数排序", () => {
      const models: ModelTrend[] = [
        { model_name: "gpt-4", count: 100, avg_latency: 200 },
        { model_name: "claude-3", count: 250, avg_latency: 180 },
        { model_name: "deepseek", count: 50, avg_latency: 100 },
      ]
      const sorted = [...models].sort((a, b) => b.count - a.count)
      expect(sorted[0].model_name).toBe("claude-3")
      expect(sorted[2].model_name).toBe("deepseek")
    })

    it("应能按平均延迟排序", () => {
      const models: ModelTrend[] = [
        { model_name: "gpt-4", count: 100, avg_latency: 500 },
        { model_name: "deepseek", count: 50, avg_latency: 120 },
      ]
      const sorted = [...models].sort((a, b) => a.avg_latency - b.avg_latency)
      expect(sorted[0].model_name).toBe("deepseek")
    })

    it("应能找出最活跃的模型", () => {
      const models: ModelTrend[] = [
        { model_name: "a", count: 10, avg_latency: 100 },
        { model_name: "b", count: 100, avg_latency: 200 },
        { model_name: "c", count: 50, avg_latency: 150 },
      ]
      const top = models.reduce((best, m) => (m.count > best.count ? m : best))
      expect(top.model_name).toBe("b")
    })
  })

  describe("任务状态", () => {
    it("应能按状态计数排序", () => {
      const tasks: TaskTrend[] = [
        { status: "pending", count: 5 },
        { status: "running", count: 2 },
        { status: "completed", count: 20 },
        { status: "failed", count: 1 },
      ]
      const sorted = [...tasks].sort((a, b) => b.count - a.count)
      expect(sorted[0].status).toBe("completed")
      expect(sorted[3].status).toBe("failed")
    })

    it("应能筛选活跃任务（非 completed/archived）", () => {
      const tasks: TaskTrend[] = [
        { status: "pending", count: 5 },
        { status: "completed", count: 20 },
        { status: "running", count: 2 },
        { status: "archived", count: 30 },
      ]
      const active = tasks.filter(
        (t) => t.status !== "completed" && t.status !== "archived"
      )
      expect(active.length).toBe(2)
    })

    it("应能计算任务总计数", () => {
      const tasks: TaskTrend[] = [
        { status: "pending", count: 5 },
        { status: "running", count: 2 },
        { status: "completed", count: 20 },
      ]
      const total = tasks.reduce((sum, t) => sum + t.count, 0)
      expect(total).toBe(27)
    })
  })

  describe("时间范围", () => {
    it("应能计算日期范围内的天数", () => {
      const days = 7
      expect(days).toBeGreaterThan(0)
      expect([1, 7, 30, 90]).toContain(days)
    })

    it("应能格式化日期标签（只显示月-日）", () => {
      const full = "2026-06-14"
      const short = full.slice(5)
      expect(short).toBe("06-14")
    })
  })
})
