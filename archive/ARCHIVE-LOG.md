# Archive Log

## 2026-07-22 11:30 +0800

- **归档目的**：Rule 2 流程验证通过后的备份文件归档（非直接删除）。该备份为阶段四（架构优化 + GLM4.7-flash 集成）修改 `docs/operations-log.md` 前的快照。
- **原位置**：`.tmp/backups/docs/operations-log.md`
- **归档位置**：`archive/backups/docs/operations-log.md.bak`
- **备注**：operations-log.md 在追加阶段四 entry 前的完整副本，用于回滚参考。验证（137/137 测试 pass + tsc 0 错误）通过后按 Rule 4 归档。

## 2026-07-20 23:26 +0800

- **归档目的**：清理仓库根目录下游离的备份文件 `backups_tmp`，避免误提交并保持工作区整洁。
- **原位置**：`D:/openclaw-fusion/backups_tmp`
- **归档位置**：`archive/backups/backups_tmp.js`
- **备注**：该文件为 JavaScript 源码备份（CRLF 换行），原始创建时间约为 2026-07-18 18:53。内容疑似 `src/codegraph/index.ts` 的早期备份，归档后已从工作区移除。
