# 外部审核测试集（External Benchmarks）

> 用于发布标准审核与后续 Agent 能力评测的**真实、权威**测试集，已拉取到工作空间备用。

## 已引入的测试集

| 测试集 | 文件 | 规模 | 类型 | 权威性 | 用途 |
| --- | --- | --- | --- | --- | --- |
| **HumanEval** | `HumanEval.jsonl` | 164 题 | 代码生成（Python 函数） | OpenAI 官方发布，代码能力事实标准 | 评测 Agent 的代码生成正确性（有 `test` 断言 + `canonical_solution` 对照） |
| **MBPP** | `mbpp.jsonl` | 974 题 | 代码生成（Python 函数） | Google Research 发布 | 代码能力补充基准（有 `test_list` + `test_setup_code`） |

## 字段说明

### HumanEval.jsonl（每行一条 JSON）
- `task_id`：任务 ID（如 `HumanEval/0`）
- `prompt`：函数签名 + docstring + 示例（Agent 需补全函数体）
- `entry_point`：被测函数名
- `canonical_solution`：标准答案（仅作对照，评测时不注入）
- `test`：测试断言代码（执行后判断通过/失败）

### mbpp.jsonl（每行一条 JSON）
- `task_id`：任务 ID（1-974）
- `text`：任务描述（英文）
- `code`：标准答案（对照）
- `test_list`：测试用例
- `test_setup_code` / `challenge_test_list`：测试前置代码 / 挑战用例

## 如何桥接到 agent-evals 框架

现有 `src/agent-evals/tasks.ts` 用「prompt + verify 函数」结构。外部测试集的桥接方式：

1. **代码类（HumanEval/MBPP）**：将 `prompt` 作为任务 prompt，`verify` 函数改为「执行 `test`/`test_list` 断言」——即把 Agent 生成的代码拼上测试用例后实际运行，通过即 pass。这是比关键词匹配更严格的真实正确性验证。

2. **知识类（MMLU）**：将题目 + 选项作为 prompt，`verify` 检查 Agent 输出选项与标准答案一致。

3. 建议在 `src/agent-evals/` 下新增 `external.ts` 适配层，用 `--external=human-eval` 等 flag 触发，与现有自建 48 任务并存。

## 尚未引入（待后续补充）

| 测试集 | 状态 | 原因 |
| --- | --- | --- |
| MMLU（57 学科知识） | 未拉取 | HuggingFace 需重定向/认证，可后续用 `datasets` 或镜像引入 |
| GAIA（Agent 工具使用） | 未拉取 | HF 下载受限；验证集含文件附件，需额外下载器 |
| SWE-bench（软件工程） | 未拉取 | 体量大（需 GitHub issue + repo 快照），建议按需引入 |

## 注意事项（遵循 AGENTS.md 规则 11）

- 本目录测试集为**公开基准数据**，不含任何密钥/凭据。
- 是否加入 git 版本控制需按仓库策略决策（`.gitignore` 或归档分支），避免污染主分支。
