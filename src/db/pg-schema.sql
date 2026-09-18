-- ============================================================
-- Axiom Runtime PostgreSQL + pgvector Schema v1.0
--
-- 四层架构:
--   L0: 代码图谱 (Code Graph) — 文件/节点/边/向量
--   L1: 知识图谱 (Knowledge Graph) — 实体/关系/属性
--   L2: 语义记忆 (Semantic Memory) — 笔记/全文/向量
--   L3: 运行状态 (Operational) — 对话/任务/模型用量
--
-- 搜索引擎:
--   - pgvector HNSW: 语义向量相似度 (cosine)
--   - pg_trgm: 模糊文本匹配 (trigram)
--   - tsvector: 全文检索 (weighted BM25)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- L0: 代码图谱层 (Code Graph)
-- ============================================================

CREATE TABLE IF NOT EXISTS code_projects (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    root_path   TEXT NOT NULL,
    language    TEXT,               -- 主语言
    description TEXT,
    metadata    JSONB DEFAULT '{}',
    indexed_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(name, root_path)
);

CREATE TABLE IF NOT EXISTS code_files (
    id           BIGSERIAL PRIMARY KEY,
    project_id   BIGINT NOT NULL REFERENCES code_projects(id) ON DELETE CASCADE,
    file_path    TEXT NOT NULL,
    language     TEXT NOT NULL,
    lines        INTEGER DEFAULT 0,
    content_hash TEXT,              -- SHA-256, 用于变更检测
    indexed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_code_files_project ON code_files(project_id);
CREATE INDEX IF NOT EXISTS idx_code_files_lang ON code_files(language);

CREATE TABLE IF NOT EXISTS code_nodes (
    id              BIGSERIAL PRIMARY KEY,
    file_id         BIGINT REFERENCES code_files(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,   -- function, class, interface, method, variable, enum, struct, module, type
    name            TEXT NOT NULL,
    qualified_name  TEXT NOT NULL,   -- e.g. "axiom.memory.SQLiteMemory.query"
    signature       TEXT,
    start_line      INTEGER NOT NULL,
    end_line        INTEGER NOT NULL,
    docstring       TEXT,
    code_body       TEXT,            -- 前 30 行代码体
    metadata        JSONB DEFAULT '{}',
    embedding       vector(1536),    -- 语义向量 (text-embedding-3-small 或等价模型)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_code_nodes_file ON code_nodes(file_id);
CREATE INDEX IF NOT EXISTS idx_code_nodes_kind ON code_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_code_nodes_name_trgm ON code_nodes USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_code_nodes_qualified_trgm ON code_nodes USING gin(qualified_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_code_nodes_embedding ON code_nodes
    USING hnsw(embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS code_edges (
    id          BIGSERIAL PRIMARY KEY,
    source_id   BIGINT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
    target_id   BIGINT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
    edge_type   TEXT NOT NULL,       -- calls, imports, extends, implements, references, contains, depends_on
    metadata    JSONB DEFAULT '{}',
    UNIQUE(source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_code_edges_source ON code_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_target ON code_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_type ON code_edges(edge_type);

-- 未解析引用 (外部依赖或未完成代码)
CREATE TABLE IF NOT EXISTS code_unresolved_refs (
    id          BIGSERIAL PRIMARY KEY,
    file_id     BIGINT REFERENCES code_files(id) ON DELETE CASCADE,
    ref_name    TEXT NOT NULL,
    ref_type    TEXT,                -- import, call, type_ref
    raw_text    TEXT,
    line_number INTEGER
);

-- ============================================================
-- L1: 知识图谱层 (Knowledge Graph)
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_entities (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT UNIQUE NOT NULL,
    type        TEXT NOT NULL,       -- person, org, concept, tool, file, api, pattern, project
    description TEXT,
    properties  JSONB DEFAULT '{}',
    embedding   vector(1536),        -- 实体描述的语义向量
    source      TEXT,                -- 来源 (hermes, codegraph, manual, web_search)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(type);
CREATE INDEX IF NOT EXISTS idx_kg_entities_name_trgm ON kg_entities USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kg_entities_source ON kg_entities(source);
CREATE INDEX IF NOT EXISTS idx_kg_entities_embedding ON kg_entities
    USING hnsw(embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS kg_relationships (
    id            BIGSERIAL PRIMARY KEY,
    source_id     BIGINT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    target_id     BIGINT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,     -- uses, depends_on, part_of, mentions, implements, extends, authored_by
    weight        REAL DEFAULT 1.0,
    properties    JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_id, target_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_kg_rel_source ON kg_relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_kg_rel_target ON kg_relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_kg_rel_type ON kg_relationships(relation_type);

-- 图遍历辅助视图: 节点度数统计
CREATE OR REPLACE VIEW kg_entity_degree AS
SELECT
    e.id,
    e.name,
    e.type,
    COUNT(DISTINCT CASE WHEN r.source_id = e.id THEN r.id END) AS out_degree,
    COUNT(DISTINCT CASE WHEN r.target_id = e.id THEN r.id END) AS in_degree
FROM kg_entities e
LEFT JOIN kg_relationships r ON r.source_id = e.id OR r.target_id = e.id
GROUP BY e.id, e.name, e.type;

-- ============================================================
-- L2: 语义记忆层 (Semantic Memory)
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_notes (
    id              BIGSERIAL PRIMARY KEY,
    path            TEXT UNIQUE NOT NULL,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    excerpt         TEXT NOT NULL DEFAULT '',
    tags            TEXT[] NOT NULL DEFAULT '{}',
    para_category   TEXT NOT NULL DEFAULT 'resources',  -- projects, areas, resources, conversations, archives
    type            TEXT NOT NULL DEFAULT 'note',
    source          TEXT,
    confidence      REAL NOT NULL DEFAULT 0.7,
    embedding       vector(1536),
    search_vector   tsvector,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_notes(path);
CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_notes(para_category);
CREATE INDEX IF NOT EXISTS idx_memory_tags ON memory_notes USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_memory_fts ON memory_notes USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_memory_embedding ON memory_notes
    USING hnsw(embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

-- 自动更新 tsvector 的触发器
CREATE OR REPLACE FUNCTION update_memory_search_vector() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(NEW.excerpt, '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(LEFT(NEW.content, 5000), '')), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memory_search_vector_update ON memory_notes;
CREATE TRIGGER memory_search_vector_update
    BEFORE INSERT OR UPDATE ON memory_notes
    FOR EACH ROW EXECUTE FUNCTION update_memory_search_vector();

-- ============================================================
-- L3: 运行状态层 (Operational)
-- ============================================================

-- 对话记录 (从 SQLite conversations 升级)
CREATE TABLE IF NOT EXISTS conversations (
    id              BIGSERIAL PRIMARY KEY,
    session_id      TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    role            TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    content         TEXT NOT NULL,
    tool_calls      JSONB,
    tool_results    JSONB,
    tokens_used     INTEGER,
    latency_ms      INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id, created_at DESC);

-- 任务记录
CREATE TABLE IF NOT EXISTS tasks (
    id              BIGSERIAL PRIMARY KEY,
    task_key        TEXT UNIQUE NOT NULL,
    agent_id        TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed','cancelled')),
    priority        INTEGER NOT NULL DEFAULT 5,
    parent_task_id  BIGINT,
    metadata        JSONB DEFAULT '{}',
    context_summary TEXT,
    result_summary  TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 模型用量追踪
CREATE TABLE IF NOT EXISTS model_usage (
    id              BIGSERIAL PRIMARY KEY,
    model_id        TEXT NOT NULL,
    provider        TEXT NOT NULL,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    latency_ms      INTEGER,
    role            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_usage_model ON model_usage(model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_usage_provider ON model_usage(provider);

-- 评估结果 (从 model-eval-service.ts 的 SQLite 迁移)
CREATE TABLE IF NOT EXISTS model_evaluations (
    id              BIGSERIAL PRIMARY KEY,
    model_id        TEXT NOT NULL,
    provider        TEXT,
    capability      REAL NOT NULL DEFAULT 0,
    speed           REAL NOT NULL DEFAULT 0,
    cost            REAL NOT NULL DEFAULT 0,
    safety          REAL NOT NULL DEFAULT 0,
    overall_score   REAL NOT NULL DEFAULT 0,
    grade           TEXT,
    benchmarks      JSONB DEFAULT '{}',
    eval_type       TEXT NOT NULL DEFAULT 'quick',  -- quick, full, benchmark
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eval_model ON model_evaluations(model_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_overall ON model_evaluations(overall_score DESC);

-- ============================================================
-- 辅助函数
-- ============================================================

-- 向量相似度搜索: 代码节点
CREATE OR REPLACE FUNCTION search_code_nodes(
    query_embedding vector(1536),
    match_count INTEGER DEFAULT 10,
    similarity_threshold REAL DEFAULT 0.7,
    filter_kind TEXT DEFAULT NULL,
    filter_project BIGINT DEFAULT NULL
) RETURNS TABLE (
    id BIGINT,
    name TEXT,
    qualified_name TEXT,
    kind TEXT,
    file_path TEXT,
    language TEXT,
    similarity REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cn.id,
        cn.name,
        cn.qualified_name,
        cn.kind,
        cf.file_path,
        cf.language,
        (1 - (cn.embedding <=> query_embedding))::REAL AS similarity
    FROM code_nodes cn
    JOIN code_files cf ON cf.id = cn.file_id
    WHERE
        (filter_kind IS NULL OR cn.kind = filter_kind)
        AND (filter_project IS NULL OR cf.project_id = filter_project)
        AND cn.embedding IS NOT NULL
        AND (1 - (cn.embedding <=> query_embedding)) > similarity_threshold
    ORDER BY cn.embedding <=> query_embedding
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- 向量相似度搜索: 知识图谱实体
CREATE OR REPLACE FUNCTION search_kg_entities(
    query_embedding vector(1536),
    match_count INTEGER DEFAULT 10,
    similarity_threshold REAL DEFAULT 0.7,
    filter_type TEXT DEFAULT NULL
) RETURNS TABLE (
    id BIGINT,
    name TEXT,
    type TEXT,
    description TEXT,
    similarity REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        e.id,
        e.name,
        e.type,
        e.description,
        (1 - (e.embedding <=> query_embedding))::REAL AS similarity
    FROM kg_entities e
    WHERE
        (filter_type IS NULL OR e.type = filter_type)
        AND e.embedding IS NOT NULL
        AND (1 - (e.embedding <=> query_embedding)) > similarity_threshold
    ORDER BY e.embedding <=> query_embedding
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- 混合搜索: 全文 + 向量 (语义记忆)
CREATE OR REPLACE FUNCTION hybrid_search_memory(
    query_text TEXT,
    query_embedding vector(1536),
    match_count INTEGER DEFAULT 20,
    text_weight REAL DEFAULT 0.4,
    vector_weight REAL DEFAULT 0.6
) RETURNS TABLE (
    id BIGINT,
    path TEXT,
    title TEXT,
    excerpt TEXT,
    tags TEXT[],
    score REAL
) AS $$
BEGIN
    RETURN QUERY
    WITH fts_results AS (
        SELECT
            mn.id,
            mn.path,
            mn.title,
            mn.excerpt,
            mn.tags,
            ts_rank(mn.search_vector, plainto_tsquery('simple', query_text)) AS fts_score
        FROM memory_notes mn
        WHERE mn.search_vector @@ plainto_tsquery('simple', query_text)
        ORDER BY fts_score DESC
        LIMIT match_count * 2
    ),
    vec_results AS (
        SELECT
            mn.id,
            (1 - (mn.embedding <=> query_embedding))::REAL AS vec_score
        FROM memory_notes mn
        WHERE mn.embedding IS NOT NULL
        ORDER BY mn.embedding <=> query_embedding
        LIMIT match_count * 2
    )
    SELECT
        f.id,
        f.path,
        f.title,
        f.excerpt,
        f.tags,
        (f.fts_score * text_weight + coalesce(v.vec_score, 0) * vector_weight)::REAL AS score
    FROM fts_results f
    LEFT JOIN vec_results v ON v.id = f.id
    ORDER BY score DESC
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- 图遍历: N 度关系展开
CREATE OR REPLACE FUNCTION kg_traverse(
    start_entity_id BIGINT,
    max_depth INTEGER DEFAULT 2
) RETURNS TABLE (
    entity_id BIGINT,
    entity_name TEXT,
    entity_type TEXT,
    depth INTEGER,
    path TEXT[]
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE traversal AS (
        -- 起点
        SELECT
            e.id AS entity_id,
            e.name AS entity_name,
            e.type AS entity_type,
            0 AS depth,
            ARRAY[e.name] AS path
        FROM kg_entities e
        WHERE e.id = start_entity_id

        UNION ALL

        -- 递归展开
        SELECT
            e.id,
            e.name,
            e.type,
            t.depth + 1,
            t.path || e.name
        FROM kg_relationships r
        JOIN kg_entities e ON e.id = CASE
            WHEN r.source_id = t.entity_id THEN r.target_id
            ELSE r.source_id
        END
        JOIN traversal t ON TRUE
        WHERE t.depth < max_depth
        AND e.id != ALL(ARRAY(SELECT unnest(t.path)))  -- 防环
    )
    SELECT DISTINCT ON (tr.entity_id)
        tr.entity_id,
        tr.entity_name,
        tr.entity_type,
        tr.depth,
        tr.path
    FROM traversal tr
    ORDER BY tr.entity_id, tr.depth;
END;
$$ LANGUAGE plpgsql;
