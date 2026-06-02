import path from "path";
import fs from "fs";

export interface CloneOptions {
  repo: string;
  branch?: string;
  depth?: number;
  destDir?: string;
  cleanupAfterIndex?: boolean;
}

export interface CloneResult {
  success: boolean;
  localPath: string;
  repoName: string;
  error?: string;
}

/**
 * 将远程仓库克隆到本地临时目录。
 * repo 支持多种格式：
 *   - "owner/repo" → 自动补全为 https://github.com/owner/repo
 *   - 完整 URL → 直接使用
 */
export async function cloneRepo(opts: CloneOptions): Promise<CloneResult> {
  const repoUrl = opts.repo.includes("://")
    ? opts.repo
    : `https://github.com/${opts.repo}`;

  const repoName = path.basename(repoUrl, ".git");
  const destDir = opts.destDir || path.join("tmp", "repos", repoName);

  // 如果目录已存在，先删除
  if (fs.existsSync(destDir)) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {
      return { success: false, localPath: destDir, repoName, error: `无法清理已存在的目录: ${destDir}` };
    }
  }

  // 构建 git clone 参数
  const args = ["clone"];
  if (opts.branch) { args.push("-b", opts.branch); }
  if (opts.depth) { args.push("--depth", String(opts.depth)); }
  args.push(repoUrl, destDir);

  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    return { success: false, localPath: destDir, repoName, error: `git clone 失败 (exit=${exitCode}): ${err.slice(0, 200)}` };
  }

  return { success: true, localPath: destDir, repoName };
}

/** 删除已克隆的仓库目录 */
export function cleanupRepo(localPath: string): void {
  if (fs.existsSync(localPath)) {
    fs.rmSync(localPath, { recursive: true, force: true });
  }
}

/** 推荐的代表性开源项目清单 */
export const OSS_PROJECTS: Array<{ repo: string; name: string; lang: string; note: string }> = [
  // TypeScript / JavaScript
  { repo: "microsoft/vscode", name: "VS Code", lang: "typescript", note: "大型桌面应用架构、插件系统" },
  { repo: "vercel/next.js", name: "Next.js", lang: "typescript", note: "React 全栈框架、SSR/SSG 实现" },
  { repo: "withastro/astro", name: "Astro", lang: "typescript", note: " Islands 架构、内容驱动站点" },
  // Go
  { repo: "golang/go", name: "Go", lang: "go", note: "标准库、并发模型 (goroutine/scheduler)" },
  { repo: "kubernetes/kubernetes", name: "Kubernetes", lang: "go", note: "容器编排、控制器模式、声明式 API" },
  { repo: "etcd-io/etcd", name: "etcd", lang: "go", note: "分布式 KV 存储、Raft 共识算法" },
  // Python
  { repo: "python/cpython", name: "CPython", lang: "python", note: "解释器实现、GIL、内存管理" },
  { repo: "pallets/flask", name: "Flask", lang: "python", note: "微型 Web 框架、WSGI、扩展机制" },
  { repo: "psf/requests", name: "Requests", lang: "python", note: "HTTP 客户端设计、API 优雅性" },
  // Java
  { repo: "spring-projects/spring-boot", name: "Spring Boot", lang: "java", note: "自动配置、Starter、嵌入式容器" },
  { repo: "apache/kafka", name: "Kafka", lang: "java", note: "高吞吐消息系统、日志存储、分区" },
  // Rust
  { repo: "rust-lang/rust", name: "Rust", lang: "rust", note: "编译器、所有权系统、 borrow checker" },
  { repo: "tokio-rs/tokio", name: "Tokio", lang: "rust", note: "异步运行时、任务调度、I/O 驱动" },
  { repo: "sharkdp/fd", name: "fd", lang: "rust", note: "命令行工具、WalkDir 优化、用户体验" },
  // C / C++
  { repo: "torvalds/linux", name: "Linux", lang: "c", note: "内核架构、调度器、VFS、驱动模型" },
  { repo: "redis/redis", name: "Redis", lang: "c", note: "内存数据库、事件循环、数据结构" },
  { repo: "facebook/rocksdb", name: "RocksDB", lang: "cpp", note: "LSM-Tree 存储引擎、 compaction" },
];
