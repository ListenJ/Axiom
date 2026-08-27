/**
 * 前端视觉审核 CLI
 * 用法: bun run scripts/frontend-audit.ts [--base-url=http://127.0.0.1:18789]
 *        [--pages=/chat,/search] [--concurrency=2] [--out=reports/frontend-audit-<ts>.md] [--knowledge]
 * 说明: 需要后端已运行（bun run src/main.ts）；逐页 Playwright 截图 → SenseNova 审核 → 报告。
 *       --knowledge 会把 issues 写入知识库（domain=frontend-audit）。
 */
import { auditFrontendPages, DEFAULT_AUDIT_PAGES, computeBlockingSeverity } from "../src/computer-use/frontend-audit.js";
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";

const args = Bun.argv.slice(2);
const flag = (name: string, fallback = "") => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const baseUrl = flag("base-url", "http://127.0.0.1:18789").replace(/\/$/, "");
const pagesParam = flag("pages", "");
const pages = pagesParam
  ? pagesParam.split(",").map((p) => p.trim()).filter(Boolean).map((p) => ({ path: p, label: p }))
  : DEFAULT_AUDIT_PAGES;
const concurrency = Number(flag("concurrency", "2")) || 2;
const outFile = flag("out", "");
const withKnowledge = args.includes("--knowledge");
// 门禁阈值：critical|major|minor（默认 critical）——LLM 视觉模型对次要文字对比度易过度标记，
// critical（渲染级故障：黑屏/重叠/缺失）才作为回归拦截，major/minor 进报告供人工审阅
const blockOn = (flag("block-on", "critical") || "critical") as "critical" | "major" | "minor";

const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const reportPath = outFile || join("reports", `frontend-audit-${ts}.md`);

console.log(`[FrontendAudit] base=${baseUrl} pages=${pages.length} concurrency=${concurrency}`);
const report = await auditFrontendPages(baseUrl, pages, { concurrency });
mkdirSync("reports", { recursive: true });
writeFileSync(reportPath, report.markdown, "utf8");
console.log(report.markdown.split("\n").slice(0, 10).join("\n"));
console.log(`[FrontendAudit] report written: ${reportPath}`);

if (withKnowledge) {
  const { getKnowledgeStore } = await import("../src/knowledge/store.js");
  const store = getKnowledgeStore();
  let saved = 0;
  for (const r of report.pages) {
    for (const f of r.findings) {
      if (f.severity === "info") continue;
      try {
        store.saveSource({
          title: `[前端审核] ${r.label} ${r.path} — ${f.area}`,
          domain: "frontend-audit",
          subdomain: f.area,
          url: `${baseUrl}${r.path}`,
          quality: f.severity === "critical" || f.severity === "major" ? "low" : "medium",
          description: f.description + (f.suggestion ? ` 建议：${f.suggestion}` : ""),
        });
        saved++;
      } catch (err) {
        console.warn(`  save failed: ${(err as Error).message}`);
      }
    }
  }
  console.log(`[FrontendAudit] saved ${saved} issues to knowledge base`);
}

const blocking = computeBlockingSeverity(report.totals, blockOn);
console.log(`[FrontendAudit] block-on=${blockOn} blocking=${blocking}`);
process.exit(blocking > 0 ? 1 : 0);
