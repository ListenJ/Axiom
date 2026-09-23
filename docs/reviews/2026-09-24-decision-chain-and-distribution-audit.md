# 完成度审计：决策链与分发面（2026-09-24）

> 口径：每条结论都指到**能重跑的命令**或**落盘产物**。做不到的一律写在"未证"栏，不折算成成绩。
> 本轮撤回两条自己先前的结论，列在末节。

## 一、结论速览

| 目标项 | 裁定 | 证据 |
|---|---|---|
| Laya 决策 → 执行 闭环可用 | **部分一致** | 闭环成立但只在 CLI 闸上：`--spec … --run` 实测 `EXECUTED verify:typecheck`、`EXECUTED verify:runtime-audit`、`ESCALATED release:tag-and-push`。运行期派发路径**未挂钩**（见二.1） |
| 项目"没有错漏、完美运行" | **不一致** | 全量并行下 7 条逐次红（单跑全绿）；另修掉两类门自身说谎的判据（见二.2、二.3） |
| deb 64 位可分发 | **一致** | 重建到 HEAD 后容器内 `apt-get install` 成功、`/health` 200、`Depends` 字段生效 |
| rpm 64 位可分发 | **一致** | `rpm -ivh` 成功；`%files` 枚举 5 项、无裸 `/usr`（曾与 `filesystem` 包抢所有权而装不上） |
| AppImage 64 位可分发 | **一致** | `--appimage-extract` + `AppRun` 直跑，`/health` 200 |
| Windows exe 64 位 | **一致** | `axiom-cli/mcp/server.exe` 三份全部实跑：用法屏、工具注册并绑 :3001（auth fail-closed）、`/health` 200 |
| Windows exe 32 位 | **部分一致（受运行时边界约束）** | Bun 无 `bun-win32-x86`，TS 应用本体无法出 32 位；32 位只对 `runtime-go` 的 Go 服务承诺，其中 3 个已端到端实跑（含 32 位客户端打 32 位服务端） |
| macOS 不分发 | **一致** | 按用户指示排除，未构建 |

## 二、本轮实测查出并修掉的错漏

1. **Laya 链条未接入派发热路径**：`createLayaTriage` 在生产代码里只有 `src/decision/laya-cli.ts` 一个引用。两个候选挂钩点考察后排除——`src/agents/risk-monitor.ts` 的 `deps.screen` 是逐次调用的负载风险初筛，把 Laya 放上去正是本项目用实测否证过的用法（`noul` 不分离 blast radius）；`pcda-scheduler` 的 `escalate` 是负载级别切换。升级为运行期自动属 T3，待裁决。
2. **出网裁决只裁初始 URL**：`src/tools/read-tool.ts` 的 web 分支过了 `decideCapability` 却不设 `redirect: "manual"`，被禁主机可藏在一次 302 之后。改为逐跳重裁 + 跳数上限。**回归测试修前是真的红在漏洞上**：夹具模拟传输层自跳转，旧实现直接 resolve 出被拒主机的响应体；只断言"抛错"会假绿。
3. **判据自己会说谎**（两处，均已改成不可自证为真）：出网在册清单的 `redirectPerHop` 原是**自述字段**，只改 JSON 就能把预算下调到 0 ⇒ 现回扣到 AST 可见的 `redirect:"manual"` 实参，并变异测试确认它会红；符号链接越界用例的"平台红"归因是**假的**（本机 file/dir/junction 三种链接都能建成），真因是悬空夹具 ⇒ 该不变式此前在我们要发的 Windows 产物上**从未执行过**，修好后如实 DENY。
4. **发布树里躺着 46 天前的二进制**：`axiom-cli.exe` 与 `axiom-mcp.exe` 时间戳停在 2026-08-08，而 `CHECKSUMS.txt` 把三份一起列出、sha256 逐字可对 ⇒ 新增 `verify:artifacts`（新鲜度按产物家族分别取基线 + PE 位数 + 清单双向一致）。首跑即报 15 份全过期。
5. **同一个 4.0.0 产物对外自述五种版本**（`/health` 2.2.0、其 API 索引 2.9.0、启动日志 2.3.0、横幅 v4.0、`systemStatus` 2.2.0，另 CLI 向导 v2.2.0），而**全量测试一条都不红**，因为没有任何断言读过这些字段。收成 `src/version.ts` 单源 + 等值门；证据是实跑端点读到 `version = 4.0.0`。

## 三、未证 / 未做（不得折算成完成度）

- **全量并行下的 7 条红**：单跑同 4 个文件 172 pass / 0 fail ⇒ 干扰来自并发文件，但耦合对象与机制未定位；串行对照跑因我自己误用 `taskkill //F //IM bun.exe`（按映像名杀，波及并行作业）而读数作废，需重跑。CI 侧结论也不能由本机推定：`.ci/run.sh` 是容器内 `bun test`（默认 5s/用例），`ci.yml` 是 `bun test --timeout 60000`。
- **出网政策半（D-B）**：allow-list 载体未定；`decideOutbound` 的"IP 字面量永不豁免"注释与 `allowlist.includes(host)` 实现不一致；`native-routes` 越端点面与 3 个运维可写主机点仍未强制。
- **safeFs 可配根**（ADR-007 P-1/P-2/P-3）待裁决。
- Windows 侧无安装包格式，"安装/卸载冒烟"不适用；产物运行证据是**裸执行**，不能与包冒烟互替。
- LLM 重试策略（连接层失败一律可重试）未改，属单独裁决。

## 四、本轮撤回的自我结论

1. 曾把 7 条并行红笼统归为"已知负载抖动"——三次集合的包含关系显示 r1 是 r2、r3 的真子集，它们是**逐次都红**，不是抖动。
2. 曾断言"CI 恒红"——那是从本机 Windows 读数外推，两条 CI 路径的超时与平台都不同，不成立。
3. deb 的一次 FAIL 是**我自己造的**：并发跑两次冒烟、且在其安装过程中原地重打了 `.deb`。单跑即通过。

## 五、追加：`全流程 skill` 的实际作用域（2026-09-24 04:13 实测）

目标里"我们也构建了 skill 完成我们的全流程任务"这一项，落盘位置需要写清，否则会误以为它随产品分发：

- 仓库内的 `SKILL.md` 只有 **2 份**：`skills/axiom-frontend-ui-repair/`、`mcp/external/`。
- Laya 那份 `laya-local-decision-model` 在 **用户级目录** `~/.qoder/skills/laya-local-decision-model/SKILL.md`（6,350 B），**仓库内对它零引用**（`grep -rln "laya-local-decision-model"` 命中 0）。
- ⇒ 该 skill 既不在 git 历史里，也不在 deb/rpm/AppImage 的文件清单里。换机器或全新克隆会得到：决策链代码在、运行手册不在。
- 是否应把它随仓库分发属设计选择（用户级技能 vs 项目内置技能两种作用域本就不同），交裁决；本报告只登记事实，不擅自搬迁。若决定入库，需同时决定它是否进包（进包则要改 `linux-bundles` 的文件清单）。

## 六、版本刀之后的 Windows 复跑（2026-09-24 04:18）

上一节记录里我标过一处自认的落后：门控链重建了 Windows 三份产物但没再逐个实跑，而版本刀动过横幅与 CLI 字符串。已补齐：

- `axiom-cli.exe --help` → 真实用法屏（首行 `Axiom AI Agent CLI`）。
- `axiom-server.exe` → `GET /health` **200**，`version = 4.0.0`（**发出去的 Windows 二进制现在自述与包版本一致**），`checks.database = true`、`checks.vault = true`；横幅实读 `Axiom Runtime v4.0.0`。
- 收尾按映像名定向 `taskkill //F //IM axiom-server.exe //T`，`tasklist` 复查残留 **0**（不再重犯"群杀 bun.exe"那次错误：只杀自己的探测进程，且用 `tasklist` 计数确认）。

⇒ 首节表格里的 `Windows exe 64 位` 一行，证据基线已推进到含版本刀的产物。`axiom-mcp.exe` 本轮未重跑（其证据仍是 04:45 条那次：起服务、注册工具、绑 :3001、auth fail-closed）。
