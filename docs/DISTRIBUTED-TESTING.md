# 分布式测试框架

三节点集群 PCDA 自动化测试框架，用于验证 Agent 系统在高并发分布式环境下的稳定性与可靠性。

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    PCDA Scheduler                           │
│  Plan → Do → Check → Act → (循环升级/降级)                  │
└────────────────────────┬────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │ Local Node  │ │ Node-150    │ │ Node-021    │
  │ (开发机)     │ │ (服务器)    │ │ (远程节点)  │
  │             │ │             │ │             │
  │ maxConc: 8  │ │ maxConc: 16 │ │ maxConc: 12 │
  └─────────────┘ └─────────────┘ └─────────────┘
         │               │               │
         ▼               ▼               ▼
  ┌─────────────────────────────────────────┐
  │         测试场景执行器                   │
  │  ┌──────────┐ ┌──────────┐ ┌─────────┐ │
  │  │幻觉检测  │ │串词检测  │ │并发负载 │ │
  │  └──────────┘ └──────────┘ └─────────┘ │
  └─────────────────────────────────────────┘
```

## 集群节点

| 节点 ID    | 名称                      | 类型   | 地址             | SSH 用户 | 最大并发 |
|-----------|--------------------------|--------|-----------------|---------|---------|
| local     | Local Dev Machine        | 本地   | -               | -       | 8       |
| node-150  | Server ${LAN_NODE_N1}     | 远程   | ${LAN_NODE_N1}   | data    | 16      |
| node-021  | Remote Node 192.168.0.21 | 远程   | 192.168.0.21    | git     | 12      |

## PCDA 循环

### Plan（计划）
根据当前负载级别和场景列表，为每个「场景 × 节点」组合生成测试任务。

### Do（执行）
通过 `ClusterCoordinator` 将任务分发到各节点：
- **本地节点**：直接调用场景执行器
- **远程节点**：通过 SSH 执行远程命令

### Check（检查）
收集所有节点的测试结果，聚合指标并检测问题：
- 幻觉率是否超过阈值
- 串词率是否超过阈值
- P95 响应时间是否超过预期
- 错误率是否超过阈值
- 节点是否离线或超时

### Act（决策）
根据检测结果决定下一步操作：

| 决策       | 触发条件                          | 行为                    |
|-----------|----------------------------------|------------------------|
| escalate  | 当前级别全部通过 + 未达最高级别    | 升级到下一负载级别       |
| pass      | 最高级别全部通过                   | 测试通过，结束           |
| retry     | 中等问题 + 循环次数 > 2           | 同级别重试              |
| degrade   | 高严重度问题                       | 降级到上一负载级别       |
| fail      | 严重问题                          | 测试失败，终止           |
| abort     | 降级到最低级别仍有高严重度问题      | 需人工干预              |

## 负载级别

| 级别 | 名称     | 并发/节点 | 请求/用户 | P95阈值 | 幻觉阈值 | 串词阈值 |
|-----|---------|----------|----------|---------|---------|---------|
| 1   | warmup  | 2        | 5        | 100ms   | 0%      | 0%      |
| 2   | normal  | 5        | 10       | 50ms    | 5%      | 2%      |
| 3   | high    | 10       | 20       | 30ms    | 10%     | 5%      |
| 4   | extreme | 20       | 50       | 20ms    | 15%     | 10%     |

## 测试场景

### 幻觉检测（hallucination）
多用户并发发送查询，验证 LLM 响应中是否存在幻觉：
- 每个用户从事实库中选取一条事实，构造问题
- 模拟 LLM 响应（可配置幻觉率）
- 使用 Jaccard 相似度检测响应与已知事实的匹配度
- 低于阈值（默认 0.3）的响应被标记为幻觉

### 串词检测（cross-talk）
多会话并发对话，验证会话间无状态泄漏：
- 每个会话分配唯一 secret token
- 消息中包含本会话的 secret
- 检查响应中是否包含其他会话的 secret
- 任何跨会话的 secret 泄漏即为串词违规

### 并发负载（concurrent-load）
基线性能测试，测量吞吐量和响应时间：
- N 个并发 worker × M 个请求/worker
- 可配置模拟延迟和失败率
- 计算 P50/P95/P99 响应时间和吞吐量

## 快速开始

### 1. 仅本地测试（无需 SSH）

```bash
bun run scripts/distributed-test-runner.ts --local-only --max-cycles 2
```

### 2. 检查 SSH 连通性

```bash
bun run scripts/distributed-test-runner.ts --check-ssh
```

### 3. 完整三节点分布式测试

```bash
bun run scripts/distributed-test-runner.ts \
  --scenarios hallucination,cross-talk,concurrent-load \
  --max-cycles 4 \
  --start-level 1
```

### 4. 仅测试特定场景

```bash
bun run scripts/distributed-test-runner.ts --local-only --scenarios cross-talk
```

### 5. 运行单元测试

```bash
bun test tests/distributed/
```

## 模块结构

```
src/testing/
├── cluster/
│   ├── types.ts           # 集群类型定义（节点/任务/结果/配置）
│   ├── ssh-executor.ts    # SSH 命令执行器（基于 child_process）
│   ├── node.ts            # 测试节点抽象（Local + Remote）
│   └── coordinator.ts     # 集群协调器（任务分发 + 结果收集）
├── scenarios/
│   ├── concurrent-load.ts # 并发负载场景
│   ├── hallucination-test.ts # 幻觉检测场景
│   └── cross-talk-test.ts # 串词检测场景
├── scheduler/
│   ├── types.ts           # PCDA 类型定义
│   └── pcda-scheduler.ts  # PCDA 循环调度器
├── metrics/
│   ├── collector.ts       # 指标收集器
│   └── reporter.ts        # 报告生成器（Markdown/JSON/HTML）
└── index.ts               # 模块入口

tests/distributed/
├── cluster-test.test.ts          # 集群 + 场景单元测试
└── pcda-scheduler-test.test.ts   # PCDA 调度器单元测试

scripts/
└── distributed-test-runner.ts    # 分布式测试运行入口
```

## SSH 配置

远程节点通过系统 `ssh` 命令连接，需提前配置 SSH 密钥认证：

```bash
# 生成密钥（如已有可跳过）
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519

# 复制公钥到远程节点
ssh-copy-id data@${LAN_NODE_N1}
ssh-copy-id git@192.168.0.21

# 验证连接
ssh data@${LAN_NODE_N1} echo ok
ssh git@192.168.0.21 echo ok
```

SSH 执行器使用以下选项避免交互式提示：
```
-o StrictHostKeyChecking=no -o ConnectTimeout=10
```

## 报告

测试完成后自动生成两种格式的报告：

### Markdown 报告
包含：执行摘要、逐循环结果、分节点指标、问题列表、改进建议。

### JSON 报告
机器可读格式，包含所有 PCDA 循环的完整数据，可用于 CI/CD 集成。

报告默认保存到 `reports/` 目录。

## 性能指标

每次测试记录以下指标：

| 指标              | 说明                          |
|------------------|------------------------------|
| totalRequests    | 总请求数（所有节点之和）        |
| avgResponseMs    | 平均响应时间                   |
| p50ResponseMs    | P50 响应时间                   |
| p95ResponseMs    | P95 响应时间                   |
| p99ResponseMs    | P99 响应时间                   |
| throughput       | 吞吐量（req/s）                |
| hallucinationRate| 幻觉率（0-1）                  |
| crossTalkRate    | 串词率（0-1）                  |
| errorRate        | 错误率（0-1）                  |

## CI/CD 集成

```yaml
# .github/workflows/ci.yml 示例
- name: Run distributed tests
  run: bun run scripts/distributed-test-runner.ts --local-only --max-cycles 2
```

远程节点测试需在 CI 环境中配置 SSH 密钥。
