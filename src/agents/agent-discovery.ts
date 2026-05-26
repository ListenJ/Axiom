/**
 * Agent Auto-Discovery v1.0
 * 自动扫描目录、解析 frontmatter、生成 Agent 索引
 * 支持 agency-agents-main 格式的 .md 文件
 */
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import type { AgentMeta } from "./intent-router.js";

export interface DiscoveryOptions {
  /** 扫描目录，默认从 AGENTS_DIR 环境变量或 ./data/agents 获取 */
  sourceDir?: string;
  /** 输出索引路径，默认从 AGENTS_INDEX_PATH 或 ./data/agents-index.json 获取 */
  outputPath?: string;
  /** 是否递归扫描子目录 */
  recursive?: boolean;
  /** 是否覆盖已有索引 */
  force?: boolean;
}

export interface DiscoveryResult {
  /** 扫描到的 Agent 数量 */
  count: number;
  /** 新发现的 Agent 数量 */
  newCount: number;
  /** 更新的 Agent 数量 */
  updatedCount: number;
  /** 跳过的 Agent 数量 */
  skippedCount: number;
  /** 扫描的目录 */
  sourceDir: string;
  /** 输出路径 */
  outputPath: string;
  /** 发现的 Agent 列表 */
  agents: AgentMeta[];
  /** 发现的分类 */
  categories: string[];
}

/** 解析 YAML frontmatter */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!match) return {};

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
      frontmatter[key] = value;
    }
  }
  return frontmatter;
}

/** 从文件路径推断分类 */
function inferCategory(filePath: string, baseDir: string): string {
  const relative = path.relative(baseDir, filePath);
  const dirName = path.dirname(relative);
  // 使用目录名作为分类，例如 "academic", "design/engineering"
  return dirName === "." ? "general" : dirName.replace(/\\/g, "/");
}

/** 扫描目录查找所有 .md 文件 */
function scanMarkdownFiles(dir: string, recursive = true): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    logger.warn("[AgentDiscovery] Source directory does not exist", { dir });
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      files.push(...scanMarkdownFiles(fullPath, recursive));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }

  return files;
}

/** 从单个文件提取 AgentMeta */
function extractAgentMeta(filePath: string, baseDir: string): AgentMeta | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const frontmatter = parseFrontmatter(content);

    const name = frontmatter.name;
    const description = frontmatter.description;

    if (!name || !description) {
      logger.debug("[AgentDiscovery] Skipping file without name/description", { file: filePath });
      return null;
    }

    return {
      file: filePath,
      category: inferCategory(filePath, baseDir),
      name: name.trim(),
      description: description.trim(),
      emoji: frontmatter.emoji?.trim() || "🤖",
      vibe: frontmatter.vibe?.trim() || frontmatter.personality?.trim() || "",
      tools: frontmatter.tools?.trim() || "",
    };
  } catch (e: any) {
    logger.warn("[AgentDiscovery] Failed to parse file", { file: filePath, message: e.message });
    return null;
  }
}

/** 从多个文件提取 AgentMeta */
function extractAgentsFromFiles(filePaths: string[], baseDir: string): AgentMeta[] {
  const agents: AgentMeta[] = [];
  const seenNames = new Set<string>();

  for (const filePath of filePaths) {
    const agent = extractAgentMeta(filePath, baseDir);
    if (agent && !seenNames.has(agent.name)) {
      seenNames.add(agent.name);
      agents.push(agent);
    }
  }

  return agents;
}

/** 加载现有索引 */
function loadExistingIndex(indexPath: string): AgentMeta[] {
  if (!fs.existsSync(indexPath)) return [];
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    return JSON.parse(raw) as AgentMeta[];
  } catch {
    return [];
  }
}

/** 合并新旧索引（保留已存在的，添加新发现的） */
function mergeIndexes(existing: AgentMeta[], discovered: AgentMeta[]): { merged: AgentMeta[]; newCount: number; updatedCount: number } {
  const existingMap = new Map(existing.map((a) => [a.name, a]));
  let newCount = 0;
  let updatedCount = 0;

  for (const agent of discovered) {
    const existingAgent = existingMap.get(agent.name);
    if (!existingAgent) {
      existingMap.set(agent.name, agent);
      newCount++;
    } else if (existingAgent.file !== agent.file || existingAgent.description !== agent.description) {
      // 更新元数据但保留可能的手工修改
      existingMap.set(agent.name, {
        ...existingAgent,
        file: agent.file,
        category: agent.category,
        description: agent.description,
        emoji: agent.emoji || existingAgent.emoji,
        vibe: agent.vibe || existingAgent.vibe,
        tools: agent.tools || existingAgent.tools,
      });
      updatedCount++;
    }
  }

  return { merged: Array.from(existingMap.values()), newCount, updatedCount };
}

/** 自动发现并生成 Agent 索引 */
export function discoverAgents(options: DiscoveryOptions = {}): DiscoveryResult {
  const sourceDir = options.sourceDir || process.env.AGENTS_DIR || "./data/agents";
  const outputPath = options.outputPath || process.env.AGENTS_INDEX_PATH || "./data/agents-index.json";
  const recursive = options.recursive !== false;
  const force = options.force || false;

  logger.info("[AgentDiscovery] Starting agent discovery", { sourceDir, outputPath });

  // 1. 扫描文件
  const files = scanMarkdownFiles(sourceDir, recursive);
  logger.info("[AgentDiscovery] Scanned markdown files", { count: files.length });

  // 2. 提取元数据
  const discovered = extractAgentsFromFiles(files, sourceDir);
  logger.info("[AgentDiscovery] Extracted agent metadata", { count: discovered.length });

  // 3. 合并现有索引（如果不强制覆盖）
  let agents = discovered;
  let newCount = discovered.length;
  let updatedCount = 0;
  let skippedCount = 0;

  if (!force) {
    const existing = loadExistingIndex(outputPath);
    const result = mergeIndexes(existing, discovered);
    agents = result.merged;
    newCount = result.newCount;
    updatedCount = result.updatedCount;
    skippedCount = discovered.length - newCount - updatedCount;
  }

  // 4. 按分类排序
  agents.sort((a, b) => {
    const catCompare = a.category.localeCompare(b.category);
    if (catCompare !== 0) return catCompare;
    return a.name.localeCompare(b.name);
  });

  // 5. 写入索引文件
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, JSON.stringify(agents, null, 2), "utf-8");

  const categories = [...new Set(agents.map((a) => a.category.split("/").pop() || "general"))];

  logger.info("[AgentDiscovery] Index generated", {
    total: agents.length,
    new: newCount,
    updated: updatedCount,
    skipped: skippedCount,
    categories: categories.length,
  });

  return {
    count: agents.length,
    newCount,
    updatedCount,
    skippedCount,
    sourceDir,
    outputPath,
    agents,
    categories,
  };
}

/** 检查索引是否需要更新（基于文件修改时间） */
export function shouldRegenerateIndex(indexPath: string, sourceDir: string): boolean {
  if (!fs.existsSync(indexPath)) return true;

  const indexStat = fs.statSync(indexPath);
  const files = scanMarkdownFiles(sourceDir, true);

  for (const file of files) {
    const fileStat = fs.statSync(file);
    if (fileStat.mtime > indexStat.mtime) {
      return true;
    }
  }

  return false;
}

/** 条件性重新生成索引 */
export function discoverAgentsIfNeeded(options: DiscoveryOptions = {}): DiscoveryResult | null {
  const sourceDir = options.sourceDir || process.env.AGENTS_DIR || "./data/agents";
  const outputPath = options.outputPath || process.env.AGENTS_INDEX_PATH || "./data/agents-index.json";

  if (!fs.existsSync(sourceDir)) {
    logger.debug("[AgentDiscovery] Source directory does not exist, skipping", { sourceDir });
    return null;
  }

  if (shouldRegenerateIndex(outputPath, sourceDir)) {
    return discoverAgents(options);
  }

  logger.debug("[AgentDiscovery] Index is up to date", { outputPath });
  return null;
}

/** 列出可用的 Agent 源目录 */
export function listAgentSources(): string[] {
  const sources: string[] = [];
  const defaultDir = process.env.AGENTS_DIR || "./data/agents";
  if (fs.existsSync(defaultDir)) sources.push(defaultDir);

  // 检查常见的 agency-agents 位置
  const commonPaths = [
    "C:/Users/18336/Downloads/agency-agents-main",
    "./agency-agents-main",
    "../agency-agents-main",
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p) && !sources.includes(p)) {
      sources.push(p);
    }
  }

  return sources;
}
