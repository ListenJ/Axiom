# 轮 3 深审：dre/ 系统性采样（模块 2/7）+ MCP 工具层（模块 3）（2026-09-25）

> 承接轮 2（`2026-09-25-audit-round2.md`）。本轮两段：①dre/ 目录（50 文件 18,643 行，目录内零测试文件——测试在 tests/ 侧）做**编排核心精读 + 全目录系统扫描**；②MCP 工具层注册表与高风险面。记忆生长与自进化未动。

## 一、dre/ 系统性采样（模块 2 编排 / 模块 7 确定性）

### 2.1 编排核心精读（`src/dre/engine.ts` 960L）

| # | 级别 | 位置 | 证据与描述 |
| --- | --- | --- | --- |
| D1 | Info | `engine.ts:199-201,305-309` | Actor 初始化失败 ⇒ warn 后 `_readyResolve()` 照常放行——**fail-open 就绪门**。与 main.ts:149 "DRE 是增强能力，失败不阻断主服务"的既定口径一致，非缺陷 |
| D2 | Info | `engine.ts:201-204` | DREngine 在宿主模式下与主库/SqliteBackend 形成三个同库连接；DREngine 自身连接未显式设 WAL——继承库文件持久化 WAL 属性（data/agent.db 已 WAL），新库首连存在短暂默认 journal 窗口（Info 级时序面） |
| D3 | Info | `engine.ts:771-803` | reflection 经 EventEmitter fire-and-forget 写知识——**有 .catch() 落 warn**（注释自证"EventEmitter does not await listeners"），无静默吞错 |

### 2.2 全目录扫描（50 文件）

| 检查 | 结果 |
| --- | --- |
| 模块 2：失败子任务面 | `actor/system.ts:297-312` ask() 带 5000ms 超时（Promise.race reject）；`:404-420` shutdown 逐 actor 销毁超时；**无重试**（ask 为单发查询，超时即报错交上层） |
| 模块 2：死锁 | ask 全部带超时 ⇒ 无无限互等；未发现循环 ask 链 |
| 模块 7：Math.random | 全目录 8 处命中**全部为消息/规则 ID 生成**（actor msg-id、mental-model rule-id）——身份标识而非决策/排序内容，不影响推理确定性 |
| 模块 7：决策路径 | 推理由 rule-engine（规则）+ LLMClient（temperature=0 + 缓存，见轮 2 模块 8 裁定）驱动；未发现时间戳/遍历序参与排序的决策点 |

### 2.3 constraint/solver.ts（649L）——本轮未全文精读，如实标注

仅结构扫描（预注册 GPU/策略/时间约束组，`engine.ts:247-249` registerAll）。列入轮 4。

## 二、MCP 工具层（模块 3）

| # | 级别 | 位置 | 证据与描述 |
| --- | --- | --- | --- |
| T1 | Info | `mcp/tool-registry.ts:144-175` | 注册表四重护栏：①能力强制声明（空 capability 直接抛错，I1/S3）②声明必须可裁决（payloadFields 检查，S-8）③同名注册 warn+跳过（幂等，L4 修复史）④handler 自动包 guard（先复核后执行） |
| T2 | **部分一致** | `mcp/server.ts` / `MCP_TOOLS_GUIDE.md` | 审计清单的"懒加载"声称：未找到 lazy 字样的实现——**注册为启动期 eager**（189 工具一次性 add），按需性由 `tool-registry.ts:292` 的 exposure 过滤承载（按客户端 allow-set 裁剪可见工具清单，控制 token 面拓宽）。"懒加载=延迟注册"字面不成立；"按需可见面"存在。如实记为部分一致 |
| T3 | Info | `src/tools/write-tool.ts` | 写入单缝（写类工具单一实现）；文件删除经 /chat API 的会话删除（两段式 confirmationId，`main.ts` 侧 endpoints.chat.deleteSession 403 流程）——非裸 rm 面 |
| T4 | Info | `src/utils/auth-check.ts:127-200`（轮 2 已核） | 高风险网络/敏感 GET 面有 DNS 重绑定 + GET 旁路 + CSWSH 三轮加固史（J-2/Task2/I5/S2 修复注释） |

## 三、覆盖率账本（累计）

| 段 | 本轮新增 | 累计深读 |
| --- | --- | --- |
| dre | engine.ts(960L 精读) + actor/system.ts(结构化) + 50 文件系统扫描 | dre 段系统性覆盖 |
| mcp | tool-registry.ts(302L) + 高风险面清单 | 1 新增 |
| **深审覆盖率** | core 891 分母 | **约 2.8%**（2.4%→2.8%）；dre/ 段以"核心精读+全目录扫描"口径计为系统覆盖 |

**仍未深审**：constraint/solver.ts(649L)、retrieval/deterministic-retrieval-engine.ts(848L)、runtime/ 其余、model-router.ts(1180L)、routes/ 36、agents/ 39、utils/ 51 等。机械化通道维持 100%。

## 四、轮 4 计划

1. constraint/solver.ts + deterministic-retrieval-engine.ts 全文（模块 7 剩余核心）；
2. model-router.ts（1180L）全文 + thompson-router；
3. routes/ 36 文件（HTTP 面输入校验清单，模块 10）；
4. F7 残余 4 红二分（需 8×4min 串行窗口）。
