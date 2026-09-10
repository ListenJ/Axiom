# S-A8 切片 8 对抗样例全量拦截报告（run=r1）

## 总量（事实）
- 样例总数：31
- 拦截：31（拦截率 100.0%）
- 每例均有原因码：是

## 类别分布
| 类别 | 拦截/总数 |
|---|---|
| V1 | 3/3 |
| V2 | 3/3 |
| V3 | 3/3 |
| V4 | 3/3 |
| V5 | 3/3 |
| V6 | 3/3 |
| V7 | 3/3 |
| COMBO | 10/10 |

## 原因码分布
| 原因码 | 例数 |
|---|---|
| missing-provenance | 4 |
| dangling-entity-ref | 4 |
| type-mismatch | 5 |
| endpoint-not-declared | 3 |
| cyclic-relation | 3 |
| empty-propositions | 2 |
| empty-entities | 1 |
| not-an-object | 4 |
| unresolved-entity | 5 |

## 拦截层级分布
| 层级 | 例数 |
|---|---|
| level-1 | 26 |
| level-2 | 5 |

## 解读（判断，非事实）
- 语法级畸形（V1-V7）由级 1 fail-closed 拦截；语法合法的对抗样例（注入风格/超大 payload/超深嵌套/批量不可解析）
  由级 2 实存性校验兜底拦截（空依赖下实体/溯源锚必然不可解析）。
- 判定走 ValidationPipeline 公共接口，依赖注入空 KG/空 memory 假件，零网络零写入，同输入同结果（S-A3 重放兼容）。
- 报告生成时间：2026-09-09T13:51:04.756Z

