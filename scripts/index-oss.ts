import { cloneRepo, cleanupRepo, OSS_PROJECTS } from "../src/crawl/repo-fetcher.js";
import { CodeIndexer } from "../src/memory/code-indexer.js";

/**
 * 将推荐的 OSS 项目克隆到临时目录并索引到 Vault。
 * 用法：bun run scripts/index-oss.ts [--all] [--repo=owner/repo]
 */
async function main() {
  const args = process.argv.slice(2);
  const doAll = args.includes("--all");
  const repoFilter = args.find((a) => a.startsWith("--repo="))?.slice(7);

  // 默认只索引轻量级项目（避免大型仓库拖垮）
  const projects = repoFilter
    ? OSS_PROJECTS.filter((p) => p.repo === repoFilter)
    : doAll
      ? OSS_PROJECTS
      : OSS_PROJECTS.filter((p) =>
          ["Requests", "fd", "Flask", "etcd", "RocksDB", "Astro"].includes(p.name)
        );

  const vaultRoot = "./axiom-memory";
  const results: { name: string; status: "ok" | "fail"; files: number; error?: string }[] = [];

  for (const proj of projects) {
    console.log(`\n📦 ${proj.name} (${proj.lang}) — ${proj.note}`);
    console.log(`   克隆 ${proj.repo} ...`);

    const clone = await cloneRepo({
      repo: proj.repo,
      depth: 1,
      destDir: `tmp/repos/${proj.name}`,
    });

    if (!clone.success) {
      console.error(`   ❌ 克隆失败: ${clone.error}`);
      results.push({ name: proj.name, status: "fail", files: 0, error: clone.error });
      continue;
    }

    console.log(`   索引到 Vault ...`);
    const indexer = new CodeIndexer({
      sourceRoot: clone.localPath,
      vaultRoot,
      vaultOutputDir: `03-Resources/code-index/oss/${proj.name}`,
    });

    try {
      const entries = await indexer.indexAll();
      console.log(`   ✅ 完成: ${entries.length} 个文件已索引`);
      results.push({ name: proj.name, status: "ok", files: entries.length });
    } catch (err) {
      console.error(`   ❌ 索引失败: ${err}`);
      results.push({ name: proj.name, status: "fail", files: 0, error: String(err) });
    }

    // 清理克隆的仓库以节省磁盘
    cleanupRepo(clone.localPath);
  }

  console.log("\n📊 汇总");
  console.log("-".repeat(50));
  for (const r of results) {
    const icon = r.status === "ok" ? "✅" : "❌";
    console.log(`${icon} ${r.name}: ${r.files} 文件${r.error ? ` | ${r.error.slice(0, 60)}` : ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
