# CI/CD 架构设计 —— 平台矩阵与门禁分层（T3 计划与决策请求）

- **日期**：2026-09-19
- **分支**：`codex/knowledge-unify-2026-09-17`
- **级别**：**T3**（CI/CD 基础设施 + 触发面 + 平台矩阵）
- **状态**：**设计草案，未改任何 workflow**。按总则 0.3，T3 须「书面计划 + 用户确认关键决策」后动工；第五节为待确认项。
- **来源**：用户指令（2026-09-19）——"在 CI 加一个目录，然后先设计好我们的 CI/CD 架构，完成后在开始测试"。

---

## 一、现状测绘（实测）

**配置文件**：仅 GitHub Actions 三份 —— `.github/workflows/{ci.yml,frontend-audit.yml,visual-snapshot.yml}`。
**不存在** `.gitea/`、`.woodpecker*`、`.drone*`、`.gitlab-ci.yml`（实测：全部无匹配）。

**`ci.yml` 的 7 个 job（全部 `ubuntu-latest`）**

| job | 名称 | 条件 | 门禁性质 |
|---|---|---|---|
| `test` | Test & Lint | 总是 | **阻塞**（tsc / `test:full` / `audit:runtime` / lint / E2E） |
| `dre-plugin` | DRE Plugin | 有 `if:` | 阻塞（触发时） |
| `kb-plugin` | KB Plugin | 有 `if:` | 阻塞（触发时） |
| `build` | Docker 构建推送 | **仅 push 到 main/master** | 即 **CD**（GHCR 镜像） |
| `stress-test` | Stress & Performance Gate | `needs: test` | 混合：`test:gate` 阻塞；`stress:compare \|\| true` 仅报告 |
| `security-scan` | Security Scan | `needs: test` | 混合：`bun audit` 为 `continue-on-error`；trufflehog 为门禁 |
| `deploy-smoke` | Linux Deploy Smoke | `needs: test` | 阻塞（pm2 启动+冒烟） |

**触发面**（`:3-7`）：`push` / `pull_request` **仅针对 `main, master`**。`BUN_VERSION` 固定 `1.3.14`（`:9`）。

---

## 二、缺口（本轮发现，按影响排序）

### G1（最高）触发面不含开发分支 ⇒ 本分支的 CI **根本不会跑**
`ci.yml:3-7` 只监听 `main`/`master`。当前工作分支 `codex/knowledge-unify-2026-09-17`
**既非 main/master、也没有 PR 指向 main/master** ⇒ **上述 7 个 job 一个都不会触发**。
⇒ 直接影响用户诉求：**"在 CI 加一个目录"若不修触发面，加了也不会为当前工作产出任何结果。**

### G2 零 Windows 覆盖
`ci.yml` 7 个 job **全部 `ubuntu-latest`**；全仓唯一使用 `windows-latest` 的是
`.github/workflows/visual-snapshot.yml:36,68`，且**只跑视觉快照**。
⇒ 与"目标平台含 Windows"不匹配：平台相关代码（路径分隔符、磁盘探测、文件原子重写、JSONL I/O）**无 Windows 回归**。

### G3 门禁与报告的分层不一致
同一文件里三种写法并存：阻塞（`test:full`）、`needs: test` 的串行阻塞（`deploy-smoke`）、
`|| true` 与 `continue-on-error`（stress 报告、`bun audit`）。
⇒ 后果：**"CI 绿了"到底代表什么，没有统一的读法**；同一份红绿信号既可解释为"门禁通过"也可解释为"报告生成"。

### G4 主仓库在 Gitea，但 CI 只在 GitHub
规则 3 定义的目标仓库是 Gitea（`agent/Axiom`），而 CI 配置只存在于 `.github/`。
⇒ **"代码入库"与"被验证"不在同一处**：代码进 Gitea 不会触发任何验证；只有同步到 GitHub 且在 main/master/PR 才有。

---

## 三、目标架构（分层 × 平台矩阵）

```
L1 快速门禁（每次 push，任意分支）    ← 解决 G1
    typecheck + 全量单测（当前 test:full 的子集，目标 ≤ 5 min）
    runs-on: ubuntu-latest
        │
        ▼
L2 平台矩阵（L1 通过后）              ← 解决 G2
    ┌─ linux-full   : 现有全量（单测 + E2E + runtime audit）
    └─ windows-ports: 可移植子集（见 §四）
        │
        ▼
L3 重型（仅 main/master 或标了标签）  ← 厘清 G3
    stress gate / security scan / deploy smoke / Docker 构建推送(CD)
```

**门禁分层原则**（解决 G3）：每个 job 必须在 workflow 内**显式声明**自己是
`阻塞` 还是 `仅报告`，且**报告类不得使用 `|| true` 之外的隐式放行**；建议在 job 名里直接标注
（如 `Windows Portable (report-only)`），让"绿灯含义"从名字就可读。

---

## 四、Windows job 的具体设计（待确认后实施）

**跑什么**：优先**平台相关面**，而不是把全量套件搬过去（Windows runner 更慢、更贵）。

| 目标目录/用例 | 为什么选它 |
|---|---|
| `tests/agent-evals/` | 本次改动主战场（JSONL 追加/加载、保留策略、会话贯通） |
| `tests/unit/path-containment.test.ts`、`tests/unit/filesystem.test.ts` | 路径语义在 Windows 上差异最大 |
| 后续 A3b 的 `statfsSync` 相关用例 | 磁盘探测是已知平台敏感点 |

**怎么跑**：
```yaml
windows-portable:
  name: Windows Portable (report-only)
  runs-on: windows-latest
  continue-on-error: true      # ← 初期不阻塞，见 D1
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with: { bun-version: "1.3.14" }
    - run: bun install --frozen-lockfile
    - run: bun test tests/agent-evals/ tests/unit/path-containment.test.ts tests/unit/filesystem.test.ts
      env: { NODE_ENV: test }
```
**转正路径**：连续 N 次（建议 10）全绿后再摘掉 `continue-on-error`，避免"一加就红、然后被永久忽略"。

---

## 五、待确认决策（阻塞实施）

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| **D1** | 触发面是否扩展到开发分支 | (a) 保持仅 main/master (b) 给 `push` 加 `codex/**` 等分支跑 L1 (c) 所有分支跑 L1 | **(b)**：不加这条，CI 对本仓库的日常开发**完全无效**（G1 实测） |
| **D2** | Windows job 是否阻塞 | (a) 初期 report-only，连续绿后转正 (b) 直接阻塞 | **(a)** —— 不确定 Windows 首跑是否全绿 |
| **D3** | CI 运行位置 | (a) 维持 GitHub Actions 唯一 (b) 同时在 Gitea 建 Actions (c) 迁到 Gitea | **需你定**；这决定"加目录"加在哪。现状是**代码进 Gitea、验证在 GitHub**（G4） |
| **D4** | L3 重型门禁的触发 | (a) 维持 main/master (b) 加标签/手动触发 | **(b)** 可减少长尾等待 |

---

## 六、未验证 / 未覆盖

1. **Windows 首个 job 是否会绿，我没有实测**（本机只有 Linux；见 ops log 的平台声明）。§四 的目录选择是**基于平台敏感性的判断**，不是实测结论。
2. `bun install --frozen-lockfile` 与 `bun test` 在 `windows-latest` 的**可用性未验证**。
3. Windows runner 的**耗时/额度成本未评估**。
4. L1 "≤ 5 min" 的**目标值未测量**（现有 `test:full` 实际耗时未统计）。
5. **本设计未改任何 workflow**；G1–G4 均处于"已发现、未处理"状态。
