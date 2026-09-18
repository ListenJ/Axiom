/**
 * 项目自动分析器 — Hermes 驱动的新项目深度分析
 *
 * 当遇到一个新项目时，自动执行:
 *   1. 项目结构扫描 (语言、框架、依赖、目录结构)
 *   2. 代码图谱索引 (CodeGraph)
 *   3. 知识图谱构建 (实体、关系、架构模式)
 *   4. Hermes 深度分析 (架构决策、设计模式、潜在问题)
 *   5. 生成项目框架报告 (供后续任务使用)
 *
 * 目标: 让系统在接触任何新项目后，能快速建立起结构化的理解，
 *       后续的任务可以直接利用这个理解，无需从零开始。
 */
import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join, extname, relative, basename } from "path";
import { logger } from "../utils/logger.js";
import { internalAgent } from "./internal-agent.js";
import { buildKnowledgeGraph, type KGBuildResult } from "../memory/knowledge-graph-builder.js";
import { syncCodeGraphToPG } from "../db/codegraph-sync.js";
import { buildContext, getStatus, isCodegraphInitialized } from "../memory/codegraph-index.js";

// ========== 类型定义 ==========

/** package.json 的最小结构 (仅覆盖 project-analyzer 中实际访问的字段) */
interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export interface AnalyzeOptions {
  /** 项目根目录路径 */
  projectPath: string;
  /** 项目名称 (默认取目录名) */
  projectName?: string;
  /** 分析深度: quick (快速扫描) | standard (标准) | deep (深度分析) */
  depth?: "quick" | "standard" | "deep";
  /** 聚焦领域 (如 "architecture", "security", "performance") */
  focusAreas?: string[];
  /** 是否构建知识图谱 (默认 true) */
  generateKG?: boolean;
}

export interface ProjectStructure {
  /** 项目名称 */
  name: string;
  /** 项目路径 */
  path: string;
  /** 语言统计: language -> 文件数 */
  languages: Record<string, number>;
  /** 源码文件总数 */
  totalFiles: number;
  /** 检测到的框架 */
  frameworks: FrameworkInfo[];
  /** 入口文件 */
  entryPoints: string[];
  /** 配置文件 */
  configFiles: string[];
  /** 构建系统 */
  buildSystem: string;
  /** 测试框架 */
  testFramework: string[];
  /** 是否有 Docker 配置 */
  hasDocker: boolean;
  /** 是否有 CI/CD 配置 */
  hasCI: boolean;
  /** 是否为 monorepo */
  monorepo: boolean;
  /** 架构模式线索 */
  architectureHints: string[];
}

export interface FrameworkInfo {
  /** 框架名称 */
  name: string;
  /** 版本号 */
  version?: string;
  /** 框架类别 */
  category: "frontend" | "backend" | "fullstack" | "database" | "testing" | "build" | "devtool";
  /** 检测置信度 (0-1) */
  confidence: number;
}

export interface AnalysisResult {
  /** 项目名称 */
  projectName: string;
  /** 项目结构信息 */
  structure: ProjectStructure;
  /** 架构摘要 */
  architectureSummary: string;
  /** 关键发现 */
  keyFindings: string[];
  /** 识别的设计模式 */
  designPatterns: string[];
  /** 潜在问题 */
  potentialIssues: string[];
  /** 建议 */
  recommendations: string[];
  /** 知识图谱实体数 */
  kgEntities: number;
  /** 知识图谱关系数 */
  kgRelationships: number;
  /** 代码图谱节点数 */
  codegraphNodes: number;
  /** 分析使用的模型 */
  analysisModel: string;
  /** 分析耗时 (ms) */
  durationMs: number;
}

// ========== 常量 ==========

/** 扫描时排除的目录 */
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out",
  ".venv", "__pycache__", ".cache", "target", ".codegraph",
  ".svelte-kit", ".output", "coverage", ".idea", ".vscode",
  "vendor", "bower_components", ".turbo",
]);

/** 语言 -> 文件扩展名映射 */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java",
  ".kt": "Kotlin", ".kts": "Kotlin", ".c": "C", ".cpp": "C++", ".cc": "C++",
  ".h": "C/C++ Header", ".hpp": "C++ Header",
  ".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift",
  ".dart": "Dart", ".lua": "Lua", ".sh": "Shell", ".bash": "Shell",
  ".zsh": "Shell", ".ps1": "PowerShell",
  ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
  ".md": "Markdown", ".html": "HTML", ".css": "CSS", ".scss": "SCSS",
  ".sass": "Sass", ".less": "Less", ".vue": "Vue", ".svelte": "Svelte",
  ".sql": "SQL", ".graphql": "GraphQL", ".proto": "Protobuf",
  ".tf": "Terraform", ".dockerfile": "Docker",
};

/** 源码文件扩展名 (用于统计有效代码文件) */
const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".kt", ".kts",
  ".c", ".cpp", ".cc", ".h", ".hpp", ".cs", ".rb", ".php",
  ".swift", ".dart", ".lua", ".sh", ".bash",
  ".vue", ".svelte", ".html", ".css", ".scss", ".sass", ".less",
  ".json", ".yaml", ".yml", ".toml", ".sql", ".graphql", ".proto",
]);

/** 框架检测规则: 依赖包名 -> 框架信息 */
const FRAMEWORK_DEP_RULES: Record<string, { name: string; category: FrameworkInfo["category"]; confidence: number }> = {
  // Frontend
  "react": { name: "React", category: "frontend", confidence: 0.95 },
  "react-dom": { name: "React", category: "frontend", confidence: 0.95 },
  "next": { name: "Next.js", category: "fullstack", confidence: 0.95 },
  "vue": { name: "Vue", category: "frontend", confidence: 0.95 },
  "nuxt": { name: "Nuxt", category: "fullstack", confidence: 0.95 },
  "svelte": { name: "Svelte", category: "frontend", confidence: 0.95 },
  "@sveltejs/kit": { name: "SvelteKit", category: "fullstack", confidence: 0.95 },
  "@angular/core": { name: "Angular", category: "frontend", confidence: 0.95 },
  "preact": { name: "Preact", category: "frontend", confidence: 0.9 },
  "solid-js": { name: "SolidJS", category: "frontend", confidence: 0.9 },
  "astro": { name: "Astro", category: "fullstack", confidence: 0.9 },
  // Backend
  "express": { name: "Express", category: "backend", confidence: 0.95 },
  "fastify": { name: "Fastify", category: "backend", confidence: 0.9 },
  "@nestjs/core": { name: "NestJS", category: "backend", confidence: 0.95 },
  "koa": { name: "Koa", category: "backend", confidence: 0.9 },
  "hono": { name: "Hono", category: "backend", confidence: 0.9 },
  "bun": { name: "Bun", category: "backend", confidence: 0.85 },
  // Database
  "prisma": { name: "Prisma", category: "database", confidence: 0.9 },
  "@prisma/client": { name: "Prisma", category: "database", confidence: 0.95 },
  "typeorm": { name: "TypeORM", category: "database", confidence: 0.9 },
  "sequelize": { name: "Sequelize", category: "database", confidence: 0.9 },
  "mongoose": { name: "Mongoose", category: "database", confidence: 0.9 },
  "drizzle-orm": { name: "Drizzle ORM", category: "database", confidence: 0.9 },
  "knex": { name: "Knex", category: "database", confidence: 0.85 },
  // Testing
  "jest": { name: "Jest", category: "testing", confidence: 0.9 },
  "vitest": { name: "Vitest", category: "testing", confidence: 0.9 },
  "mocha": { name: "Mocha", category: "testing", confidence: 0.9 },
  "@playwright/test": { name: "Playwright", category: "testing", confidence: 0.9 },
  "cypress": { name: "Cypress", category: "testing", confidence: 0.9 },
  "pytest": { name: "pytest", category: "testing", confidence: 0.9 },
  // Build tools
  "vite": { name: "Vite", category: "build", confidence: 0.9 },
  "webpack": { name: "Webpack", category: "build", confidence: 0.9 },
  "esbuild": { name: "esbuild", category: "build", confidence: 0.85 },
  "rollup": { name: "Rollup", category: "build", confidence: 0.85 },
  "turbo": { name: "Turborepo", category: "build", confidence: 0.85 },
  // Devtools
  "typescript": { name: "TypeScript", category: "devtool", confidence: 0.95 },
  "eslint": { name: "ESLint", category: "devtool", confidence: 0.85 },
  "prettier": { name: "Prettier", category: "devtool", confidence: 0.85 },
  "tailwindcss": { name: "Tailwind CSS", category: "devtool", confidence: 0.9 },
  "@radix-ui/react-primitive": { name: "Radix UI", category: "devtool", confidence: 0.85 },
  "storybook": { name: "Storybook", category: "devtool", confidence: 0.85 },
};

/** 配置文件 -> 架构线索映射 */
const CONFIG_ARCHITECTURE_HINTS: Record<string, string> = {
  "docker-compose.yml": "Docker Compose (multi-container)",
  "docker-compose.yaml": "Docker Compose (multi-container)",
  "Dockerfile": "Docker containerization",
  "kubernetes.yml": "Kubernetes orchestration",
  "k8s": "Kubernetes orchestration",
  ".github/workflows": "GitHub Actions CI/CD",
  ".gitlab-ci.yml": "GitLab CI/CD",
  "Jenkinsfile": "Jenkins CI/CD",
  ".circleci": "CircleCI CI/CD",
  "terraform": "Terraform IaC",
  "serverless.yml": "Serverless Framework",
  "template.yaml": "AWS SAM (Serverless)",
  ".env": "Environment configuration",
  "nginx.conf": "Nginx reverse proxy",
  "Caddyfile": "Caddy web server",
  "Procfile": "Heroku-style deployment",
  "vercel.json": "Vercel deployment",
  "netlify.toml": "Netlify deployment",
  "fly.toml": "Fly.io deployment",
  "railway.json": "Railway deployment",
  "grpc": "gRPC communication",
  ".proto": "Protocol Buffers",
  "graphql": "GraphQL API",
  "swagger": "OpenAPI/Swagger",
  "openapi": "OpenAPI specification",
};

// ========== 项目结构扫描 ==========

/**
 * 扫描项目目录，识别语言、框架、入口点、配置等
 */
export async function scanProjectStructure(projectPath: string): Promise<ProjectStructure> {
  const absPath = projectPath.startsWith("/") || /^[A-Z]:\\/i.test(projectPath)
    ? projectPath
    : join(process.cwd(), projectPath);

  const name = basename(absPath);
  logger.info("[ProjectAnalyzer] Scanning project", { path: absPath, name });

  // Phase 1: 文件扫描 — 收集语言统计
  const languages: Record<string, number> = {};
  let totalFiles = 0;
  const allFiles: string[] = [];
  const topLevelDirs: string[] = [];
  const topLevelFiles: string[] = [];

  function walkDir(dir: string, depth: number = 0): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".github") continue;
        if (EXCLUDED_DIRS.has(entry.name)) continue;

        const fullPath = join(dir, entry.name);
        const relPath = relative(absPath, fullPath);

        if (entry.isDirectory()) {
          if (depth === 0) topLevelDirs.push(entry.name);
          walkDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          if (depth === 0) topLevelFiles.push(entry.name);

          const ext = extname(entry.name).toLowerCase();
          if (SOURCE_EXTS.has(ext)) {
            const lang = EXT_TO_LANGUAGE[ext] || "Other";
            languages[lang] = (languages[lang] || 0) + 1;
            totalFiles++;
          }

          // Dockerfile 特殊处理
          if (entry.name === "Dockerfile" || entry.name.startsWith("Dockerfile.")) {
            languages["Docker"] = (languages["Docker"] || 0) + 1;
            totalFiles++;
          }

          allFiles.push(relPath);
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  walkDir(absPath);

  // Phase 2: 读取 package.json (如果存在)
  const pkgPath = join(absPath, "package.json");
  let pkgJson: PackageJson | null = null;
  if (existsSync(pkgPath)) {
    try {
      pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      logger.warn("[ProjectAnalyzer] Failed to parse package.json");
    }
  }

  // Phase 3: 检测框架
  const frameworks = detectFrameworksFromPkg(pkgJson, topLevelFiles, topLevelDirs, absPath);

  // Phase 4: 检测入口文件
  const entryPoints = detectEntryPoints(topLevelFiles, topLevelDirs, absPath, frameworks);

  // Phase 5: 检测配置文件
  const configFiles = detectConfigFiles(allFiles);

  // Phase 6: 检测构建系统
  const buildSystem = detectBuildSystem(pkgJson, topLevelFiles);

  // Phase 7: 检测测试框架
  const testFramework = detectTestFrameworks(pkgJson, frameworks, topLevelFiles, topLevelDirs);

  // Phase 8: Docker & CI 检测
  const hasDocker = allFiles.some(f =>
    f === "Dockerfile" || f.startsWith("Dockerfile.") ||
    f === "docker-compose.yml" || f === "docker-compose.yaml" ||
    f === ".dockerignore"
  );
  const hasCI = allFiles.some(f =>
    f.startsWith(".github/workflows") || f === ".gitlab-ci.yml" ||
    f === "Jenkinsfile" || f.startsWith(".circleci") ||
    f === ".travis.yml" || f === "azure-pipelines.yml"
  );

  // Phase 9: Monorepo 检测
  const monorepo = detectMonorepo(pkgJson, topLevelFiles, topLevelDirs, absPath);

  // Phase 10: 架构模式线索
  const architectureHints = detectArchitectureHints(allFiles, topLevelDirs, frameworks, pkgJson);

  // 按文件数降序排列语言
  const sortedLanguages = Object.fromEntries(
    Object.entries(languages).sort(([, a], [, b]) => b - a)
  );

  const structure: ProjectStructure = {
    name,
    path: absPath,
    languages: sortedLanguages,
    totalFiles,
    frameworks,
    entryPoints,
    configFiles,
    buildSystem,
    testFramework,
    hasDocker,
    hasCI,
    monorepo,
    architectureHints,
  };

  logger.info("[ProjectAnalyzer] Scan complete", {
    totalFiles,
    languages: Object.keys(sortedLanguages).length,
    frameworks: frameworks.length,
  });

  return structure;
}

// ========== 框架检测 ==========

/**
 * 综合检测框架: 依赖 + 目录结构 + 配置文件
 */
export function detectFrameworks(structure: ProjectStructure): FrameworkInfo[] {
  return structure.frameworks;
}

/**
 * 内部: 从多维度检测框架
 */
function detectFrameworksFromPkg(
  pkgJson: PackageJson | null,
  topLevelFiles: string[],
  topLevelDirs: string[],
  projectPath: string,
): FrameworkInfo[] {
  const found = new Map<string, FrameworkInfo>();

  // 1. 从 package.json 依赖检测
  if (pkgJson) {
    const allDeps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
      ...pkgJson.peerDependencies,
    };

    for (const [depName, version] of Object.entries(allDeps)) {
      const rule = FRAMEWORK_DEP_RULES[depName];
      if (rule) {
        // 避免重复 (如 react 和 react-dom 都映射到 React)
        if (!found.has(rule.name) || found.get(rule.name)!.confidence < rule.confidence) {
          found.set(rule.name, {
            name: rule.name,
            version: typeof version === "string" ? version.replace(/[\^~>=<]/g, "") : undefined,
            category: rule.category,
            confidence: rule.confidence,
          });
        }
      }
    }
  }

  // 2. 从配置文件检测
  const configFrameworkMap: Record<string, FrameworkInfo> = {
    "next.config.js": { name: "Next.js", category: "fullstack", confidence: 0.98 },
    "next.config.mjs": { name: "Next.js", category: "fullstack", confidence: 0.98 },
    "next.config.ts": { name: "Next.js", category: "fullstack", confidence: 0.98 },
    "nuxt.config.ts": { name: "Nuxt", category: "fullstack", confidence: 0.98 },
    "nuxt.config.js": { name: "Nuxt", category: "fullstack", confidence: 0.98 },
    "svelte.config.js": { name: "SvelteKit", category: "fullstack", confidence: 0.95 },
    "vite.config.ts": { name: "Vite", category: "build", confidence: 0.9 },
    "vite.config.js": { name: "Vite", category: "build", confidence: 0.9 },
    "angular.json": { name: "Angular", category: "frontend", confidence: 0.98 },
    "gatsby-config.js": { name: "Gatsby", category: "fullstack", confidence: 0.95 },
    "gatsby-config.ts": { name: "Gatsby", category: "fullstack", confidence: 0.95 },
    "remix.config.js": { name: "Remix", category: "fullstack", confidence: 0.95 },
    "astro.config.mjs": { name: "Astro", category: "fullstack", confidence: 0.95 },
  };

  for (const file of topLevelFiles) {
    const fw = configFrameworkMap[file];
    if (fw && !found.has(fw.name)) {
      found.set(fw.name, fw);
    }
  }

  // 3. 从目录结构检测
  const dirHints: Array<{ dirs: string[]; framework: FrameworkInfo }> = [
    {
      dirs: ["pages", "app"],
      framework: { name: "Next.js (pages/app dir)", category: "fullstack", confidence: 0.7 },
    },
    {
      dirs: ["src", "components"],
      framework: { name: "Component-based UI", category: "frontend", confidence: 0.5 },
    },
  ];

  for (const hint of dirHints) {
    if (hint.dirs.every(d => topLevelDirs.includes(d))) {
      if (!found.has(hint.framework.name)) {
        found.set(hint.framework.name, hint.framework);
      }
    }
  }

  // 4. Python 框架检测 (无 package.json)
  if (!pkgJson) {
    const pyFiles = topLevelFiles.filter(f => f.endsWith(".py"));
    if (pyFiles.length > 0 || topLevelDirs.includes("src")) {
      // 检查 requirements.txt / pyproject.toml / setup.py
      const pyDepsFiles = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "setup.cfg"];
      for (const depFile of pyDepsFiles) {
        const filePath = join(projectPath, depFile);
        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath, "utf-8");
            if (content.includes("django") || content.includes("Django")) {
              found.set("Django", { name: "Django", category: "backend", confidence: 0.9 });
            }
            if (content.includes("flask") || content.includes("Flask")) {
              found.set("Flask", { name: "Flask", category: "backend", confidence: 0.9 });
            }
            if (content.includes("fastapi") || content.includes("FastAPI")) {
              found.set("FastAPI", { name: "FastAPI", category: "backend", confidence: 0.9 });
            }
            if (content.includes("celery") || content.includes("Celery")) {
              found.set("Celery", { name: "Celery", category: "backend", confidence: 0.85 });
            }
          } catch {
            // Skip unreadable files
          }
        }
      }
    }

    // Java/Spring 检测
    if (existsSync(join(projectPath, "pom.xml")) || existsSync(join(projectPath, "build.gradle"))) {
      try {
        const buildFile = existsSync(join(projectPath, "pom.xml"))
          ? readFileSync(join(projectPath, "pom.xml"), "utf-8")
          : readFileSync(join(projectPath, "build.gradle"), "utf-8");
        if (buildFile.includes("spring") || buildFile.includes("Spring")) {
          found.set("Spring", { name: "Spring", category: "backend", confidence: 0.9 });
        }
      } catch {
        // Skip
      }
    }

    // Ruby on Rails 检测
    if (existsSync(join(projectPath, "Gemfile"))) {
      try {
        const gemfile = readFileSync(join(projectPath, "Gemfile"), "utf-8");
        if (gemfile.includes("rails") || gemfile.includes("Rails")) {
          found.set("Rails", { name: "Rails", category: "fullstack", confidence: 0.95 });
        }
      } catch {
        // Skip
      }
    }

    // Go 检测
    if (existsSync(join(projectPath, "go.mod"))) {
      try {
        const goMod = readFileSync(join(projectPath, "go.mod"), "utf-8");
        if (goMod.includes("gin-gonic")) {
          found.set("Gin", { name: "Gin", category: "backend", confidence: 0.9 });
        }
        if (goMod.includes("gorilla/mux")) {
          found.set("Gorilla Mux", { name: "Gorilla Mux", category: "backend", confidence: 0.85 });
        }
        if (goMod.includes("fiber")) {
          found.set("Fiber", { name: "Fiber", category: "backend", confidence: 0.85 });
        }
      } catch {
        // Skip
      }
    }

    // Rust 检测
    if (existsSync(join(projectPath, "Cargo.toml"))) {
      try {
        const cargoToml = readFileSync(join(projectPath, "Cargo.toml"), "utf-8");
        if (cargoToml.includes("actix")) {
          found.set("Actix", { name: "Actix Web", category: "backend", confidence: 0.9 });
        }
        if (cargoToml.includes("axum")) {
          found.set("Axum", { name: "Axum", category: "backend", confidence: 0.9 });
        }
        if (cargoToml.includes("rocket")) {
          found.set("Rocket", { name: "Rocket", category: "backend", confidence: 0.9 });
        }
      } catch {
        // Skip
      }
    }
  }

  // 按置信度降序排列
  return Array.from(found.values()).sort((a, b) => b.confidence - a.confidence);
}

// ========== 辅助检测函数 ==========

function detectEntryPoints(
  topLevelFiles: string[],
  topLevelDirs: string[],
  projectPath: string,
  frameworks: FrameworkInfo[],
): string[] {
  const entryPoints: string[] = [];
  const candidates = [
    "index.ts", "index.js", "index.mjs",
    "main.ts", "main.js", "main.py", "main.go", "main.rs",
    "app.ts", "app.js", "app.py", "app.rb", "app.go",
    "server.ts", "server.js", "server.py",
    "src/index.ts", "src/index.js", "src/main.ts", "src/main.js",
    "src/app.ts", "src/app.js", "src/server.ts", "src/server.js",
    "src/main.py", "src/app.py",
    "cmd/main.go", "cmd/server/main.go",
    "lib/index.ts", "lib/index.js",
    "manage.py", "wsgi.py", "asgi.py",
    "Application.java", "Main.java",
  ];

  // 根据框架调整优先级
  const fwNames = frameworks.map(f => f.name.toLowerCase());
  if (fwNames.some(n => n.includes("next"))) {
    candidates.unshift("next.config.js", "next.config.mjs", "next.config.ts");
  }

  for (const candidate of candidates) {
    const fullPath = join(projectPath, candidate);
    if (existsSync(fullPath)) {
      entryPoints.push(candidate);
    }
  }

  return entryPoints.slice(0, 10); // 限制数量
}

function detectConfigFiles(allFiles: string[]): string[] {
  const configPatterns = [
    /^\.env(\.\w+)?$/,
    /^config\//,
    /^conf\//,
    /docker-compose\.ya?ml$/,
    /^Dockerfile/,
    /\.config\.(js|ts|mjs|cjs)$/,
    /^tsconfig\.json$/,
    /^\.eslintrc/,
    /^\.prettierrc/,
    /^jest\.config/,
    /^vitest\.config/,
    /^webpack\.config/,
    /^rollup\.config/,
    /^tailwind\.config/,
    /^postcss\.config/,
    /\.github\/workflows\//,
    /\.gitlab-ci\.yml$/,
    /^Jenkinsfile$/,
    /^vercel\.json$/,
    /^netlify\.toml$/,
    /^fly\.toml$/,
    /^Procfile$/,
    /^nginx\.conf$/,
  ];

  return allFiles.filter(f =>
    configPatterns.some(pattern => pattern.test(f))
  ).slice(0, 30);
}

function detectBuildSystem(pkgJson: PackageJson | null, topLevelFiles: string[]): string {
  if (pkgJson) {
    const scripts = pkgJson.scripts || {};
    if (scripts.build) return `npm/yarn (scripts.build: ${scripts.build.slice(0, 60)})`;
    if (pkgJson.name) return "npm/yarn (no build script)";
  }

  if (topLevelFiles.includes("Makefile")) return "Make";
  if (topLevelFiles.includes("CMakeLists.txt")) return "CMake";
  if (topLevelFiles.includes("build.gradle") || topLevelFiles.includes("build.gradle.kts")) return "Gradle";
  if (topLevelFiles.includes("pom.xml")) return "Maven";
  if (topLevelFiles.includes("Cargo.toml")) return "Cargo (Rust)";
  if (topLevelFiles.includes("go.mod")) return "Go modules";
  if (topLevelFiles.includes("pyproject.toml")) return "pyproject.toml (Python)";
  if (topLevelFiles.includes("setup.py")) return "setup.py (Python)";
  if (topLevelFiles.includes("Gemfile")) return "Bundler (Ruby)";

  return "unknown";
}

function detectTestFrameworks(
  pkgJson: PackageJson | null,
  frameworks: FrameworkInfo[],
  topLevelFiles: string[],
  topLevelDirs: string[],
): string[] {
  const testFws: string[] = [];

  // 从已检测的框架中筛选 testing 类别
  for (const fw of frameworks) {
    if (fw.category === "testing") {
      testFws.push(fw.name);
    }
  }

  // 从 package.json scripts 中检测
  if (pkgJson?.scripts) {
    const testScript = pkgJson.scripts.test || "";
    if (testScript.includes("jest") && !testFws.includes("Jest")) testFws.push("Jest");
    if (testScript.includes("vitest") && !testFws.includes("Vitest")) testFws.push("Vitest");
    if (testScript.includes("mocha") && !testFws.includes("Mocha")) testFws.push("Mocha");
    if (testScript.includes("playwright") && !testFws.includes("Playwright")) testFws.push("Playwright");
    if (testScript.includes("cypress") && !testFws.includes("Cypress")) testFws.push("Cypress");
  }

  // 从目录结构检测
  if (topLevelDirs.includes("tests") || topLevelDirs.includes("test") || topLevelDirs.includes("__tests__")) {
    if (testFws.length === 0) testFws.push("custom/unknown test framework");
  }

  // Python: pytest
  if (topLevelFiles.includes("pytest.ini") || topLevelFiles.includes("conftest.py")) {
    if (!testFws.includes("pytest")) testFws.push("pytest");
  }

  return testFws;
}

function detectMonorepo(
  pkgJson: PackageJson | null,
  topLevelFiles: string[],
  topLevelDirs: string[],
  projectPath: string,
): boolean {
  // 检查 package.json workspaces
  if (pkgJson?.workspaces) return true;

  // 检查 pnpm-workspace.yaml
  if (topLevelFiles.includes("pnpm-workspace.yaml")) return true;

  // 检查 lerna.json
  if (topLevelFiles.includes("lerna.json")) return true;

  // 检查 nx.json
  if (topLevelFiles.includes("nx.json")) return true;

  // 检查 turbo.json
  if (topLevelFiles.includes("turbo.json")) return true;

  // 检查是否有多个 package.json (packages/ 或 apps/ 目录)
  const monorepoDirs = ["packages", "apps", "services", "modules", "libs"];
  for (const dir of monorepoDirs) {
    if (topLevelDirs.includes(dir)) {
      const dirPath = join(projectPath, dir);
      try {
        const subdirs = readdirSync(dirPath, { withFileTypes: true });
        const hasSubPackages = subdirs.some(d =>
          d.isDirectory() && existsSync(join(dirPath, d.name, "package.json"))
        );
        if (hasSubPackages) return true;
      } catch {
        // Skip
      }
    }
  }

  return false;
}

function detectArchitectureHints(
  allFiles: string[],
  topLevelDirs: string[],
  frameworks: FrameworkInfo[],
  pkgJson: PackageJson | null,
): string[] {
  const hints: string[] = [];

  // 从文件路径检测架构模式
  for (const [pattern, hint] of Object.entries(CONFIG_ARCHITECTURE_HINTS)) {
    if (allFiles.some(f => f.includes(pattern)) || topLevelDirs.includes(pattern)) {
      if (!hints.includes(hint)) hints.push(hint);
    }
  }

  // 目录结构模式
  if (topLevelDirs.includes("src") && topLevelDirs.includes("lib")) {
    hints.push("Separate src/lib structure");
  }
  if (topLevelDirs.includes("controllers") || topLevelDirs.includes("routes")) {
    hints.push("MVC-style architecture");
  }
  if (topLevelDirs.includes("domain") || topLevelDirs.includes("entities")) {
    hints.push("Domain-driven design hints");
  }
  if (topLevelDirs.includes("infrastructure") || topLevelDirs.includes("adapters")) {
    hints.push("Hexagonal/Clean architecture hints");
  }
  if (topLevelDirs.includes("microservices") || topLevelDirs.includes("services")) {
    const servicesPath = topLevelDirs.includes("microservices") ? "microservices" : "services";
    try {
      // 仅做提示，不做深度扫描
      hints.push(`Service-based architecture (${servicesPath}/ directory)`);
    } catch {
      // Skip
    }
  }
  if (topLevelDirs.includes("api") || allFiles.some(f => f.includes("/api/"))) {
    hints.push("API layer present");
  }
  if (allFiles.some(f => f.includes("middleware"))) {
    hints.push("Middleware pattern");
  }
  if (allFiles.some(f => f.includes("event") || f.includes("listener") || f.includes("subscriber"))) {
    hints.push("Event-driven patterns");
  }
  if (allFiles.some(f => f.includes("queue") || f.includes("worker"))) {
    hints.push("Queue/Worker pattern");
  }

  return hints;
}

// ========== Prompt 构建 ==========

/**
 * 构建用于 Hermes/OpenRouter 分析的综合 prompt
 */
export function generateAnalysisPrompt(
  structure: ProjectStructure,
  codegraphContext: string,
): string {
  const sections: string[] = [];

  sections.push("# Project Analysis Request");
  sections.push("");
  sections.push("Analyze the following project and provide a comprehensive architectural assessment.");
  sections.push("");

  // 项目概览
  sections.push("## Project Overview");
  sections.push(`- **Name**: ${structure.name}`);
  sections.push(`- **Path**: ${structure.path}`);
  sections.push(`- **Total source files**: ${structure.totalFiles}`);
  sections.push("");

  // 语言分布
  sections.push("## Languages");
  for (const [lang, count] of Object.entries(structure.languages)) {
    const pct = structure.totalFiles > 0 ? ((count / structure.totalFiles) * 100).toFixed(1) : "0";
    sections.push(`- ${lang}: ${count} files (${pct}%)`);
  }
  sections.push("");

  // 框架
  if (structure.frameworks.length > 0) {
    sections.push("## Frameworks & Libraries");
    for (const fw of structure.frameworks) {
      const ver = fw.version ? ` (v${fw.version})` : "";
      sections.push(`- **${fw.name}**${ver} [${fw.category}] (confidence: ${(fw.confidence * 100).toFixed(0)}%)`);
    }
    sections.push("");
  }

  // 构建 & 测试
  sections.push("## Build & Test");
  sections.push(`- Build system: ${structure.buildSystem}`);
  sections.push(`- Test frameworks: ${structure.testFramework.length > 0 ? structure.testFramework.join(", ") : "none detected"}`);
  sections.push(`- Docker: ${structure.hasDocker ? "yes" : "no"}`);
  sections.push(`- CI/CD: ${structure.hasCI ? "yes" : "no"}`);
  sections.push(`- Monorepo: ${structure.monorepo ? "yes" : "no"}`);
  sections.push("");

  // 入口文件
  if (structure.entryPoints.length > 0) {
    sections.push("## Entry Points");
    for (const ep of structure.entryPoints) {
      sections.push(`- \`${ep}\``);
    }
    sections.push("");
  }

  // 配置文件
  if (structure.configFiles.length > 0) {
    sections.push("## Configuration Files");
    for (const cf of structure.configFiles.slice(0, 15)) {
      sections.push(`- \`${cf}\``);
    }
    sections.push("");
  }

  // 架构线索
  if (structure.architectureHints.length > 0) {
    sections.push("## Architecture Hints (from static analysis)");
    for (const hint of structure.architectureHints) {
      sections.push(`- ${hint}`);
    }
    sections.push("");
  }

  // CodeGraph 上下文
  if (codegraphContext && codegraphContext.length > 10) {
    sections.push("## CodeGraph Context (verified from AST analysis)");
    sections.push("The following is extracted from actual code structure, not speculation:");
    sections.push("");
    sections.push(codegraphContext);
    sections.push("");
  }

  // 分析指令
  sections.push("## Analysis Instructions");
  sections.push("Please provide a structured analysis covering:");
  sections.push("");
  sections.push("1. **Architecture Summary**: What is the overall architecture? (monolith, microservices, serverless, etc.)");
  sections.push("2. **Key Components**: What are the main components/modules and their responsibilities?");
  sections.push("3. **Design Patterns**: What design patterns are used? (MVC, repository, observer, etc.)");
  sections.push("4. **Technology Stack Assessment**: Is the stack appropriate for the project's goals?");
  sections.push("5. **Potential Issues**: Any anti-patterns, security concerns, scalability issues, or technical debt?");
  sections.push("6. **Recommendations**: Concrete, actionable suggestions for improvement.");
  sections.push("");
  sections.push("Format your response in clear sections with bullet points.");
  sections.push("Be specific — cite file names, function names, or module names when possible.");
  sections.push("Respond in Chinese (中文).");

  return sections.join("\n");
}

// ========== 模型调用 ==========

/**
 * 通过 model-router 进行深度项目分析
 *
 * 走 InternalAgent → model-router.execute，按 `architecture` role 分派，
 * 享受重试、降级、超时、token 追踪。
 * 失败时回退到 Hermes CLI 进程（保持原行为）。
 */
export async function runHermesAnalysis(
  prompt: string,
  depth: string = "standard",
): Promise<{ content: string; model: string }> {
  const maxTokens = depth === "quick" ? 2048 : depth === "deep" ? 8192 : 4096;
  const timeout = depth === "quick" ? 30000 : depth === "deep" ? 180000 : 90000;

  logger.info("[ProjectAnalyzer] Calling model via router", { depth });

  try {
    const result = await internalAgent.executeWithRole("architecture", [
      {
        role: "system",
        content: `You are a senior software architect performing automated project analysis.
You analyze codebases to understand architecture, identify patterns, and provide actionable recommendations.
Always be specific and cite actual code elements when possible.
Respond in Chinese (中文) unless the project is entirely in another language.`,
      },
      { role: "user", content: prompt },
    ], { maxTokens, temperature: 0.3, timeout, trackAs: "project-analyzer" });

    const content = result.content || "[No response from model]";
    return { content, model: result.model || "router" };
  } catch (err) {
    logger.warn("[ProjectAnalyzer] model-router failed, falling back to Hermes CLI", {
      error: (err as Error).message,
    });
  }

  // Fallback: Hermes CLI
  try {
    const { runHermesTask, checkHermes } = await import("../agents/hermes-agent.js");
    const hermesAvailable = await checkHermes();

    if (hermesAvailable) {
      logger.info("[ProjectAnalyzer] Falling back to Hermes CLI");
      const timeoutMs = depth === "quick" ? 60000 : depth === "deep" ? 300000 : 120000;
      const result = await runHermesTask({
        prompt,
        timeoutMs,
      });

      if (result.success) {
        return { content: result.stdout, model: "hermes-cli" };
      }
      logger.warn("[ProjectAnalyzer] Hermes CLI failed", { stderr: result.stderr.slice(0, 200) });
    }
  } catch (err) {
    logger.warn("[ProjectAnalyzer] Hermes CLI fallback failed", { error: (err as Error).message });
  }

  // 最终回退: 基于静态分析生成基本报告
  return {
    content: "[Analysis model unavailable — see static scan results only]",
    model: "none",
  };
}

// ========== 报告生成 ==========

/**
 * 编译最终分析报告
 */
export function buildProjectFrameworkReport(
  analysis: string,
  structure: ProjectStructure,
  kgStats?: { entities: number; relationships: number; codegraphNodes: number },
): AnalysisResult {
  // 从分析文本中提取结构化信息
  const keyFindings = extractBulletPoints(analysis, /关键发现|Key Findings|重要发现/i);
  const designPatterns = extractBulletPoints(analysis, /设计模式|Design Patterns|Patterns/i);
  const potentialIssues = extractBulletPoints(analysis, /潜在问题|Potential Issues|问题|风险|Issues/i);
  const recommendations = extractBulletPoints(analysis, /建议|Recommendations|改进/i);

  // 提取架构摘要 (第一段非标题文本)
  let architectureSummary = "";
  const archMatch = analysis.match(/(?:架构[摘要总]*|Architecture\s*Summary)[：:\s]*\n([\s\S]*?)(?=\n#{1,3}\s|\n\n\n|$)/i);
  if (archMatch) {
    architectureSummary = archMatch[1].trim().slice(0, 1000);
  } else {
    // 使用分析文本的前500字符作为摘要
    architectureSummary = analysis.slice(0, 500).trim();
  }

  return {
    projectName: structure.name,
    structure,
    architectureSummary,
    keyFindings: keyFindings.length > 0 ? keyFindings : [
      `${structure.totalFiles} source files across ${Object.keys(structure.languages).length} languages`,
      `${structure.frameworks.length} frameworks detected`,
      structure.monorepo ? "Monorepo structure detected" : "Single-package project",
    ],
    designPatterns: designPatterns.length > 0 ? designPatterns : structure.architectureHints.slice(0, 5),
    potentialIssues: potentialIssues.length > 0 ? potentialIssues : [],
    recommendations: recommendations.length > 0 ? recommendations : [],
    kgEntities: kgStats?.entities ?? 0,
    kgRelationships: kgStats?.relationships ?? 0,
    codegraphNodes: kgStats?.codegraphNodes ?? 0,
    analysisModel: "pending", // 由调用方覆盖
    durationMs: 0, // 由调用方覆盖
  };
}

/**
 * 从分析文本中提取特定章节的要点
 */
function extractBulletPoints(text: string, sectionPattern: RegExp): string[] {
  const points: string[] = [];

  // 尝试匹配章节
  const sectionMatch = text.match(
    new RegExp(`${sectionPattern.source}[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|\\n\\n\\n|$)`, "i")
  );

  const targetText = sectionMatch ? sectionMatch[1] : text;

  // 提取 bullet points
  const bulletRegex = /[-*•]\s+(.+)/g;
  let match;
  while ((match = bulletRegex.exec(targetText)) !== null) {
    const point = match[1].trim().replace(/\*\*/g, "").slice(0, 200);
    if (point.length > 5) {
      points.push(point);
    }
  }

  // 也提取编号列表
  const numberedRegex = /\d+[.)]\s+(.+)/g;
  while ((match = numberedRegex.exec(targetText)) !== null) {
    const point = match[1].trim().replace(/\*\*/g, "").slice(0, 200);
    if (point.length > 5) {
      points.push(point);
    }
  }

  return points;
}

// ========== 完整分析管线 ==========

/**
 * 完整管线: 扫描 → CodeGraph 索引 → 知识图谱构建 → Hermes 分析 → 报告
 *
 * 这是主要入口点，一键完成新项目分析。
 */
export async function indexNewProject(options: AnalyzeOptions): Promise<AnalysisResult> {
  const startTime = Date.now();
  const {
    projectPath,
    projectName: nameOpt,
    depth = "standard",
    focusAreas,
    generateKG = true,
  } = options;

  const projectName = nameOpt || basename(
    projectPath.startsWith("/") || /^[A-Z]:\\/i.test(projectPath)
      ? projectPath
      : join(process.cwd(), projectPath)
  );

  logger.info("[ProjectAnalyzer] Starting full analysis pipeline", {
    projectPath,
    projectName,
    depth,
    generateKG,
  });

  // Step 1: 项目结构扫描
  logger.info("[ProjectAnalyzer] Step 1/4: Scanning project structure...");
  const structure = await scanProjectStructure(projectPath);

  // Step 2: CodeGraph 索引 (尝试)
  logger.info("[ProjectAnalyzer] Step 2/4: Indexing CodeGraph...");
  let codegraphContext = "";
  let codegraphNodes = 0;

  try {
    // 尝试初始化 CodeGraph (如果尚未初始化)
    const isIndexed = await isCodegraphInitialized(structure.path);
    if (!isIndexed) {
      logger.info("[ProjectAnalyzer] CodeGraph not initialized, running init...");
      const { initializeCodegraph } = await import("../memory/codegraph-index.js");
      await initializeCodegraph(structure.path);
    }

    // 获取 CodeGraph 状态
    const cgStatus = await getStatus(structure.path);
    if (cgStatus) {
      codegraphNodes = cgStatus.nodes;
    }

    // 构建上下文
    const contextTask = focusAreas
      ? `Analyze project architecture focusing on: ${focusAreas.join(", ")}`
      : "Analyze overall project architecture and key components";
    codegraphContext = await buildContext(contextTask, {
      maxNodes: depth === "quick" ? 10 : depth === "deep" ? 30 : 20,
      includeCode: depth !== "quick",
      format: "markdown",
      projectPath: structure.path,
    });

    logger.info("[ProjectAnalyzer] CodeGraph context built", {
      contextLength: codegraphContext.length,
      nodes: codegraphNodes,
    });
  } catch (err) {
    logger.warn("[ProjectAnalyzer] CodeGraph indexing skipped/failed", {
      error: (err as Error).message,
    });
  }

  // Step 3: 知识图谱构建
  let kgEntities = 0;
  let kgRelationships = 0;

  if (generateKG) {
    logger.info("[ProjectAnalyzer] Step 3/4: Building knowledge graph...");
    try {
      const kgResult: KGBuildResult = await buildKnowledgeGraph({
        projectPath: structure.path,
        projectName,
        generateEmbeddings: depth === "deep",
      });
      kgEntities = kgResult.entitiesCreated + kgResult.entitiesUpdated;
      kgRelationships = kgResult.relationshipsCreated;

      logger.info("[ProjectAnalyzer] Knowledge graph built", {
        entities: kgEntities,
        relationships: kgRelationships,
        errors: kgResult.errors.length,
      });
    } catch (err) {
      logger.warn("[ProjectAnalyzer] Knowledge graph build skipped/failed", {
        error: (err as Error).message,
      });
    }
  } else {
    logger.info("[ProjectAnalyzer] Step 3/4: Knowledge graph generation skipped (generateKG=false)");
  }

  // Step 4: Hermes 深度分析
  logger.info("[ProjectAnalyzer] Step 4/4: Running AI analysis...");
  let analysisPrompt = generateAnalysisPrompt(structure, codegraphContext);

  // 如果有聚焦领域，追加到 prompt
  if (focusAreas && focusAreas.length > 0) {
    analysisPrompt += `\n\n## Focus Areas\nPlease pay special attention to: ${focusAreas.join(", ")}.`;
  }

  const { content: analysisContent, model: analysisModel } = await runHermesAnalysis(analysisPrompt, depth);

  // 编译最终报告
  const result = buildProjectFrameworkReport(analysisContent, structure, {
    entities: kgEntities,
    relationships: kgRelationships,
    codegraphNodes,
  });

  result.analysisModel = analysisModel;
  result.durationMs = Date.now() - startTime;

  // 将架构摘要设置为 AI 分析内容 (如果模型可用)
  if (analysisModel !== "none") {
    result.architectureSummary = analysisContent.slice(0, 2000);
  }

  logger.info("[ProjectAnalyzer] Analysis pipeline complete", {
    projectName,
    durationMs: result.durationMs,
    model: analysisModel,
    kgEntities,
    kgRelationships,
    codegraphNodes,
  });

  return result;
}

/**
 * 仅执行项目结构扫描 (轻量级，不调用 AI)
 */
export async function quickScan(projectPath: string): Promise<ProjectStructure> {
  return scanProjectStructure(projectPath);
}
