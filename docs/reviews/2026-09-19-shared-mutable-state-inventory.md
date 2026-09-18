# 共享可变状态盘点：无保护读改写（RMW）全量清单与并发强化（2026-09-19）

> **摘要**：对 `src/**` 全量扫描「同一方法内 **先读某字段 → `await` → 再写该字段**」的候选，
> 得到 **33 处 / 22 文件**；逐条做执行序人工裁定后：**✅ 已正确（同步认领/单飞）18 处**、
> **🟡 良性（重复工作但结果相同）4 处**、**🔴 真缺陷 10 处**（本轮**已修 3 处**，余 **7 处**登记为后续）、
> **❓ 未验证 1 处**。（18+4+10+1 = 33，与下表逐行列数一致。）
> 判据与结论均给 `文件:行号` 证据；**不接受"抽查代表整体"**。

---

## 0. 判据与方法（先说清什么算缺陷）

单线程 JS 里**没有 `await` 就没有交错窗口**。因此缺陷的必要条件是：

> 同一逻辑操作内，**共享字段的读**与**基于该读的写**之间存在 `await`（或回调边界）。

两类真缺陷由此产生：

| 类型 | 形态 | 后果 |
| --- | --- | --- |
| **A. 单飞承诺未同步发布** | `if (flag) return; ... await ...; flag = true` | 并发调用**重复执行**副作用（重复初始化 / 重复创建资源 / 重复销毁） |
| **B. 先检查后动作（TOCTOU）** | `if (map.has(k)) ... await ...; map.set(k, v)` | 并发调用**双双通过检查**，后写覆盖或重复执行 |

**扫描器（启发式）与其已知局限**（必须声明，否则结论会强于证据）：
1. 扫描器按**行序**取"首个 `await`"与"首个写"，无法识别**闭包内的 await**（如 `const task = (async () => { await ... })(); this.inFlight.set(...)` 中，发布实际发生在 await **之前**）。因此它会 **误报**已正确实现。
2. 它只找**同名字段**，不追踪别名/解构；跨方法、跨对象的共享（如 `Map` 值传给外部）**不在覆盖内**。
3. 因此：**扫描器只用于生成候选，裁定必须逐条人工执行序分析**（下表即是）。本节所有 ✅ 结论均为人工复核后的结论，若将来改回启发式判断会与本表冲突。

---

## 1. 全量清单（33 处 / 22 文件，逐条裁定）

| # | 文件 | 方法 | 字段 | 裁定 | 依据 |
| --- | --- | --- | --- | --- | --- |
| 1 | `src/utils/cache.ts` | `get()` | `store` | 🟡 良性 | `:114` 读 → `:131 await redis` → `:135 set`：并发未命中会重复回填**同一个值**（缓存惊群），结果不变 |
| 2 | `src/utils/cache.ts` | `get()` | `hitCount`/`missCount` | 🟡 良性 | `:118`/`:123`/`:142`/`:160` 均为 `++`（表达式内无 await ⇒ 原子），仅计数抖动 |
| 3 | `src/terminal/command-gate.ts` | `write()` | `inflight` | ✅ 已正确 | `:113` 读 → `:117 this.inflight += accepted.length`（**同步**，`write()` 到 `return task` 之间无 await）→ `:125` finally 释放 |
| 4 | `src/terminal/command-gate.ts` | `write()` | `chain` | ✅ 已正确 | `:119 const task = this.chain.then(...)` → `:128 this.chain = task.then(...)`：**同步赋值**，与本次推广的原子链同构 |
| 5 | `src/terminal/command-gate.ts` | `handleItem()` | `pendingApprovals` | ✅ 已正确 | `:203 += 1` 在 `:205 await` 之前（同步认领）→ `:219` finally `-= 1` |
| 6 | `src/core/health-checker.ts` | `checkApiKeys/Database/Redis` | `results` | 🟡 良性 | `:111/145/212` 与 `:124/157/221` 均为数组 **push**，非读改写 |
| 7 | `src/plugins/plugin-registry.ts` | `install()` | `plugins` | 🔴 **A/B 真缺陷（未修）** | `:276 has()` 检查 → `:295 await removeDirectory/copyDirectory` → `:311 set()`：并发同 id 安装双双通过检查 |
| 8 | `src/plugins/plugin-registry.ts` | `uninstall()` | `plugins` | 🔴 **B 真缺陷（未修）** | `:325 get()` → `:332 await` 删目录 → `:342 delete()`：并发卸载重复删同一目录 |
| 9 | `src/plugins/plugin-registry.ts` | `disablePlugin()` | `activeModules` | 🔴 **B 真缺陷（未修）** | `:453 get()` → `:456 await` 卸载 → `:468 delete()`：并发 disable 重复卸载同一模块 |
| 10 | `src/memory/enhanced-watcher.ts` | `processBatch()` | `isProcessingBatch` | ✅ 已正确 | `:349` 检查与 `:352 = true` 同同步块；`:413` finally 释放 |
| 11 | `src/memory/enhanced-watcher.ts` | `processBatch()` | `currentBatch` | ✅ 已正确 | `:356` 同步赋值 |
| 12 | **`src/components/kernel.ts`** | `init()` | `initialized` | 🔴→**✅ 已修（本轮）** | 原 `:54 has()` → `:67 await` → `:71 add()`：并发 + 共享依赖均重复初始化。已加 `inFlight` 同步发布（`:57`/`:75`） |
| 13 | `src/dre/actor/system.ts` | `unregister()` | `actors` | 🔴→**✅ 已修（本轮）** | 原 `get()` → `await destroy()` → `delete()`：并发 unregister / 与 shutdown 并发 ⇒ `cleanup()` 跑两次。已改为 **await 之前同步摘除** |
| 14 | `src/dre/actor/system.ts` | `processNext()` | `processing` | ✅ 已正确 | `:139` 检查与 `:140 = true` 同同步块（单飞）；`:170` finally 释放并递归排空 |
| 15 | `src/dre/actor/system.ts` | `shutdown()` | `actors` | ✅ 已正确 | `:417` 先快照 `entries()` 再逐个销毁，`:430` 最后 `clear()` |
| 16 | **`src/ocr/engine.ts`** | `initialize()` | `worker` | 🔴→**✅ 已修（本轮）** | 原 `if (worker) return` → `await createWorker` → 赋值：并发创建**两个 worker**，第二个覆盖第一个 ⇒ **第一个永不 terminate（句柄/内存泄漏）**。已加 `initializing` 同步发布 + 复用 |
| 17 | `src/pi-agent/pi-code-tools.ts` | `ensureInitialized()` | `initialized` | 🔴 **A 真缺陷（未修）** | `:42 if (initialized) return` → `:46 await import(...)` → `:55 = true`：无在途守卫，并发重复 import + 重复 `tools.set`（结果幂等，故 Low） |
| 18 | `src/memory/file-watcher.ts` | `runCodegraphIndex()` | `cgIndexing` | ✅ 已正确 | `:192` 检查与 `:193 = true` 同同步块 |
| 19 | `src/utils/read-optimizer.ts` | `tryBatch()` | `batchQueues` | ✅ 已正确 | `:494 get()` 与 `:550 set()` 虽分行，但 set 位于 `new Promise(executor)` 内**同步执行**（executor 不会被打断） |
| 20 | `src/utils/vault-stats-cache.ts` | `_refresh()` | `_refreshing` | ✅ **已正确（范本）** | `:110 if (this._refreshing) return this._refreshing` + 立即把 IIFE 承诺赋给 `_refreshing`：**同步发布在途承诺**，本次推广即以此为准 |
| 21 | `src/utils/logger.ts` | `rotateIfNeeded()` | `currentSize` | 🔴 **A 真缺陷（未修，Low）** | `:92` 判定需轮转 → `:100 await` 等待 stream close → `:114 = 0`：无 `rotating` 守卫，并发调用可重复轮转同一文件 |
| 22 | `src/launcher.ts` | `preload()` | `hooksLoaded` | 🔴 **A 真缺陷（未修，Low）** | `:129` 检查 → `:136 await` 预热 → `:149 = true`：无在途守卫，重复预热（重复网络/磁盘工作） |
| 23 | `src/components/token-budget.ts` | `compress()` | `lastReport` | 🟡 良性 | `:105`/`:185` 报告字段后写覆盖，无正确性影响 |
| 24 | `src/knowledge/auto-updater.ts` | `runUpdate()` | `running` | ✅ 已正确 | `:104` 检查后立刻 `:109 = true`（同同步块）→ `:131` finally 释放 |
| 25 | `src/dre/pipeline/cognitive-pipeline.ts` | `run()` | `lockWaiters` | ✅ 已正确 | `:186 ++` 在 `:187 await acquireGate()` 之前（同步认领）；上一轮方案A 修复 |
| 26 | `src/dre/pipeline/task-graph.ts` | `executeAll()` | `_status` | ✅ 已正确（有保留） | `:191` 检查与后续 `:239` 状态迁移之间虽有 await，但同步段内不重复启动同一任务；**并发重复调用 executeAll() 不在门内**（无互斥，属未验证面） |
| 27 | `src/dre/kernel.ts` | `tick()` | `_state` | ❓ 未验证 | `:85` 读 → `:104 await actors.ask` → `:142` 写回。`startTickLoop()` 是 `while + await` **串行**驱动，故自动路径无重叠；但 `tick()` 是 public，**外部并发调用的可达性未核验**，故不判定为缺陷 |
| 28 | `src/mcp/tool-registry.ts` | `add()` | `tools` | ✅ 已正确 | `:123 some()` 检查与 `:137 push()` 同同步块（中间无 await；扫描器命中的 await 位于被包装的 handler 闭包内） |
| 29 | `src/agents/consciousness/reflection-loop.ts` | `runOnce()` | `running` | ✅ 已正确 | `:50` 检查 → `:54 = true` 同同步块 → `:193` finally 释放 |
| 30 | `src/crawl/search-engines.ts` | `resolveInstance()` | `resolvedInstance` | 🔴 **A 真缺陷（未修，Low）** | `:385 if (resolvedInstance) return` → `:391 await import(config)` → `:394 = configured`：并发重复解析（最终值相同，故 Low） |
| 31 | `src/memory/enhanced-watcher.ts` | `processBatch()` | `currentBatch` | ✅ 见 #11 | 同一处 |
| 32 | `src/dre/actor/system.ts` | `unregister()` | — | ✅ 已修（同 #13） | 修复后已从候选消失 |
| 33 | `src/components/kernel.ts` | `init()` | `inFlight` | ✅ 已修（同 #12） | 新增字段，见 #12 |

> 表中 #31–33 为扫描器对同文件同方法的重复计数，保留以保证"分母可追溯"（33 处全部有条目）。

---

## 2. 本轮已修的 3 处（TDD 红→绿）

| 文件 | 缺陷 | 修法（统一为"**在 await 之前同步认领/发布**"） | 红→绿证据 |
| --- | --- | --- | --- |
| `src/ocr/engine.ts` | 并发 `initialize()` 创建 2 个 worker，第一个永不 `terminate` ⇒ **句柄/内存泄漏** | 新增 `initializing` 承诺，**读与写之间无 await** ⇒ 同步发布；后到者复用。另：`terminate()` 先等在途初始化落地（否则 `reinitialize()` 语言切换静默失效） | `tests/ocr-engine-single-flight.test.ts`：修复前 **0 pass / 3 fail**，修复后 **3 pass** |
| `src/components/kernel.ts` | 并发 `init(sameId)` 双双通过 `initialized.has()` ⇒ **组件被启动两次**；共享依赖同样双启 | 新增 `inFlight: Map<id, Promise>`，在任何 await 之前同步发布；后到者 `return existing` | `tests/components/kernel.test.ts`：修复前 **3 pass / 2 fail**（`Expected: 1 / Received: 2`），修复后 **5 pass** |
| `src/dre/actor/system.ts` | `unregister()` 在 `await destroy()` 之后才 `delete()` ⇒ 并发 unregister / 与 `shutdown()` 并发时 **`cleanup()` 跑两次** | 把 `this.actors.delete(id)` 移到 `await` **之前**（原子认领）；语义取舍：destroy 抛错时不再回填注册表（半销毁 actor 留在注册表比"已摘除"更危险），已在代码注释写明 | `tests/dre-actor-lifecycle.test.ts`：修复前 **1 pass / 2 fail**，修复后 **3 pass** |

**测试接缝说明（规则 8）**：`OCREngine` 新增可选构造参数 `workerFactory`（默认即 `createWorker`）。
这是**依赖注入接缝**而非投机抽象 —— 它已有第二个实现（测试 fake），并避免了 `mock.module("tesseract.js")` 污染同进程其它用例的问题。

---

## 3. 后续待修（按影响排序，本轮**未修**，属"不做项"）

| 优先级 | 文件:行号 | 缺陷 | 建议做法 |
| --- | --- | --- | --- |
| Medium | `src/plugins/plugin-registry.ts:276,325,453` | install/uninstall/disable 三处 TOCTOU | 引入 `installing/uninstalling` 在途集合，**同步认领**后再进入 await 段 |
| Low | `src/pi-agent/pi-code-tools.ts:42` | `ensureInitialized` 无在途守卫 | 同 `OCREngine`：发布在途承诺 |
| Low | `src/crawl/search-engines.ts:385` | `resolveInstance` 无在途守卫 | 同上 |
| Low | `src/launcher.ts:129` | `preload` 无在途守卫（重复预热） | 同上 |
| Low | `src/utils/logger.ts:92` | `rotateIfNeeded` 无 `rotating` 守卫 | 同步置位 `rotating`，finally 复位 |

> 统一修法只有两条：**A. 同步发布在途承诺**（`vault-stats-cache._refresh` 是范本）；**B. await 之前同步认领**（本轮 `unregister` 是范本）。

---

## 4. 未覆盖 / 无法验证项（如实登记）

1. **扫描器覆盖边界**：只匹配「同一方法内、同名字段、行序首写首 await」。以下**不在覆盖内** ——
   跨方法/跨对象共享、通过闭包或参数传递的共享状态、`Map`/`Set` 的值对象内部可变性、Worker/线程间共享、跨进程状态。
2. **`src/dre/kernel.ts:tick()`（#27）未验证**：`startTickLoop()` 的自动驱动是 `while + await` 串行，**无重叠**；
   但 `tick()` 为 public API，**外部并发调用是否可达未核验**，因此**不判定为缺陷**。
3. **`src/dre/pipeline/task-graph.ts:executeAll()`（#26）有保留**：并发**重复调用** `executeAll()` 不受互斥保护；
   现有调用方是否可能并发重复调用**未核验**。
4. **未做并发压测**：本轮全部结论来自静态执行序分析 + 单测，**没有**做 N=100+ 并发下的延迟/正确性压测。
5. **本轮未处理进程内其它形态**：如 `EventEmitter` 监听器竞态、`setTimeout` 重入、`Promise.all` 内共享数组写入等，均不在本次扫描面内。

---

## 5. 结论

- 本次盘点的**分母完整**：`src/**` 全量 .ts 扫描 → 33 处候选 → 22 文件 → **逐条裁定，无遗漏行**。
- **真缺陷 10 处**（#7/8/9/12/13/16/17/21/22/30），本轮修掉影响最大的 3 处
  （worker 泄漏、组件双启、actor 双销毁），其中 `OCREngine` 一处是**真实资源泄漏**，另两处是**重复副作用**。
- 值得注意的正面结论：`src/terminal/command-gate.ts`（审批闸门，安全关键）与
  `src/utils/vault-stats-cache.ts` **已经是原子实现**，无需改动 —— 本次推广的模式在本仓库**已有先例**。
