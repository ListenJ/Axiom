# R6① 点名测试路径静默失效 —— 证据与断言面（2026-09-22）

> **摘要**：本件记录 `bun test` 混点无效路径时"静默丢文件且退出码 0"这一实测形态、
> 为守住它而落地的断言（`tests/test-full-script.test.ts`）、断言面的全量清点、
> 用例守恒证明，以及本判据**覆盖不到**的边界。业务留痕见
> [操作日志](../operations-log.md) 的 `2026-09-22 20:52` 条目。
> 结论分级：`事实` = 有命令与输出可复跑；`判断` = 我的取舍；`推测` = 证据不足。

## 1. 缺陷形态（事实，5 个探针，bun 1.4.2 / 744846f84）

承重测量方法：**无管道直取退出码**（`cmd > log 2>&1; echo $?`）。首轮曾用
`cmd | tail; echo ${PIPESTATUS[0]}`，与直取结果矛盾（`-t` 探针读到 0、直取读到 1），
故弃用管道法，下表全部为直取值。

| 探针 | 命令（在仓库根执行） | 退出码 | 输出是否提及缺失路径 | 判定 |
|---|---|---|---|---|
| A | `bun test tests/does-not-exist-xyz.test.ts` | 1 | 提及（并提示 filter/path 用法） | 响亮 |
| B | `bun test ./tests/does-not-exist-xyz.test.ts` | 1 | 提及（`Test filter … had no matches`） | 响亮 |
| C | `bun test ./tests/doc-contract.test.ts ./tests/does-not-exist-xyz.test.ts` | **0** | **零次**（末行 `Ran 35 tests across 1 file.`） | **静默吞** |
| D | 同 C，去掉全部 `./` 前缀（裸形） | **0** | **零次** | **静默吞** |
| E | `bun test tests/doc-contract.test.ts -t "不存在的选择器xyz"` | 1 | 提及（`matched 0 tests`） | 响亮 |

⇒ 风险面收敛为一条：**无效路径与有效路径混点时**才会静默丢弃。仓库内落在该形状里的
只有 `test:core`（一条脚本点名 11 个文件）。单独点错（A/B）与选择器打错（E）本身已 fail-closed。

## 2. 落地的断言（事实）

位置：`tests/test-full-script.test.ts`（该文件由 `test:full` 的收集器自动发现，不靠点名，
故不会被子机制吞掉 —— 这是选它而不选新建测试文件的理由，属`判断`）。

- `extractNamedPaths(cmd)`：只对含 `bun test` 的脚本生效；剥 `./`；跳过以 `-` 开头的参数；
  收 `tests` 目录与 `tests/*` 文件两种形态。
- `findMissing(paths, exists)`：存在性判定函数**作参数注入**，故判据可在合成数据上自检。
- 三条用例：① 判据自检（合成 typo 必红、存在者不误伤、flag 与收集器脚本不参判）；
  ② 真实 `package.json` 点名路径存在性 + "抽取非空"反恒绿哨兵；
  ③ 往真实脚本注入一条 typo ⇒ 端到端判红且逐条点名。

红→绿记录（事实）：移除判据函数 → `ReferenceError: findMissing is not defined`（红因正确）；
首版抽取漏掉 `./tests` 目录形态，被自检用例当场判红 ⇒ **修实现、未回改期望数字**。

## 3. 断言面全量清点（事实，非抽样）

从 `package.json` 派生，不手抄清单：脚本共 **87** 条，其中 **8** 条点名 `bun test` 路径，
合计 **18** 个参数实例（**17** 个 `.test.ts` + **1** 个 `tests` 目录），去重后 **18**，
存在性缺失 **0**。逐条分布：`test`(1) · `test:core`(11) · `test:arch`(1) · `test:docs`(1) ·
`test:perf`(1) · `test:stress`(1) · `test:gate`(1) · `test:integration`(1)。

## 4. 守恒证明与门结果（事实）

- 全量：`bun run test:full` ⇒ collected **408** 文件、**4132 pass / 36 skip / 1 fail**、
  4169 tests / 130636 expects / 132.50s，`test:full` 自身 **EXIT=1**。
- 唯一红 = 既存环境件 `OCR Engine > should get engine with default config`
  （`src/ocr/engine.ts` 的 `assertLangsAvailable` 因本机缺 tessdata 抛错），
  R5-g / F-2 / R3-① 各片同条，本片不碰 OCR 路径 ⇒ 不归因于本片（`判断`，依据是本片改动面仅一个测试文件）。
- **计数守恒**（防把口径差读成回退）：早前记录里的 414 文件出自 `bun test --parallel=8 ./tests`
  （由 bun 自收），本片的 408 出自 `test:full`（排除 `stress`/`e2e` 目录与 `*.slow.ts`）。
  机器证明 `408 + tests/stress 下 6 件 = 414` ✓，6 件为
  `audit-regression-stress` / `boundary-extreme` / `extreme-stress` / `high-intensity-load` /
  `multi-agent-stress` / `perf-gate`。
- 其余门：`bun run test:docs` 35/0、`bun run test:arch` 25/0、`bun run lint`（`tsc --noEmit`）exit 0、
  本测试文件 5/0。
- 外层噪声（事实）：后台任务的完成通知报 `exit code 0`，那是包装 shell 末命令 `tail` 的码，
  与套件自身的 `exited with code 1` 不一致 ⇒ 退出码一律以无管道直取 + 日志行为准。

## 5. 本判据覆盖不到的（边界，如实声明）

1. 红点出现在**下一次全量套件 / CI**，不覆盖"打错当次的终端调用不报错"。要做到后者需引入
   包装器改门接线（设计与被否理由见操作日志同条目），属范围扩张，本片按最小化原则不做。
2. 不覆盖 `bun test` 子串过滤的**过度匹配**（多跑文件）——那是加量而非吞量。
3. 若将来某脚本用 `-t "…tests/…"` 传带引号的选择器，按空白切分会误抽出该 token；
   现存 87 条脚本零使用 ⇒ 登记不修。
4. 不裁决"摆动性能断言"与 OCR 环境红是否进 `scripts/test-full.ts` 的 `EXCLUDE_FILES` 账本；
   阈值、并发、账本本片一律未动。

## 6. 复现命令

```sh
# 静默吞（C/D）
bun test ./tests/doc-contract.test.ts ./tests/does-not-exist-xyz.test.ts > /tmp/c.log 2>&1; echo $?
grep -c does-not-exist /tmp/c.log          # ⇒ 0：输出里查无此路径
# 判据能红（不改动仓库：用等价合成数据）
bun test --isolate ./tests/test-full-script.test.ts
# 断言面清点
bun -e 'import {readFileSync} from "node:fs";const s=JSON.parse(readFileSync("package.json","utf8")).scripts;const ex=c=>!c.includes("bun test")?[]:c.split(/\s+/).map(a=>a.replace(/^\.\//,"")).filter(a=>!a.startsWith("-")&&(a==="tests"||a.startsWith("tests/")));console.log(Object.values(s).flatMap(ex).length)'
```
