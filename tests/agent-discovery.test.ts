/**
 * Agent 自动发现机制测试套件
 * 覆盖：frontmatter 解析、目录扫描、分类推断、索引合并、条件性重新生成
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import {
  discoverAgents,
  discoverAgentsIfNeeded,
  shouldRegenerateIndex,
  listAgentSources,
  type DiscoveryOptions,
} from "../src/agents/agent-discovery.js";

const TEST_AGENTS_DIR = "./tests/fixtures/agents";
const TEST_INDEX_PATH = "./tests/fixtures/agents-index.json";

function createTestAgent(
  dir: string,
  fileName: string,
  frontmatter: Record<string, string>,
  content = "# Agent\n\nThis is a test agent."
) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const fullContent = `---\n${fm}\n---\n\n${content}`;
  fs.writeFileSync(path.join(dir, fileName), fullContent, "utf-8");
}

describe("AgentDiscovery", () => {
  beforeEach(() => {
    // 清理并创建测试目录
    fs.rmSync(TEST_AGENTS_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_AGENTS_DIR, { recursive: true });
    // 清理索引文件
    if (fs.existsSync(TEST_INDEX_PATH)) {
      fs.unlinkSync(TEST_INDEX_PATH);
    }
  });

  afterEach(() => {
    fs.rmSync(TEST_AGENTS_DIR, { recursive: true, force: true });
    if (fs.existsSync(TEST_INDEX_PATH)) {
      fs.unlinkSync(TEST_INDEX_PATH);
    }
  });

  test("发现单个 Agent", () => {
    createTestAgent(TEST_AGENTS_DIR, "test-agent.md", {
      name: "TestAgent",
      description: "A test agent for unit testing",
      emoji: "🧪",
      vibe: "helpful",
      tools: "search, fetch",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(1);
    expect(result.newCount).toBe(1);
    expect(result.agents[0].name).toBe("TestAgent");
    expect(result.agents[0].category).toBe("general");
    expect(result.agents[0].emoji).toBe("🧪");
    expect(result.agents[0].vibe).toBe("helpful");
    expect(result.agents[0].tools).toBe("search, fetch");
  });

  test("从子目录推断分类", () => {
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, "academic"), { recursive: true });
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, "design", "engineering"), { recursive: true });

    createTestAgent(path.join(TEST_AGENTS_DIR, "academic"), "researcher.md", {
      name: "Researcher",
      description: "Academic research assistant",
    });

    createTestAgent(path.join(TEST_AGENTS_DIR, "design", "engineering"), "architect.md", {
      name: "Architect",
      description: "System architect",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(2);
    const researcher = result.agents.find((a) => a.name === "Researcher");
    const architect = result.agents.find((a) => a.name === "Architect");
    expect(researcher?.category).toBe("academic");
    expect(architect?.category).toBe("design/engineering");
  });

  test("跳过缺少 name 的文件", () => {
    createTestAgent(TEST_AGENTS_DIR, "bad-agent.md", {
      description: "Missing name",
    });

    createTestAgent(TEST_AGENTS_DIR, "good-agent.md", {
      name: "GoodAgent",
      description: "Has both fields",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(1);
    expect(result.agents[0].name).toBe("GoodAgent");
  });

  test("跳过缺少 description 的文件", () => {
    createTestAgent(TEST_AGENTS_DIR, "bad-agent.md", {
      name: "BadAgent",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(0);
  });

  test("跳过非 .md 文件", () => {
    fs.writeFileSync(path.join(TEST_AGENTS_DIR, "readme.txt"), "Not a markdown file", "utf-8");
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "RealAgent",
      description: "Real agent",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(1);
    expect(result.agents[0].name).toBe("RealAgent");
  });

  test("重复 name 去重", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent1.md", {
      name: "Duplicate",
      description: "First occurrence",
    });
    createTestAgent(TEST_AGENTS_DIR, "agent2.md", {
      name: "Duplicate",
      description: "Second occurrence",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(1);
    expect(result.agents[0].description).toBe("First occurrence");
  });

  test("合并现有索引：保留旧 Agent", () => {
    // 先创建初始索引
    createTestAgent(TEST_AGENTS_DIR, "old.md", {
      name: "OldAgent",
      description: "Existing agent",
      emoji: "🔮",
    });
    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    // 添加新 Agent，重新生成
    createTestAgent(TEST_AGENTS_DIR, "new.md", {
      name: "NewAgent",
      description: "Newly discovered",
    });
    const result = discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    expect(result.count).toBe(2);
    expect(result.newCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.agents.some((a) => a.name === "OldAgent")).toBe(true);
    expect(result.agents.some((a) => a.name === "NewAgent")).toBe(true);
  });

  test("合并现有索引：更新变更的 Agent", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "MutableAgent",
      description: "Original description",
      emoji: "😀",
    });
    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    // 修改文件内容
    fs.writeFileSync(
      path.join(TEST_AGENTS_DIR, "agent.md"),
      `---\nname: MutableAgent\ndescription: Updated description\nemoji: 🚀\n---\n\nUpdated content`,
      "utf-8"
    );

    const result = discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    expect(result.count).toBe(1);
    expect(result.updatedCount).toBe(1);
    const agent = result.agents.find((a) => a.name === "MutableAgent");
    expect(agent?.description).toBe("Updated description");
    expect(agent?.emoji).toBe("🚀");
  });

  test("force 覆盖跳过合并", () => {
    createTestAgent(TEST_AGENTS_DIR, "old.md", {
      name: "OldAgent",
      description: "Will be deleted",
    });
    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    // 删除文件，强制重新生成
    fs.unlinkSync(path.join(TEST_AGENTS_DIR, "old.md"));

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
      force: true,
    });

    expect(result.count).toBe(0);
    expect(result.newCount).toBe(0);
  });

  test("按分类和名称排序", () => {
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, "beta"), { recursive: true });
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, "alpha"), { recursive: true });

    createTestAgent(path.join(TEST_AGENTS_DIR, "beta"), "b.md", {
      name: "BetaB",
      description: "Beta B",
    });
    createTestAgent(path.join(TEST_AGENTS_DIR, "alpha"), "a.md", {
      name: "AlphaA",
      description: "Alpha A",
    });
    createTestAgent(path.join(TEST_AGENTS_DIR, "beta"), "a.md", {
      name: "BetaA",
      description: "Beta A",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.agents[0].name).toBe("AlphaA");
    expect(result.agents[1].name).toBe("BetaA");
    expect(result.agents[2].name).toBe("BetaB");
  });

  test("解析 vibe 和 personality 别名", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent1.md", {
      name: "VibeAgent",
      description: "Has vibe",
      vibe: "chill",
    });
    createTestAgent(TEST_AGENTS_DIR, "agent2.md", {
      name: "PersonalityAgent",
      description: "Has personality",
      personality: "strict",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    const vibeAgent = result.agents.find((a) => a.name === "VibeAgent");
    const personalityAgent = result.agents.find((a) => a.name === "PersonalityAgent");
    expect(vibeAgent?.vibe).toBe("chill");
    expect(personalityAgent?.vibe).toBe("strict");
  });

  test("默认 emoji", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "NoEmoji",
      description: "No emoji specified",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.agents[0].emoji).toBe("🤖");
  });

  test("空目录返回空结果", () => {
    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(0);
    expect(result.categories).toEqual([]);
  });

  test("不存在的源目录返回空结果", () => {
    const result = discoverAgents({
      sourceDir: "./tests/fixtures/nonexistent",
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(0);
  });

  test("shouldRegenerateIndex：索引不存在时返回 true", () => {
    const should = shouldRegenerateIndex(TEST_INDEX_PATH, TEST_AGENTS_DIR);
    expect(should).toBe(true);
  });

  test("shouldRegenerateIndex：文件比索引新时返回 true", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "Agent",
      description: "Test",
    });
    // 先生成索引
    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    // 等待一小段时间确保 mtime 不同
    Bun.sleepSync(100);

    // 创建新文件
    createTestAgent(TEST_AGENTS_DIR, "new-agent.md", {
      name: "NewAgent",
      description: "New",
    });

    const should = shouldRegenerateIndex(TEST_INDEX_PATH, TEST_AGENTS_DIR);
    expect(should).toBe(true);
  });

  test("shouldRegenerateIndex：没有变更时返回 false", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "Agent",
      description: "Test",
    });
    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    const should = shouldRegenerateIndex(TEST_INDEX_PATH, TEST_AGENTS_DIR);
    expect(should).toBe(false);
  });

  test("discoverAgentsIfNeeded：源目录不存在返回 null", () => {
    const result = discoverAgentsIfNeeded({
      sourceDir: "./tests/fixtures/nonexistent",
      outputPath: TEST_INDEX_PATH,
    });
    expect(result).toBeNull();
  });

  test("discoverAgentsIfNeeded：索引最新时返回 null", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "Agent",
      description: "Test",
    });
    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    const result = discoverAgentsIfNeeded({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });
    expect(result).toBeNull();
  });

  test("discoverAgentsIfNeeded：索引过期时重新生成", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "Agent",
      description: "Test",
    });
    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    Bun.sleepSync(100);

    createTestAgent(TEST_AGENTS_DIR, "new-agent.md", {
      name: "NewAgent",
      description: "New",
    });

    const result = discoverAgentsIfNeeded({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result).not.toBeNull();
    expect(result!.count).toBe(2);
  });

  test("写入的索引文件可被正确读取", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "PersistedAgent",
      description: "Should be in JSON",
      emoji: "💾",
      vibe: "persistent",
      tools: "save",
    });

    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    const raw = fs.readFileSync(TEST_INDEX_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe("PersistedAgent");
    expect(parsed[0].emoji).toBe("💾");
  });

  test("分类统计正确", () => {
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, "cat1"), { recursive: true });
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, "cat2"), { recursive: true });

    createTestAgent(path.join(TEST_AGENTS_DIR, "cat1"), "a.md", {
      name: "A1",
      description: "A1",
    });
    createTestAgent(path.join(TEST_AGENTS_DIR, "cat1"), "b.md", {
      name: "B1",
      description: "B1",
    });
    createTestAgent(path.join(TEST_AGENTS_DIR, "cat2"), "a.md", {
      name: "A2",
      description: "A2",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.categories).toContain("cat1");
    expect(result.categories).toContain("cat2");
    expect(result.categories.length).toBe(2);
  });

  test("嵌套子目录递归扫描", () => {
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, "a", "b", "c"), { recursive: true });

    createTestAgent(path.join(TEST_AGENTS_DIR, "a", "b", "c"), "deep.md", {
      name: "DeepAgent",
      description: "Deeply nested",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(1);
    expect(result.agents[0].name).toBe("DeepAgent");
    expect(result.agents[0].category).toBe("a/b/c");
  });

  test("非递归模式不扫描子目录", () => {
    fs.mkdirSync(path.join(TEST_AGENTS_DIR, "sub"), { recursive: true });

    createTestAgent(TEST_AGENTS_DIR, "root.md", {
      name: "RootAgent",
      description: "In root",
    });
    createTestAgent(path.join(TEST_AGENTS_DIR, "sub"), "sub.md", {
      name: "SubAgent",
      description: "In subdir",
    });

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
      recursive: false,
    });

    expect(result.count).toBe(1);
    expect(result.agents[0].name).toBe("RootAgent");
  });

  test("YAML frontmatter 解析：带引号的值", () => {
    fs.writeFileSync(
      path.join(TEST_AGENTS_DIR, "quoted.md"),
      `---\nname: "Quoted Agent"\ndescription: 'A quoted description'\n---\n\nContent`,
      "utf-8"
    );

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.agents[0].name).toBe("Quoted Agent");
    expect(result.agents[0].description).toBe("A quoted description");
  });

  test("YAML frontmatter 解析：无 frontmatter 文件", () => {
    fs.writeFileSync(
      path.join(TEST_AGENTS_DIR, "no-frontmatter.md"),
      `# No Frontmatter\n\nThis file has no frontmatter.`,
      "utf-8"
    );

    const result = discoverAgents({
      sourceDir: TEST_AGENTS_DIR,
      outputPath: TEST_INDEX_PATH,
    });

    expect(result.count).toBe(0);
  });

  test("合并时保留已有字段：手工修改的 emoji 不被覆盖", () => {
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "Preserved",
      description: "Original",
      emoji: "😀",
    });
    discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    // 手动修改索引中的 emoji
    const index = JSON.parse(fs.readFileSync(TEST_INDEX_PATH, "utf-8"));
    index[0].emoji = "🎨";
    fs.writeFileSync(TEST_INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");

    // 重新发现（描述相同，不应更新 emoji）
    Bun.sleepSync(100);
    createTestAgent(TEST_AGENTS_DIR, "agent.md", {
      name: "Preserved",
      description: "Original",
      emoji: "😀",
    });

    const result = discoverAgents({ sourceDir: TEST_AGENTS_DIR, outputPath: TEST_INDEX_PATH });

    expect(result.updatedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    const agent = result.agents.find((a) => a.name === "Preserved");
    // emoji 应保持手工修改的值
    expect(agent?.emoji).toBe("🎨");
  });
});
