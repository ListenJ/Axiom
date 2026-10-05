# P2-3 — EDGE_RISK_MONITOR 默认关闭复核（2026-10-06）

> 来源：`docs/superpowers/plans/2026-09-28-architecture-refresh-and-optimization.md` P2-3。
> 问题：概率层默认关闭时，灰区风险敞口是否可接受；开启时还应配哪些开关。

## 一、当前事实

- `EDGE_RISK_MONITOR` 未设置即关闭；`isEdgeEnabled()` 只有显式 `1/true/yes` 才返回 true（`src/local-llm/edge-client.ts`）。
- 关闭的只是概率层。以下确定性防线不受开关影响：
  - `permissions.ts` / ToolRegistry HardFloor：能力声明 + 命令/路径底线，高危命令、敏感路径直接拒绝。
  - `reviewSequence()`：跨调用序列复核，捕获 burst 与 read→send / write→execute 链路，纯本地计数、不调模型。
- 概率层开启后：edge screen → decision-model review → 升级审批；edge 不可用时按能力分档：
  - `proc.exec` / `fs.write` / `fs.delete` / `cfg.write` / `db.write` / `net.outbound` 等特权能力仍要求审批；
  - 其它灰区能力默认 fail-open，只有 `EDGE_RISK_FAIL_CLOSED=1` 才一律升级。

## 二、决策

**建议：发布默认继续保持 `EDGE_RISK_MONITOR` 关闭。**

理由：

1. 当前发布形态是单机、零辅助 LLM 依赖，默认开启会引入 `EDGE_LLM_URL` 配置与本地服务可用性耦合。
2. 关闭概率层并不会关闭 HardFloor/序列复核；已知硬底线和组合放大仍有确定性兜底。
3. 默认开启但 edge 服务不可用时，非特权灰区仍可能 fail-open；这会给运维一种“已开启风险监控”的虚假安全感。
4. 只有当部署方愿意提供常驻 edge/decision 模型并接受额外延迟时，才应显式授权。

**若部署方显式开启，推荐组合：**

```bash
EDGE_RISK_MONITOR=1
EDGE_RISK_FAIL_CLOSED=1
EDGE_LLM_URL=<local-edge-endpoint>
```

- `EDGE_RISK_FAIL_CLOSED=1` 把非特权灰区的降级也升级为审批，避免“监控开启但模型宕机时静默放行”。
- 必须监控 `security.degraded_bypass` 审计事件与 `getDegradedBypassCount()`；降级持续存在时先修 edge 服务，而不是长期依赖 fail-open。
- 未配置 `EDGE_LLM_URL` 时不要先打开开关：当前实现会 fail loud，走高层兜底但不提供灰区模型结论。

## 三、实测证据

命令：

```bash
bun test \
  tests/unit/llm-default-off-policy.test.ts \
  tests/unit/risk-monitor-degraded.test.ts \
  tests/risk-monitor.test.ts \
  tests/capability-invariants.test.ts
```

结果：**101 pass / 0 fail**，覆盖：

- 未授权生产路径零边缘调用；
- HardFloor 在工具改名/包装后仍拒绝；
- `proc.exec` / `fs.write` 仍进入能力驱动复核；
- 概率层关闭时序列复核仍能升级 write→execute / read→send；
- edge degraded + 特权能力强制审批；
- `EDGE_RISK_FAIL_CLOSED=1` 时非特权灰区也强制审批。

## 四、边界与后续

- 本评估基于代码与单元/集成回归，不代表真实 edge 模型误报率/漏报率；上生产前需用目标 edge 模型跑真实 payload 集。
- 若后续内置常驻本地 edge 服务并完成误报率评估，可重新评估是否把 `EDGE_RISK_MONITOR` 默认改为开启；在完成该证据前，不建议改变默认值。
- 本报告不改变任何开关默认值，只给出运维决策口径。
