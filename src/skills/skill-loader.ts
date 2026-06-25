/**
 * Dynamic Skill Loader
 *
 * Loads skills and prompt templates from external files.
 * Supports JSON and YAML formats.
 * Watches for file changes in development mode.
 */

import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { type SkillDefinition, type PromptTemplate, type SkillFile } from "./types.js";

// Try to import yaml, fallback to JSON-only if not available
let YAML: typeof import("yaml") | null = null;
try {
  YAML = await import("yaml");
} catch {
  logger.warn("[SkillLoader] yaml package not available, YAML skill files will be skipped");
}

export interface SkillLoaderOptions {
  /** Directories to scan for skill files */
  skillDirs: string[];
  /** File extensions to load (without dot) */
  extensions?: string[];
  /** Enable file watching for hot reload */
  watch?: boolean;
}

export interface LoadedSkills {
  skills: Map<string, SkillDefinition>;
  templates: Map<string, PromptTemplate>;
  errors: Array<{ file: string; error: string }>;
}

/** In-memory cache to avoid repeated disk reads */
let _skillCache: LoadedSkills | null = null;
let _lastOptsHash = "";

function hashOpts(opts: SkillLoaderOptions): string {
  return JSON.stringify([opts.skillDirs, opts.extensions || ["json", "yaml", "yml"]]);
}

/**
 * Load all skills from configured directories.
 * Results are cached in memory; use forceReload to bust cache.
 */
export function loadSkillsFromDirectories(opts: SkillLoaderOptions, forceReload = false): LoadedSkills {
  const optsHash = hashOpts(opts);
  if (!forceReload && _skillCache && _lastOptsHash === optsHash) {
    return _skillCache;
  }

  const extensions = opts.extensions || ["json", "yaml", "yml"];
  const skills = new Map<string, SkillDefinition>();
  const templates = new Map<string, PromptTemplate>();
  const errors: Array<{ file: string; error: string }> = [];

  for (const dir of opts.skillDirs) {
    if (!fs.existsSync(dir)) {
      logger.debug("[SkillLoader] Skill directory does not exist, skipping", { dir });
      continue;
    }

    const files = fs.readdirSync(dir).filter((f) => {
      const ext = path.extname(f).slice(1).toLowerCase();
      return extensions.includes(ext);
    });

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const result = loadSkillFile(filePath);

        // Merge skills
        for (const skill of result.skills) {
          skill.source = "file";
          skill.filePath = filePath;
          // Deduplicate by id, prefer file versions
          if (skills.has(skill.id)) {
            const existing = skills.get(skill.id)!;
            if (existing.source === "builtin") {
              logger.info("[SkillLoader] Overriding builtin skill with file version", { id: skill.id, file });
            } else {
              logger.warn("[SkillLoader] Duplicate skill id, overwriting", { id: skill.id, file });
            }
          }
          skills.set(skill.id, skill);
        }

        // Merge templates
        for (const template of result.templates || []) {
          template.source = "file";
          template.filePath = filePath;
          if (templates.has(template.id)) {
            logger.warn("[SkillLoader] Duplicate template id, overwriting", { id: template.id, file });
          }
          templates.set(template.id, template);
        }

        logger.info("[SkillLoader] Loaded skill file", {
          file,
          skills: result.skills.length,
          templates: result.templates?.length || 0,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ file: filePath, error: msg });
        logger.warn("[SkillLoader] Failed to load skill file", { file: filePath, error: msg });
      }
    }
  }

  _skillCache = { skills, templates, errors };
  _lastOptsHash = optsHash;
  return _skillCache;
}

/** Explicitly clear the skill cache (e.g. after skill_reload) */
export function clearSkillCache(): void {
  _skillCache = null;
  _lastOptsHash = "";
}

/**
 * Load a single skill file (JSON or YAML)
 */
export function loadSkillFile(filePath: string): SkillFile {
  const content = fs.readFileSync(filePath, "utf-8");
  const ext = path.extname(filePath).toLowerCase();

  let data: unknown;

  if (ext === ".json") {
    data = JSON.parse(content);
  } else if ((ext === ".yaml" || ext === ".yml") && YAML) {
    data = YAML.parse(content);
  } else {
    throw new Error(`Unsupported skill file format: ${ext}`);
  }

  // Validate minimal structure
  if (!data || typeof data !== "object") {
    throw new Error("Invalid skill file: must be an object");
  }

  const skillFile = data as SkillFile;

  if (!skillFile.skills || !Array.isArray(skillFile.skills)) {
    throw new Error("Invalid skill file: missing 'skills' array");
  }

  // Validate each skill has required fields
  for (let i = 0; i < skillFile.skills.length; i++) {
    const skill = skillFile.skills[i];
    if (!skill.id) throw new Error(`Skill at index ${i} missing 'id'`);
    if (!skill.name) throw new Error(`Skill at index ${i} missing 'name'`);
    if (!skill.promptTemplate) throw new Error(`Skill at index ${i} missing 'promptTemplate'`);
    if (!skill.triggers || !Array.isArray(skill.triggers)) {
      skill.triggers = [];
    }
    if (!skill.requiredTools) skill.requiredTools = [];
    if (!skill.outputFormat) skill.outputFormat = "text";
    if (!skill.version) skill.version = "1.0";
  }

  // Validate templates if present
  if (skillFile.templates) {
    for (let i = 0; i < skillFile.templates.length; i++) {
      const tpl = skillFile.templates[i];
      if (!tpl.id) throw new Error(`Template at index ${i} missing 'id'`);
      if (!tpl.template) throw new Error(`Template at index ${i} missing 'template'`);
      if (!tpl.variables) tpl.variables = [];
      if (!tpl.tags) tpl.tags = [];
      if (!tpl.version) tpl.version = "1.0";
    }
  }

  return skillFile;
}

/**
 * Save a skill file to disk
 */
export function saveSkillFile(filePath: string, skillFile: SkillFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const ext = path.extname(filePath).toLowerCase();

  let content: string;
  if (ext === ".json") {
    content = JSON.stringify(skillFile, null, 2);
  } else if ((ext === ".yaml" || ext === ".yml") && YAML) {
    content = YAML.stringify(skillFile);
  } else {
    throw new Error(`Unsupported skill file format: ${ext}`);
  }

  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Create a new skill file with boilerplate
 */
export function createSkillFileBoilerplate(meta: {
  name: string;
  description: string;
  author?: string;
}): SkillFile {
  return {
    version: "1.0",
    meta: {
      name: meta.name,
      description: meta.description,
      author: meta.author,
      tags: [],
    },
    skills: [
      {
        id: "example-skill",
        name: "示例 Skill",
        description: "这是一个示例 skill，请修改",
        triggers: ["示例", "example"],
        promptTemplate: "请处理: {{input}}",
        requiredTools: [],
        outputFormat: "text",
        version: "1.0",
      },
    ],
    templates: [],
  };
}

/**
 * Watch skill directories for changes (development mode)
 */
export function watchSkillDirectories(
  opts: SkillLoaderOptions,
  onChange: (loaded: LoadedSkills) => void
): () => void {
  if (!opts.watch) return () => {};

  const watchers: fs.FSWatcher[] = [];

  for (const dir of opts.skillDirs) {
    if (!fs.existsSync(dir)) continue;

    const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const ext = path.extname(filename).slice(1).toLowerCase();
      if (!opts.extensions?.includes(ext)) return;

      logger.info("[SkillLoader] Skill file changed, reloading", { event: eventType, file: filename });

      // Debounce reload
      setTimeout(() => {
        const loaded = loadSkillsFromDirectories(opts);
        onChange(loaded);
      }, 100);
    });

    watchers.push(watcher);
  }

  // Return cleanup function
  return () => {
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}
