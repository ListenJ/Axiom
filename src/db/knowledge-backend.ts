/**
 * KnowledgeBackend —— 四个知识库子面的**单数据库后端**（ADR-010 收拢点）。
 *
 * 一个连接（data/agent.db，WAL）之上的四个**解耦**子面，按需懒构造：
 *   .memory → SQLiteMemory            记忆 FTS5 索引 + searchHybrid（可选语义层）
 *   .store  → KnowledgeStore          knowledge_sources/dictionary 收集记账
 *   .kg     → KnowledgeGraphEnhanced  图谱（节点/边/统计）
 *   .kal    → KnowledgeAccessLayer    vault/kg/dre 统一查询扇出（零 LLM）
 *
 * 边界说明：
 * - VaultManager（拥有 vault md 文件、file-watcher、确定性引擎的生命周期）仍独立持有
 *   自己的 SQLiteMemory 连接——同库不同连接在 WAL 下并发安全（两侧都开 WAL）；
 *   "收拢"指的是知识库四后端的**访问面**收拢到本模块，而不是把文件域对象塞进 DB 层。
 * - 各子面的 schema 初始化都幂等（CREATE IF NOT EXISTS / 迁移幂等跳过），
 *   共享连接上按任意顺序首次访问都安全。
 */
import { Database } from "bun:sqlite";
import { resolveSqliteMemoryDbPath, SQLiteMemory } from "../memory/sqlite-memory.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { KnowledgeGraphEnhanced } from "../kg/enhanced.js";
import { KnowledgeAccessLayer } from "../kal/knowledge-access-layer.js";

export class KnowledgeBackend {
  readonly db: Database;
  private _memory?: SQLiteMemory;
  private _store?: KnowledgeStore;
  private _kg?: KnowledgeGraphEnhanced;
  private _kal?: KnowledgeAccessLayer;

  constructor(db: Database) {
    this.db = db;
  }

  get memory(): SQLiteMemory {
    return (this._memory ??= new SQLiteMemory(this.db));
  }

  get store(): KnowledgeStore {
    return (this._store ??= new KnowledgeStore(this.db));
  }

  get kg(): KnowledgeGraphEnhanced {
    return (this._kg ??= new KnowledgeGraphEnhanced(this.db));
  }

  get kal(): KnowledgeAccessLayer {
    return (this._kal ??= new KnowledgeAccessLayer(this.db));
  }
}

let _backend: KnowledgeBackend | null = null;

/** 进程级单例：不传 db 时按 SQLITE_MEMORY_DB → DATABASE_PATH → ./data/agent.db 解析（与 SQLiteMemory 同源）。 */
export function getKnowledgeBackend(db?: Database): KnowledgeBackend {
  if (!_backend) _backend = new KnowledgeBackend(db ?? new Database(resolveSqliteMemoryDbPath()));
  return _backend;
}
