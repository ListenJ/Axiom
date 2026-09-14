/**
 * Git Workflow Enhanced Plugin
 *
 * 确定性文本/模板生成：按传入参数拼出分支名、commit message、PR 模板与 changelog 条目。
 * **不读文件、不执行 git、不写盘** —— 只返回文本，由调用方决定如何使用。
 *
 * 审计去伪（2026-09-14）：
 * - 本插件是三个内置插件中**唯一保留行为**的：没有随机数、没有自承模拟，
 *   4 个 handler 均有真实 return，属确定性实现而非伪造结果。
 * - plugin.json 原先还声明了 `manage_git_hooks`，但代码中**完全没有该工具**
 *   （phantom 接口）；已从清单移除，使声明与实际注册的 4 个工具一致。
 *
 * 本文件为 .js（由原 index.ts 经编译器转译，仅剥离类型语法，行为不变）：
 * 顶层 plugins/ 不在 tsconfig 的 include 范围内（仅 src/** 与 tests/**），
 * 且插件加载器走 `await import(entry)`；原声明 entry=index.js 而只有 index.ts，
 * 启用时必抛 "Entry file not found"。转为 .js 后插件**真正可加载**。
 */

var git_workflow_enhanced_default = {
  activate(context) {
    const { toolRegistry, config, logger } = context;
    const commitStyle = config.commitStyle ?? "conventional";
    const branchPrefix = config.branchPrefix ?? "feature";
    const changelogFormat = config.changelogFormat ?? "keepachangelog";
    const enableHooks = config.enableHooks ?? true;
    toolRegistry.add({
      name: "generate_branch_name",
      description: "Generate a semantic branch name from task description",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Task description" },
          prefix: { type: "string", description: "Branch prefix (feature, bugfix, hotfix, refactor)" },
          issueId: { type: "string", description: "Optional issue/ticket ID" }
        },
        required: ["description"]
      },
      handler: async (args) => {
        const description = args.description;
        const prefix = args.prefix ?? branchPrefix;
        const issueId = args.issueId;
        logger.info(`Generating branch name for: ${description}`);
        const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 50);
        const branchName = issueId ? `${prefix}/${issueId}-${slug}` : `${prefix}/${slug}`;
        return {
          branchName,
          prefix,
          slug,
          issueId,
          suggested: [
            branchName,
            `${prefix}/${slug}`,
            `${prefix}/${issueId ?? "no-id"}-${slug.substring(0, 30)}`
          ]
        };
      }
    });
    toolRegistry.add({
      name: "generate_commit_message",
      description: "Generate a conventional commit message from changes",
      inputSchema: {
        type: "object",
        properties: {
          changes: { type: "string", description: "Description of changes" },
          scope: { type: "string", description: "Component scope (optional)" },
          breaking: { type: "boolean", description: "Is this a breaking change?" },
          style: { type: "string", enum: ["conventional", "semantic", "simple"], description: "Commit style" }
        },
        required: ["changes"]
      },
      handler: async (args) => {
        const changes = args.changes;
        const scope = args.scope;
        const breaking = args.breaking ?? false;
        const style = args.style ?? commitStyle;
        logger.info(`Generating ${style} commit message`);
        const type = changes.toLowerCase().includes("fix") ? "fix" : changes.toLowerCase().includes("add") ? "feat" : changes.toLowerCase().includes("refactor") ? "refactor" : changes.toLowerCase().includes("doc") ? "docs" : changes.toLowerCase().includes("test") ? "test" : "chore";
        const scopeStr = scope ? `(${scope})` : "";
        const breakingStr = breaking ? "!" : "";
        const subject = changes.split(`
`)[0].substring(0, 72);
        let message = "";
        if (style === "conventional") {
          message = `${type}${scopeStr}${breakingStr}: ${subject}`;
        } else if (style === "semantic") {
          message = `[${type.toUpperCase()}] ${subject}`;
        } else {
          message = subject;
        }
        return {
          message,
          type,
          scope,
          breaking,
          style,
          suggestions: [
            message,
            `${type}${scopeStr}: ${subject}`,
            `${type}: ${subject}`
          ]
        };
      }
    });
    toolRegistry.add({
      name: "generate_pr_template",
      description: "Generate a pull request template",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "PR title" },
          description: { type: "string", description: "PR description" },
          changes: { type: "array", items: { type: "string" }, description: "List of changes" },
          type: { type: "string", enum: ["feature", "bugfix", "hotfix", "refactor", "docs"], description: "PR type" }
        },
        required: ["title"]
      },
      handler: async (args) => {
        const title = args.title;
        const description = args.description ?? "";
        const changes = args.changes ?? [];
        const type = args.type ?? "feature";
        logger.info(`Generating PR template for: ${title}`);
        const template = `## ${type.toUpperCase()}: ${title}

### Description
${description || "Brief description of changes"}

### Changes
${changes.map((c) => `- ${c}`).join(`
`) || "- "}

### Type
- [x] ${type}
${type !== "feature" ? "- [ ] feature" : "- [ ] feature"}
${type !== "bugfix" ? "- [ ] bugfix" : "- [ ] bugfix"}
${type !== "hotfix" ? "- [ ] hotfix" : "- [ ] hotfix"}

### Testing
- [ ] Unit tests added/updated
- [ ] Integration tests passed
- [ ] Manual testing completed

### Checklist
- [ ] Code follows project style
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No breaking changes (or marked accordingly)
`;
        return {
          title,
          type,
          template,
          markdown: template
        };
      }
    });
    toolRegistry.add({
      name: "update_changelog",
      description: "Update changelog with new entry",
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "string", description: "Version number" },
          changes: { type: "array", items: { type: "string" }, description: "List of changes" },
          type: { type: "string", enum: ["added", "changed", "deprecated", "removed", "fixed", "security"], description: "Change type" }
        },
        required: ["version", "changes"]
      },
      handler: async (args) => {
        const version = args.version;
        const changes = args.changes;
        const type = args.type ?? "added";
        logger.info(`Updating changelog for v${version}`);
        const date = new Date().toISOString().split("T")[0];
        let entry = "";
        if (changelogFormat === "keepachangelog") {
          entry = `## [${version}] - ${date}

### ${type.charAt(0).toUpperCase() + type.slice(1)}
${changes.map((c) => `- ${c}`).join(`
`)}
`;
        } else {
          entry = `## ${version} (${date})

- ${changes.join(`
- `)}
`;
        }
        return {
          version,
          date,
          type,
          entry,
          format: changelogFormat
        };
      }
    });
    logger.info("Git Workflow Enhanced plugin activated");
  },
  deactivate(context) {
    context.logger.info("Git Workflow Enhanced plugin deactivated");
  }
};
export {
  git_workflow_enhanced_default as default
};
