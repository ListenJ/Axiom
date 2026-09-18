/**
 * agency-agents-zh 角色库 → SkillFile 转换脚本
 *
 * 用法: bun run scripts/import-agency-skills.ts <repo路径> [输出目录]
 *   默认输出到 ./skills/agency-zh/（该目录会被 PromptEngineer 自动加载）
 *
 * 仓库: https://github.com/jnMetaCode/agency-agents-zh (215 个专家角色)
 * 网络受限时可用镜像克隆: git clone https://gitclone.com/github.com/jnMetaCode/agency-agents-zh.git
 *
 * 转换规则:
 *   - 每个部门目录 → 一个 YAML SkillFile
 *   - 每个角色 .md → 一个 SkillDefinition
 *   - frontmatter 提取 name/description；正文裁剪为 promptTemplate（≤2500 字符）
 *   - triggers = 角色名核心词 + 描述关键词（供 matchSkill 关键词匹配）
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { SkillDefinition, SkillFile } from "../src/skills/types.js";

const repoRoot = process.argv[2];
const outDir = process.argv[3] ?? "./skills/agency-zh";

if (!repoRoot || !fs.existsSync(repoRoot)) {
  console.error("用法: bun run scripts/import-agency-skills.ts <repo路径> [输出目录]");
  process.exit(1);
}

/** 跳过的目录（非角色内容） */
const SKIP_DIRS = new Set(["assets", "examples", "integrations", "scripts", ".git", "node_modules"]);

/** 角色名后缀（提取核心词时去除） */
const NAME_SUFFIX_RE = /(工程师|设计师|架构师|开发师|分析师|审计师|专家|顾问|经理|专员|师|员|者|家|手|官|匠| Coach| Coach)$/;

/** 描述关键词停用词 */
const STOP_WORDS = new Set(["以及", "以及", "负责", "通过", "进行", "相关", "工作", "支持", "the", "and", "for", "with"]);

/** 从正文 markdown 提取纯文本（去 frontmatter 与标记符号，裁剪长度） */
function extractPersona(body: string, maxLen = 2500): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")   // 代码块
    .replace(/[#*|>`-]/g, " ")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

/** 解析 frontmatter（简单 YAML 子集：name/description） */
function parseFrontmatter(content: string): { name: string; description: string; body: string } | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name) return null;
  return { name, description: description ?? "", body: m[2] };
}

/** 生成触发词：角色名核心词 + 描述关键词（2-5 个） */
function buildTriggers(name: string, description: string, slugTerms: string[]): string[] {
  const triggers = new Set<string>();

  // 完整角色名（如 "后端架构师"）
  triggers.add(name);
  // 去后缀核心词（如 "后端架构"）
  const core = name.replace(NAME_SUFFIX_RE, "");
  if (core.length >= 2 && core !== name) triggers.add(core);

  // 描述中的中英文关键术语（≥2 字符的中文词 / ≥4 字符的英文词）
  const tokens = description
    .replace(/[，。、；：（）()\[\]【】/|·]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => {
      if (STOP_WORDS.has(t)) return false;
      if (/^[a-zA-Z][\w+.#-]*$/.test(t)) return t.length >= 4;
      return /^[一-龥]{2,6}$/.test(t);
    });
  for (const t of tokens.slice(0, 3)) triggers.add(t);

  // 文件名 slug 中的英文术语（如 backend-architect → backend）
  for (const t of slugTerms.slice(0, 2)) triggers.add(t);

  return [...triggers].slice(0, 6);
}

let totalSkills = 0;
let totalFiles = 0;
const errors: string[] = [];

const deptDirs = fs.readdirSync(repoRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
  .map((d) => d.name);

for (const dept of deptDirs) {
  const deptPath = path.join(repoRoot, dept);
  const mdFiles = fs.readdirSync(deptPath).filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) continue;

  const skills: SkillDefinition[] = [];
  for (const file of mdFiles) {
    const filePath = path.join(deptPath, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseFrontmatter(content);
      if (!parsed) {
        errors.push(`${dept}/${file}: no frontmatter`);
        continue;
      }
      const slug = path.basename(file, ".md");
      const slugTerms = slug.replace(new RegExp(`^${dept}-`), "").split("-").filter((t) => t.length >= 4);
      const persona = extractPersona(parsed.body);
      if (persona.length < 100) {
        errors.push(`${dept}/${file}: persona too short (${persona.length})`);
        continue;
      }
      skills.push({
        id: `agency-${dept}-${slug.replace(new RegExp(`^${dept}-`), "")}`,
        name: parsed.name,
        description: parsed.description.slice(0, 200),
        triggers: buildTriggers(parsed.name, parsed.description, slugTerms),
        promptTemplate: persona,
        requiredTools: [],
        outputFormat: "markdown",
        version: "1.0",
      });
    } catch (e) {
      errors.push(`${dept}/${file}: ${(e as Error).message}`);
    }
  }

  if (skills.length === 0) continue;

  const skillFile: SkillFile = {
    version: "1.0",
    meta: {
      name: `agency-zh/${dept}`,
      description: `agency-agents-zh 专家角色库 — ${dept} 部门（${skills.length} 个角色）`,
      author: "jnMetaCode/agency-agents-zh (MIT)",
      tags: ["agency-zh", dept],
    },
    skills,
  };

  const outPath = path.join(outDir, `${dept}.yaml`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, YAML.stringify(skillFile), "utf-8");
  totalFiles++;
  totalSkills += skills.length;
  console.log(`${dept}: ${skills.length} skills -> ${outPath}`);
}

console.log(`\n完成: ${totalFiles} 个文件, ${totalSkills} 个角色 skill`);
if (errors.length > 0) {
  console.log(`跳过 ${errors.length} 个:`);
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
}
