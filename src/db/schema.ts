/**
 * SQLite Schema 定义
 * 采用 Drizzle ORM 的 SQLite 方言
 * 对应 L1 短期记忆 / L2 任务记忆 / L3 语义记忆 三层模型
 */
import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";

// ========== L1 短期记忆：对话消息流 ==========
export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id").notNull(),
  agentId: text("agent_id").notNull(),
  role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
  content: text("content").notNull(),
  toolCalls: text("tool_calls", { mode: "json" }),
  toolResults: text("tool_results", { mode: "json" }),
  tokensUsed: integer("tokens_used"),
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// ========== L2 任务记忆：任务生命周期 ==========
export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskKey: text("task_key").unique().notNull(),
  agentId: text("agent_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status", {
    enum: ["pending", "in_progress", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("pending"),
  priority: integer("priority").notNull().default(5),
  parentTaskId: integer("parent_task_id"),
  metadata: text("metadata", { mode: "json" }),
  contextSummary: text("context_summary"),
  resultSummary: text("result_summary"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ========== L3 语义记忆：知识蒸馏 ==========
export const knowledge = sqliteTable("knowledge", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tier: text("tier", {
    enum: ["episodic", "semantic", "project", "procedural"],
  })
    .notNull()
    .default("semantic"),
  source: text("source").notNull(),
  topicKey: text("topic_key").notNull(),
  content: text("content").notNull(),
  metadata: text("metadata", { mode: "json" }),
  confidence: real("confidence").notNull().default(0.7),
  accessCount: integer("access_count").notNull().default(0),
  distilled: integer("distilled", { mode: "boolean" }).notNull().default(false),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// ========== 知识图谱：实体与关系 ==========
export const entities = sqliteTable("entities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").unique().notNull(),
  type: text("type").notNull(), // person / org / concept / tool / file
  properties: text("properties", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const relationships = sqliteTable("relationships", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceEntity: integer("source_entity").notNull(),
  targetEntity: integer("target_entity").notNull(),
  relationType: text("relation_type").notNull(), // uses / depends_on / part_of / mentions
  properties: text("properties", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// ========== 模型使用监控 ==========
export const modelUsage = sqliteTable("model_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  modelName: text("model_name").notNull(),
  provider: text("provider").notNull(),
  tier: integer("tier").notNull(),
  tokensInput: integer("tokens_input").default(0),
  tokensOutput: integer("tokens_output").default(0),
  tokensTotal: integer("tokens_total").default(0),
  latencyMs: integer("latency_ms"),
  costEstimate: real("cost_estimate").default(0),
  taskType: text("task_type"),
  success: integer("success", { mode: "boolean" }).default(true),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// ========== 免费模型缓存 ==========
export const freeModels = sqliteTable("free_models", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  contextLength: integer("context_length"),
  description: text("description"),
  isAvailable: integer("is_available", { mode: "boolean" }).default(true),
  discoveredAt: text("discovered_at"),
  lastCheckedAt: text("last_checked_at").default("CURRENT_TIMESTAMP"),
});

// ========== 爬取结果持久化 ==========
export const crawlResults = sqliteTable("crawl_results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  urlHash: text("url_hash").notNull().unique(),
  title: text("title"),
  description: text("description"),
  siteName: text("site_name"),
  language: text("language"),
  markdown: text("markdown"),
  structuredData: text("structured_data", { mode: "json" }),
  headings: text("headings", { mode: "json" }),
  tables: text("tables", { mode: "json" }),
  codeBlocks: text("code_blocks", { mode: "json" }),
  images: text("images", { mode: "json" }),
  links: text("links", { mode: "json" }),
  chunks: text("chunks", { mode: "json" }),
  wordCount: integer("word_count").default(0),
  qualityScore: real("quality_score").default(0),
  fetchEngine: text("fetch_engine").default("bun"),
  fingerprintId: text("fingerprint_id"),
  proxyUsed: text("proxy_used"),
  status: text("status", { enum: ["success", "failed", "timeout"] }).default("success"),
  errorMessage: text("error_message"),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// ========== 搜索历史 ==========
export const searchHistory = sqliteTable("search_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  query: text("query").notNull(),
  queryHash: text("query_hash").notNull(),
  engines: text("engines"),
  resultsCount: integer("results_count").default(0),
  topResultUrl: text("top_result_url"),
  latencyMs: integer("latency_ms"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
