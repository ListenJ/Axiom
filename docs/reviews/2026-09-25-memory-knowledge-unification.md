# 记忆/知识库统一性审计（2026-09-25）

> 问题：记忆系统是否统一收回到一个统一的知识库后端接口？记忆与知识收集接口是否统一稳定？
> 范围：记忆与知识面 + 收集/摄取链路。**记忆生长（蒸馏/wiki-link）与自进化不在本轮**。
> 口径：每条结论带 文件:行号 或可重跑命令；架构级缺口登记交裁决，不擅自重路由。

## 一、裁定速览

| 判据 | 裁定 | 关键证据 |
| --- | --- | --- |
| DB 层是否单库统一 | **一致** | memory/knowledge/KG/code-index/chat 记账全部在 `data/agent.db`（139MB，33 表）；`scripts/merge-knowledge-dbs.ts:19` 记载三碎片库（code-index/dre/knowledge.db）已完成合并 |
| 收集/摄取是否单缝 | **一致** | collector 单缝：`isCollected` 去重 → `storeAsVaultNote`（vault md + DB 记账）→ 技能/字典同样入 store（`knowledge/collector.ts:71,110,180`） |
| 查询接口是否统一 | **不一致（三查询面并存）** | KAL `query()` 扇出 vault+kg+dre（`knowledge-access-layer.ts:92-97`）**唯一消费方是 mcp kg-tools:16**；chat 走 `services/knowledge.ts` 独立管线；kg CLI 直连 `KnowledgeGraphEnhanced`（`cli/commands/kg.ts:37-38`） |
| 稳定性（错误/并发/降级） | **一致（未发现静默吞错）** | 两侧 SQLite 均 WAL（`store.ts:16`、`sqlite-memory.ts:176`）；KAL 逐 store try/catch + 单数表回退（O3-F4）+ 分数归一化（O3-F5）；检索面 bounded（edges LIMIT 50 / 结果 LIMIT 20） |

## 二、统一接口的真实形状

**KAL（设计上的统一查询面）**：`KnowledgeAccessLayer.query(intent)`（594 行，零 LLM）
- 扇出三路：`queryVault`（FTS5 记忆笔记）/ `queryKG`（kg_nodes/kg_edges）/ `queryDRE`；`targetStore` 可指定单路
- 合并后按 store 分组求 maxScore 归一化再排序（O3-F5，防某库被分数尺度压制）
- `getReferences(nodeId)`：kg_edges 复数表 UNION 历史单数 kg_edge，单数缺失回退仅复数腿（`knowledge-access-layer.ts:438-456`）；vault wiki-link 图在文件层内存构建、不入库——边界已如实注释（LIMITATIONS §1 同源）
- **唯一生产消费方**：`mcp/server/kg-tools.ts:16`

**记忆面（独立但自洽）**：`VaultManager.search()` = 确定性引擎 + FTS5 串接（`vault-manager.ts:813`）；写入单缝 writeNote → vault md + data/agent.db upsert；遗忘/回填 CLI（vault:archive/reindex）本轮已接。

**收集面（单缝）**：crawl → `KnowledgeCollector.collect()` → `store.isCollected` 去重 → `storeAsVaultNote`（vault + knowledge_sources 记账）→ 技能晋升/字典同走 store。

## 三、问题清单

| # | 级别 | 位置 | 证据 | 影响 | 处置 |
| --- | --- | --- | --- | --- | --- |
| U1 | Medium（架构） | `src/services/chat.ts:166,192` vs `src/mcp/server/kg-tools.ts:16` | chat 的知识检索走 `services/knowledge.ts` 独立管线（privacy 门 + edge 查询改写 + unifiedSearch web 回退 + vault 经 localStore 注入），**绕过 KAL**；KAL 扇出面只有 MCP 侧在用 ⇒ 同一份知识三个查询口径（KAL 归一化 / chat 管线 / kg CLI 直连） | 检索语义与排序口径分叉；KAL 的归一化与容错改进惠及不到 chat | **部分落地（2026-09-25）**：Chat 前端页整体移除（首页即 /agents 工作区）；`queryTool` 本地腿切 `vault.searchHybrid`——chat/CLI/页面统一到同一检索实现与可选语义层；chat→KAL 全量重路由仍开放（需 KnowledgeUnit 形状适配，T3） |
| U2 | Medium（架构） | `src/kal/knowledge-access-layer.ts:147-158` | KAL 扇出仅 vault/kg/dre；`knowledge_sources`/`dictionary`（collector 的记账表）不在查询面。现状可接受——爬取正文以 vault note 进检索（`storeAsVaultNote`），记账表只有 dedup/stats 读者（`store.ts:82,89,260`） | 若未来要按来源/域聚合检索，需扩 KAL 第四路 | 登记即可（语义现状自洽） |
| U3 | Low（清理） | `data/knowledge.db`（4KB，mtime 08-21） | merge 前残骸：仅 `scripts/merge-knowledge-dbs.ts:19` 以历史口径引用；KnowledgeStore 实际读 `DATABASE_PATH`=agent.db（`store.ts:14`） | 混淆"哪个库是真知识库"（本轮审计自己都被它误导过一次） | **本轮已移** `archive/side-db-2026-09-25/`（与 axiom-memory.db 同批，未删除） |
| U4 | Info（数据考古） | `data/agent.db` 表清单 | 多代表结构并存：`entities/relationships`（旧代）、`kg_edge`（历史单数）、`kg_nodes/kg_edges`（现行复数）、`knowledge_node/knowledge_revision`；KAL 对单数表有显式回退兼容（O3-F4） | 清表属数据迁移且有回退保护，暂无风险 | 登记；迁移待 KG 面整体治理时一并做 |
| U5 | Info | `knowledge-access-layer.ts:449` | getReferences 边集 `LIMIT 50`、query 结果 `LIMIT 20`（截断有界） | 高度连接节点的引用面有界 | 无需动作 |
| U6 | Info | `src/services/chat.ts:131` | 历史注释自证：原实现串行 retrieveCodeMemory → retrieveKnowledge，现并行 | 并发双检索已在 chat 缝内处理 | 无需动作 |

## 四、稳定性的两种独立验证（铁律 6）

1. **静态**：两个 SQLite 面单均 `PRAGMA journal_mode = WAL`（并发读写不互斥）；单例三件套（`getGlobalVault` / `getSqliteMemory` / `getKnowledgeStore`）经 `utils/lazy-singleton.ts`；KAL 与 store 的每个查询点都有 try/catch 或回退分支（`query():106-113`、`getReferences():438-456`）。
2. **动态**：本轮连续实跑 `vault:reindex`（183 同步 0 错）×2、`vault:search` 活体抽查、audit:runtime 16/16——索引/检索/归档在重操作后保持一致（183 = archives 44 + knowledge 122 + meta 16 + resources 1）。

两法结论一致：**运行期稳定，未发现吞错或脏读通道**。

## 五、回答用户的问题

1. **"是否统一收回到一个统一的知识库后端接口？"** —— **存储层是（单库单缝），查询接口层还不是**：DB 已合并进 data/agent.db，收集是单缝；但查询面有三条（KAL / chat 管线 / kg CLI 直连），其中设计上的统一面 KAL 目前只服务 MCP 侧。
2. **"记忆和知识库以及收集接口是否统一稳定？"** —— **收集：统一且稳定**（单缝+去重+WAL）。**记忆查询：统一且稳定**（VaultManager 单缝 + 本轮新增的 reindex/archive CLI）。**知识查询：稳定但不统一**（三面并存，U1），统一化属 T3 重路由，建议优先级排在轮 2 深审之后、由你裁决方向（chat 改走 KAL，或 retrieveKnowledge 变 KAL 前端）。
3. 记忆生长与自进化未动（按指示）。
