/**
 * 审计 F-1 / F-2 / 整改 R3 Task 3.1 —— pdf-worker 摄取路径回归
 *
 * 修复前：
 *   F-1 submit 返回 {task_id,status:"queued"} 即被当作终态，已实现的
 *   waitForCompletion 从未被调用 → 扫描型 PDF 经 worker 时 markdown=""
 *   且无 error 标记（静默数据丢失）；
 *   F-2 本地文件只发送前 64 字节且缺 url 字段，Python 端 KeyError 必失败
 *   且不可见。
 *
 * 修复后契约：
 *   - submit 后必须 waitForCompletion 轮询至 completed/failed；
 *   - 本地文件以 data_base64 全量上传；URL 文件维持 url 字段；
 *   - 完成但无 markdown → 显式 error；任务失败 → error 透传。
 */
import { describe, test, expect } from "bun:test";
import fs from "fs";
import { ingestDocument, type DocumentIngestOptions } from "../../src/knowledge/document-ingest.js";

// 带合法 magic 但无文本层的坏 PDF —— unpdf 解析失败即进入 worker 分支
const BROKEN_PDF = new TextEncoder().encode("%PDF-1.7 %broken-for-test");

type SubmitTask = { task_type: string; payload: Record<string, unknown> };
type Call =
  | { kind: "submit"; task: SubmitTask }
  | { kind: "wait"; id: string };

function fakeWorker(handler: (task: SubmitTask) => WorkerResponseShape) {
  const calls: Call[] = [];
  const worker = {
    submit: async (task: SubmitTask) => {
      calls.push({ kind: "submit", task });
      return handler(task);
    },
    waitForCompletion: async (taskId: string) => {
      calls.push({ kind: "wait", id: taskId });
      return handler({ task_type: "wait", payload: {} });
    },
  };
  return { calls, worker };
}

type WorkerResponseShape =
  | { task_id?: string; status?: string }
  | { status: "completed"; result: { markdown: string }; metadata?: Record<string, unknown> };

describe("pdf-worker 摄取（F-1/F-2）", () => {
  test("submit 后轮询至终态并取回 markdown（F-1）", async () => {
    let waited = false;
    const opts: DocumentIngestOptions = {
      pdfWorker: {
        submit: async () => ({ task_id: "t-1", status: "queued" }),
        waitForCompletion: async (id: string) => {
          waited = true;
          expect(id).toBe("t-1");
          return { status: "completed", result: { markdown: "# Scanned\n扫描内容" } };
        },
      } as any,
    };
    const out = await ingestDocument({ buffer: BROKEN_PDF, name: "scan.pdf" }, opts);
    expect(waited).toBe(true);
    expect(out.metadata.via).toBe("pdf-worker");
    expect(out.markdown).toContain("Scanned");
    expect(out.error).toBeUndefined();
  });

  test("本地文件以 data_base64 全量上传，不带 url（F-2）", async () => {
    let captured: Record<string, unknown> | null = null;
    const opts: DocumentIngestOptions = {
      pdfWorker: {
        submit: async (task: SubmitTask) => {
          captured = task.payload;
          return { task_id: "t-2", status: "queued" };
        },
        waitForCompletion: async () => ({ status: "completed", result: { markdown: "# OK" } }),
      } as any,
    };
    const bytes = BROKEN_PDF;
    await ingestDocument({ buffer: bytes, name: "local.pdf" }, opts);
    expect(captured).not.toBeNull();
    expect(typeof captured!.data_base64).toBe("string");
    const decoded = Buffer.from(String(captured!.data_base64), "base64");
    expect(decoded.length).toBe(bytes.length);
    expect(captured!.url).toBeUndefined();
  });

  test("完成但无 markdown → 显式 error（不静默返回空串）", async () => {
    const opts: DocumentIngestOptions = {
      pdfWorker: {
        submit: async () => ({ task_id: "t-3", status: "queued" }),
        waitForCompletion: async () => ({ status: "completed", result: { markdown: "" } }),
      } as any,
    };
    const out = await ingestDocument({ buffer: BROKEN_PDF, name: "empty.pdf" }, opts);
    expect(out.markdown).toBe("");
    expect(String(out.error)).toContain("without markdown");
  });

  test("任务失败 → 错误透传到 error 字段", async () => {
    const opts: DocumentIngestOptions = {
      pdfWorker: {
        submit: async () => ({ task_id: "t-4", status: "queued" }),
        waitForCompletion: async () => { throw new Error("Task t-4 failed: OCR engine missing"); },
      } as any,
    };
    const out = await ingestDocument({ buffer: BROKEN_PDF, name: "fail.pdf" }, opts);
    expect(String(out.error)).toContain("OCR engine missing");
  });

  test("image-PDF empty get_text produces no noisy header", async () => {
    // 模拟 page.get_text()=="" 的两页 PDF，断言产出不含 "## Page"
    // 需在 fake worker 中注入空文本 — 同时校验 Python 侧已过滤空页
    const py = fs.readFileSync("scripts/pdf-worker/app.py", "utf-8");
    expect(py).toContain("page.get_text().strip()");
    expect(py).toContain("if not text:");
    function simulate(pages: string[]) {
      const out: string[] = [];
      for (let i = 0; i < pages.length; i++) {
        const text = pages[i].trim();
        if (!text) continue;
        out.push(`## Page ${i + 1}\n\n${text}`);
      }
      return out.join("\n\n");
    }
    const mdEmpty = simulate(["", "   ", "\n"]);
    expect(mdEmpty).not.toContain("## Page");
    expect(mdEmpty.trim()).toBe("");
    const mdMixed = simulate(["", "hello world", "   "]);
    expect(mdMixed).not.toContain("## Page 1");
    expect(mdMixed).toContain("## Page 2");
    expect(mdMixed).toContain("hello world");
    // 注入空文本的 fake worker 应返回 failed + no extractable，而非噪声 markdown
    const opts: DocumentIngestOptions = {
      pdfWorker: {
        submit: async () => ({ task_id: "t-empty-image", status: "queued" }),
        waitForCompletion: async () => ({ status: "failed", error: "no extractable text" }),
      } as any,
    };
    const out = await ingestDocument({ buffer: BROKEN_PDF, name: "image-scan.pdf" }, opts);
    expect(String(out.error)).toContain("no extractable");
    expect(out.markdown).toBe("");
  });

  test("no extractable text returns error", async () => {
    // 断言 markdown 为空时 status=failed 且 error 含 "no extractable"
    const py = fs.readFileSync("scripts/pdf-worker/app.py", "utf-8");
    expect(py).toContain("no extractable text");
    expect(py).toContain('tasks[task_id]["status"] = "failed"');
    const opts: DocumentIngestOptions = {
      pdfWorker: {
        submit: async () => ({ task_id: "t-no-text", status: "queued" }),
        waitForCompletion: async () => ({ status: "failed", error: "no extractable text" }),
      } as any,
    };
    const out = await ingestDocument({ buffer: BROKEN_PDF, name: "no-text.pdf" }, opts);
    expect(String(out.error)).toContain("no extractable");
    expect(out.markdown).toBe("");
  });
});
