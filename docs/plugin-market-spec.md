# Plugin Market Specification

## Overview

OpenClaw Plugin Market 是一个内部插件系统，允许用户动态扩展 Agent 的能力。插件可以添加新的 MCP 工具、技能（Skills）、提示模板（Prompt Templates）和意图模式（Intent Patterns）。

**设计原则**:
- **内部集成**: 不依赖外部服务，所有插件本地管理
- **动态加载**: 运行时安装、启用、禁用插件，无需重启
- **安全沙箱**: 插件运行在受限环境中，防止恶意操作
- **版本兼容**: 支持语义化版本控制和依赖管理

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Plugin Market System                      │
├─────────────────────────────────────────────────────────────┤
│  Frontend (plugins.html)                                     │
│  ├─ Plugin List View                                        │
│  ├─ Plugin Detail View                                      │
│  ├─ Install/Enable/Disable Actions                          │
│  └─ Configuration Form                                      │
├─────────────────────────────────────────────────────────────┤
│  API Layer (plugin-routes.ts)                                │
│  ├─ GET /plugins (list installed)                           │
│  ├─ GET /plugins/available (list available)                 │
│  ├─ POST /plugins/install                                   │
│  ├─ POST /plugins/:id/enable                                │
│  ├─ POST /plugins/:id/disable                               │
│  ├─ POST /plugins/:id/configure                             │
│  └─ GET /plugins/tools (active tools)                       │
├─────────────────────────────────────────────────────────────┤
│  Plugin Registry (plugin-registry.ts)                        │
│  ├─ Install (download/unzip/validate)                       │
│  ├─ Enable (load module/register tools)                     │
│  ├─ Disable (unload/unregister)                             │
│  ├─ Configure (update config values)                        │
│  └─ Uninstall (remove files/cleanup)                        │
├─────────────────────────────────────────────────────────────┤
│  Storage Layer                                               │
│  ├─ SQLite (plugin metadata/status)                         │
│  ├─ File System (plugin files)                              │
│  └─ Vault (plugin data/notes)                               │
├─────────────────────────────────────────────────────────────┤
│  Plugin Loader                                               │
│  ├─ Dynamic Import (import() with sandbox)                  │
│  ├─ Tool Registration (ToolRegistry.add)                    │
│  ├─ Skill Registration (SkillLoader.load)                   │
│  └─ Intent Registration (DirectToolCaller.addPattern)       │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Model

### PluginManifest

```typescript
interface PluginManifest {
  id: string;                    // "openclaw.plugins.code-analysis"
  name: string;                  // "Code Analysis Enhanced"
  version: string;               // "1.0.0"
  author: string;                // "OpenClaw Team"
  description: string;           // "Advanced code analysis tools"
  category: "developer-tools" | "productivity" | "analysis" | "integration" | "custom";
  tags: string[];                // ["code", "analysis", "quality"]
  entry?: string;                // "index.js" (default)
  config?: PluginConfig[];       // Configuration schema
  dependencies?: string[];       // ["openclaw.plugins.base"]
  requiresOpenClaw?: string;     // "2.2.0"
  icon?: string;                 // "🔍"
  docsUrl?: string;              // "https://docs.openclaw.io/plugins/code-analysis"
}
```

### PluginConfig

```typescript
interface PluginConfig {
  key: string;                   // "maxComplexity"
  label: string;                 // "Maximum Complexity"
  type: "string" | "number" | "boolean" | "select" | "multiselect";
  description?: string;          // "Maximum allowed cyclomatic complexity"
  default?: unknown;             // 10
  required?: boolean;            // true
  options?: Array<{ label: string; value: unknown }>;
}
```

### PluginModule

```typescript
interface PluginModule {
  tools?: ToolDef[];             // MCP tools
  skills?: SkillDefinition[];    // Skills
  templates?: PromptTemplate[];  // Prompt templates
  intentPatterns?: Array<{
    id: string;
    tool: string;
    keywords: string[];
    confidence: number;
  }>;
  hooks?: {
    onEnable?: () => Promise<void>;
    onDisable?: () => Promise<void>;
    onReady?: () => Promise<void>;
  };
}
```

### Plugin (Runtime Instance)

```typescript
interface Plugin {
  manifest: PluginManifest;
  status: "available" | "installed" | "enabled" | "disabled" | "error";
  path: string;                  // Absolute path
  configValues: Record<string, unknown>;
  error?: string;                // Error message if status === "error"
  installedAt?: number;          // Timestamp
  enabledAt?: number;            // Timestamp
}
```

---

## Plugin Registry

### Lifecycle Methods

```typescript
class PluginRegistry {
  // Install a plugin from source
  async install(manifest: PluginManifest, source: string, options?: InstallOptions): Promise<Plugin>;
  
  // Enable a plugin (load and register)
  async enable(pluginId: string): Promise<void>;
  
  // Disable a plugin (unload and unregister)
  async disable(pluginId: string): Promise<void>;
  
  // Configure a plugin
  async configure(pluginId: string, config: Record<string, unknown>): Promise<void>;
  
  // Uninstall a plugin
  async uninstall(pluginId: string): Promise<void>;
  
  // Get a plugin
  getPlugin(pluginId: string): Plugin | undefined;
  
  // List all plugins
  listPlugins(filter?: PluginFilter): Plugin[];
  
  // Get available plugins (not installed)
  getAvailablePlugins(): Plugin[];
  
  // Get active tools from all enabled plugins
  getActiveTools(): ToolDef[];
}
```

### Storage Schema (SQLite)

```sql
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author TEXT,
  description TEXT,
  category TEXT,
  tags TEXT,  -- JSON array
  status TEXT NOT NULL,  -- available, installed, enabled, disabled, error
  path TEXT,
  config TEXT,  -- JSON object
  error TEXT,
  installed_at INTEGER,
  enabled_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
```

---

## Plugin Development

### Directory Structure

```
plugins/
└── my-plugin/
    ├── manifest.json       # Plugin manifest
    ├── index.ts            # Entry point
    ├── tools/
    │   ├── tool1.ts
    │   └── tool2.ts
    ├── skills/
    │   └── skill1.yaml
    └── README.md
```

### manifest.json

```json
{
  "id": "my-org.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "author": "My Org",
  "description": "A sample plugin",
  "category": "developer-tools",
  "tags": ["sample", "demo"],
  "entry": "index.js",
  "config": [
    {
      "key": "apiKey",
      "label": "API Key",
      "type": "string",
      "required": true
    }
  ],
  "requiresOpenClaw": "2.2.0"
}
```

### index.ts

```typescript
import { PluginModule, PluginContext } from "@openclaw/plugins";

const module: PluginModule = {
  tools: [
    {
      name: "my_tool",
      description: "My custom tool",
      inputSchema: { type: "object", properties: { input: { type: "string" } } },
      handler: async (args) => {
        return { result: `Processed: ${args.input}` };
      }
    }
  ],
  
  skills: [
    {
      id: "my_skill",
      name: "My Skill",
      description: "A custom skill",
      triggers: ["my trigger"],
      promptTemplate: "Process this: {{input}}",
      requiredTools: ["my_tool"],
      outputFormat: "json",
      version: "1.0.0"
    }
  ],
  
  hooks: {
    onEnable: async () => {
      console.log("Plugin enabled!");
    },
    onDisable: async () => {
      console.log("Plugin disabled!");
    }
  }
};

export default module;
```

---

## API Reference

### REST Endpoints

#### List Installed Plugins
```
GET /plugins

Response:
{
  "success": true,
  "data": {
    "plugins": [
      {
        "id": "openclaw.plugins.code-analysis",
        "name": "Code Analysis Enhanced",
        "version": "1.0.0",
        "status": "enabled",
        "category": "developer-tools",
        "tags": ["code", "analysis"]
      }
    ]
  }
}
```

#### List Available Plugins
```
GET /plugins/available

Response:
{
  "success": true,
  "data": {
    "plugins": [
      {
        "id": "openclaw.plugins.git-workflow",
        "name": "Git Workflow Enhanced",
        "version": "1.0.0",
        "status": "available"
      }
    ]
  }
}
```

#### Install Plugin
```
POST /plugins/install
Body: { "id": "openclaw.plugins.code-analysis" }

Response:
{
  "success": true,
  "data": {
    "plugin": {
      "id": "openclaw.plugins.code-analysis",
      "status": "installed"
    }
  }
}
```

#### Enable Plugin
```
POST /plugins/openclaw.plugins.code-analysis/enable

Response:
{
  "success": true
}
```

#### Disable Plugin
```
POST /plugins/openclaw.plugins.code-analysis/disable

Response:
{
  "success": true
}
```

#### Configure Plugin
```
POST /plugins/openclaw.plugins.code-analysis/configure
Body: { "config": { "maxComplexity": 15 } }

Response:
{
  "success": true
}
```

#### Uninstall Plugin
```
POST /plugins/openclaw.plugins.code-analysis/uninstall

Response:
{
  "success": true
}
```

#### Get Active Tools
```
GET /plugins/tools

Response:
{
  "success": true,
  "data": {
    "tools": [
      { "name": "analyze_complexity", "description": "..." },
      { "name": "generate_dependency_graph", "description": "..." }
    ]
  }
}
```

---

## Example Plugins

### 1. Code Analysis Enhanced

**ID**: `openclaw.plugins.code-analysis`
**Category**: developer-tools

**Tools**:
- `analyze_complexity` - Cyclomatic complexity analysis
- `generate_dependency_graph` - Import dependency visualization
- `detect_vulnerabilities` - Security vulnerability scanning

**Skills**:
- `code_quality_review` - Automated code quality assessment

### 2. Git Workflow Enhanced

**ID**: `openclaw.plugins.git-workflow`
**Category**: developer-tools

**Tools**:
- `generate_branch_name` - Generate branch names from issue titles
- `generate_commit_message` - AI-powered commit message generation
- `generate_pr_template` - PR description template generation
- `generate_changelog` - Automated CHANGELOG generation

### 3. Documentation Generator

**ID**: `openclaw.plugins.doc-generator`
**Category**: productivity

**Tools**:
- `generate_api_docs` - Generate API documentation from code
- `generate_readme` - Generate README.md from project structure
- `generate_adr` - Architecture Decision Record template

---

## Security

### Sandboxing

Plugins run in a restricted environment:
- **File Access**: Limited to plugin's data directory
- **Network**: Allowed (for API calls), but logged
- **System Calls**: Restricted (no shell execution)
- **Memory**: Limited heap size

### Validation

Before enabling a plugin:
1. **Manifest Validation**: Check schema, required fields
2. **Dependency Resolution**: Verify all dependencies are installed
3. **Version Compatibility**: Check `requiresOpenClaw`
4. **Code Review**: Static analysis of plugin code
5. **Permission Check**: Verify requested permissions

### Permission Model

```typescript
interface PluginPermissions {
  filesystem?: "read" | "write" | "read-write";
  network?: boolean;
  system?: boolean;
  clipboard?: boolean;
  vault?: "read" | "write" | "read-write";
}
```

---

## Testing

**Test File**: `tests/plugin-market.test.ts`

**Coverage**:
- Plugin installation
- Plugin enable/disable
- Plugin configuration
- Tool registration
- Error handling
- Lifecycle hooks

**Run Tests**:
```bash
bun test tests/plugin-market.test.ts
```

**Results**: 12 pass, 0 fail

---

## Frontend

**URL**: `http://localhost:18789/plugins.html`

**Features**:
- Plugin list with search/filter
- Plugin detail view
- Install/Enable/Disable buttons
- Configuration form
- Active tools display

---

## Future Enhancements

1. **Plugin Store**: Remote plugin repository (optional)
2. **Auto-Update**: Automatic plugin updates
3. **Plugin Ratings**: User ratings and reviews
4. **Plugin Analytics**: Usage statistics
5. **Plugin Templates**: Starter templates for plugin development

---

*Last Updated: 2026-06-03*
*Version: v2.3.0*
