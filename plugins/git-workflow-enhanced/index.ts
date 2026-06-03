/**
 * Git Workflow Enhanced Plugin
 * 
 * Provides advanced Git workflow automation:
 * - Smart branch naming
 * - Commit message generation
 * - PR template generation
 * - Changelog management
 * - Git hook management
 */

import type { PluginContext } from "../../src/plugins/types.js";

export default {
  activate(context: PluginContext) {
    const { toolRegistry, config, logger } = context;
    const commitStyle = (config.commitStyle as string) ?? "conventional";
    const branchPrefix = (config.branchPrefix as string) ?? "feature";
    const changelogFormat = (config.changelogFormat as string) ?? "keepachangelog";
    const enableHooks = (config.enableHooks as boolean) ?? true;

    // Tool: generate_branch_name
    toolRegistry.add({
      name: "generate_branch_name",
      description: "Generate a semantic branch name from task description",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Task description" },
          prefix: { type: "string", description: "Branch prefix (feature, bugfix, hotfix, refactor)" },
          issueId: { type: "string", description: "Optional issue/ticket ID" },
        },
        required: ["description"],
      },
      handler: async (args: Record<string, unknown>) => {
        const description = args.description as string;
        const prefix = (args.prefix as string) ?? branchPrefix;
        const issueId = args.issueId as string | undefined;
        
        logger.info(`Generating branch name for: ${description}`);
        
        // Convert description to kebab-case
        const slug = description
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .substring(0, 50);
        
        const branchName = issueId 
          ? `${prefix}/${issueId}-${slug}`
          : `${prefix}/${slug}`;
        
        return {
          branchName,
          prefix,
          slug,
          issueId,
          suggested: [
            branchName,
            `${prefix}/${slug}`,
            `${prefix}/${issueId ?? "no-id"}-${slug.substring(0, 30)}`,
          ],
        };
      },
    });

    // Tool: generate_commit_message
    toolRegistry.add({
      name: "generate_commit_message",
      description: "Generate a conventional commit message from changes",
      inputSchema: {
        type: "object",
        properties: {
          changes: { type: "string", description: "Description of changes" },
          scope: { type: "string", description: "Component scope (optional)" },
          breaking: { type: "boolean", description: "Is this a breaking change?" },
          style: { type: "string", enum: ["conventional", "semantic", "simple"], description: "Commit style" },
        },
        required: ["changes"],
      },
      handler: async (args: Record<string, unknown>) => {
        const changes = args.changes as string;
        const scope = args.scope as string | undefined;
        const breaking = (args.breaking as boolean) ?? false;
        const style = (args.style as string) ?? commitStyle;
        
        logger.info(`Generating ${style} commit message`);
        
        const type = changes.toLowerCase().includes("fix") ? "fix"
          : changes.toLowerCase().includes("add") ? "feat"
          : changes.toLowerCase().includes("refactor") ? "refactor"
          : changes.toLowerCase().includes("doc") ? "docs"
          : changes.toLowerCase().includes("test") ? "test"
          : "chore";
        
        const scopeStr = scope ? `(${scope})` : "";
        const breakingStr = breaking ? "!" : "";
        const subject = changes.split("\n")[0].substring(0, 72);
        
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
            `${type}: ${subject}`,
          ],
        };
      },
    });

    // Tool: generate_pr_template
    toolRegistry.add({
      name: "generate_pr_template",
      description: "Generate a pull request template",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "PR title" },
          description: { type: "string", description: "PR description" },
          changes: { type: "array", items: { type: "string" }, description: "List of changes" },
          type: { type: "string", enum: ["feature", "bugfix", "hotfix", "refactor", "docs"], description: "PR type" },
        },
        required: ["title"],
      },
      handler: async (args: Record<string, unknown>) => {
        const title = args.title as string;
        const description = (args.description as string) ?? "";
        const changes = (args.changes as string[]) ?? [];
        const type = (args.type as string) ?? "feature";
        
        logger.info(`Generating PR template for: ${title}`);
        
        const template = `## ${type.toUpperCase()}: ${title}

### Description
${description || "Brief description of changes"}

### Changes
${changes.map((c) => `- ${c}`).join("\n") || "- "}

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
          markdown: template,
        };
      },
    });

    // Tool: update_changelog
    toolRegistry.add({
      name: "update_changelog",
      description: "Update changelog with new entry",
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "string", description: "Version number" },
          changes: { type: "array", items: { type: "string" }, description: "List of changes" },
          type: { type: "string", enum: ["added", "changed", "deprecated", "removed", "fixed", "security"], description: "Change type" },
        },
        required: ["version", "changes"],
      },
      handler: async (args: Record<string, unknown>) => {
        const version = args.version as string;
        const changes = args.changes as string[];
        const type = (args.type as string) ?? "added";
        
        logger.info(`Updating changelog for v${version}`);
        
        const date = new Date().toISOString().split("T")[0];
        
        let entry = "";
        if (changelogFormat === "keepachangelog") {
          entry = `## [${version}] - ${date}\n\n### ${type.charAt(0).toUpperCase() + type.slice(1)}\n${changes.map((c) => `- ${c}`).join("\n")}\n`;
        } else {
          entry = `## ${version} (${date})\n\n- ${changes.join("\n- ")}\n`;
        }
        
        return {
          version,
          date,
          type,
          entry,
          format: changelogFormat,
        };
      },
    });

    logger.info("Git Workflow Enhanced plugin activated");
  },

  deactivate(context: PluginContext) {
    context.logger.info("Git Workflow Enhanced plugin deactivated");
  },
};
