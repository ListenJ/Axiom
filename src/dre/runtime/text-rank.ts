/**
 * 确定性关键词检索的文本处理与打分（BM25）
 *
 * 背景（T3 步骤 1.2）：知识后端要收敛到 DRE SQLite 一处，但 DRE 现有的
 * `atomStore.search()` / `knowledgeNetwork.search()` 都是**朴素子串匹配**
 * （整串 `toLowerCase().includes()` + 凑够 limit 即 break），三个缺陷：
 *   1. 无分词：查询 `"确定性 检索"`（带空格）匹配不到内容 `"确定性检索"`，
 *      多词查询几乎必然 0 结果；中文无 CJK 分词尤甚
 *   2. 无打分排序：结果按 Map 插入顺序截断，相关项可能排在无关项之后
 *   3. 提前 break：凑够 limit 即停，可能整体漏掉更相关的项
 *
 * 打分函数（切片 4）：**BM25**，与 SQLite FTS5 同族。
 *
 * 切片 1-3 的自拟公式 `(命中词数×0.6 + 覆盖率×0.4) × 字段权重` **缺少 df 维度**：
 * 一个出现在语料几乎所有文档里的常见词，与一个只出现在一两篇里的稀有词贡献相同
 * 分数，判别力差。收敛到 DRE 后要求"检索质量不劣于收敛前"（收敛前是 FTS5 的
 * bm25），因此必须用同一族打分函数，而不是自拟权重：
 *
 *   IDF(t)    = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 *   tfNorm(t) = tf·(k1+1) / (tf + k1·(1 - b + b·|D|/avgdl))
 *   score     = Σ_t IDF(t) · tfNorm(t)
 *
 * 硬约束（与"确定性检索 / 纯词法匹配"两个卖点绑定）
 *   - **确定性**：同一输入必须给出同一输出（同分数、同顺序）。不引入随机、不依赖时间；
 *     同分用输入下标稳定兜底，排序结果与调用顺序无关。
 *   - **纯词法**：不引入 embedding / 向量库。
 *   - **深模块**（规则 8）：对外只有 `tokenize` / `rankDocuments`；`scoreMatch`
 *     保留为单文档便捷入口（切片 1-3 的既有调用方与测试）。
 *
 * 字段权重：`1 / (1 + 字段下标)`，按字段分别算 BM25 后加权求和
 *   —— BM25 本身不建模字段，字段重要性由此项承担（命中 name 优于命中 body）。
 */

/** CJK 统一表意文字区段（含扩展 A） */
const CJK = "\\u4e00-\\u9fff\\u3400-\\u4dbf";
const SEG_RE = new RegExp(`[${CJK}]+|[A-Za-z0-9]+`, "g");
const CJK_ONLY_RE = new RegExp(`^[${CJK}]+$`);

/** BM25 词频饱和参数：控制"同一词重复出现"的增益上限 */
const K1 = 1.2;
/** BM25 长度归一化强度：0 = 不归一化，1 = 完全归一化 */
const B = 0.75;
/** 多字段文档的短语命中：按**命中的查询词数**给对数级加分（远小于一个 IDF 项，不喧宾夺主） */
const PHRASE_BONUS = 0.5;

/**
 * 分词。
 *
 * - 拉丁/数字段：按非字母数字切分并小写化
 * - CJK 段：生成**二元组**（中文无空格可分，单字切分召回过低）
 *   单个汉字退化为其自身，避免完全丢失
 *
 * 输出顺序 = 输入中出现顺序，保证确定性。
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const matches = text.match(SEG_RE);
  if (!matches) return [];

  const out: string[] = [];
  for (const seg of matches) {
    if (CJK_ONLY_RE.test(seg)) {
      if (seg.length === 1) {
        out.push(seg);
      } else {
        for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
      }
    } else {
      out.push(seg.toLowerCase());
    }
  }
  return out;
}

/** 每个字段的权重：越靠前越高 */
function fieldWeight(index: number): number {
  return 1 / (1 + index);
}

/** 语料统计（由 `rankDocuments` 一次性构建，避免每个文档重算） */
interface CorpusStats {
  /** 文档数 */
  n: number;
  /** 每个字段的平均长度（token 数），长度归一化用 */
  avgFieldLen: number[];
  /** 字段数 */
  fieldCount: number;
}

/** 词频表：token → 出现次数 */
type TfMap = Map<string, number>;

/**
 * 文档频率 df(t)：**token 至少出现一次**的文档数。
 *
 * 按 BM25 的标准定义，df 以"文档"为单位（不区分字段），
 * 因此构建索引时把各字段的 token 合并去重后再计数。
 */
function documentFrequency(tokenizedDocs: string[][][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const fields of tokenizedDocs) {
    const seen = new Set<string>();
    for (const dTokens of fields) {
      for (const t of dTokens) {
        if (seen.has(t)) continue;
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  return df;
}

/** IDF(t)：词越普遍 ⇒ 越小；df=0 时为 0（该词不在语料中，不贡献分数） */
function idf(t: string, df: Map<string, number>, n: number): number {
  const dfT = df.get(t) ?? 0;
  if (dfT === 0) return 0;
  return Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5));
}

/** count → token 频次表 */
function toTf(tokens: string[]): TfMap {
  const tf: TfMap = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** 单个字段的 BM25 分：Σ_t IDF(t) · tf·(k1+1) / (tf + k1·(1 - b + b·|D|/avgdl)) */
function bm25Field(
  tf: TfMap,
  fieldLen: number,
  avgFieldLen: number,
  qSet: Set<string>,
  df: Map<string, number>,
  n: number,
): number {
  if (fieldLen === 0) return 0;
  // avgdl = 0 时（语料全空）退化为不归一化，避免除零
  const norm = avgFieldLen > 0 ? fieldLen / avgFieldLen : 1;
  let score = 0;
  for (const t of qSet) {
    const f = tf.get(t);
    if (!f) continue;
    const w = idf(t, df, n);
    if (w === 0) continue; // 查询词不在语料中 → 不贡献（也保证"全不匹配 → 空数组"）
    score += w * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * norm)));
  }
  return score;
}

/** 短语命中加分：按命中的查询词数给对数级加分（有界，不主导排序） */
function phraseBoost(qSet: Set<string>, fields: string[]): number {
  let hit = 0;
  for (const t of qSet) {
    for (const f of fields) {
      if (f && f.toLowerCase().includes(t)) {
        hit++;
        break;
      }
    }
  }
  return hit > 0 ? PHRASE_BONUS * Math.log(1 + hit) : 0;
}

/** 可排序文档：`item` 为调用方要拿回的对象，`fields` 按重要性从高到低排列 */
export interface RankableDoc<T> {
  item: T;
  fields: string[];
}

/** 排序结果：`item` + BM25 分数 */
export interface RankedDoc<T> {
  item: T;
  score: number;
}

/**
 * 对一批文档按 BM25 相关性排序。
 *
 * @param query 查询串
 * @param docs  语料（同时提供 df / 平均长度所需的统计基础）
 * @param limit 截断上限；省略或 ≤0 表示不截断
 * @returns 分数降序的 `{ item, score }[]`；同分按输入下标升序（稳定、确定性）。
 *          空查询 / 空语料 / 全不匹配返回 `[]`，不抛错。
 */
export function rankDocuments<T>(query: string, docs: RankableDoc<T>[], limit = 0): RankedDoc<T>[] {
  if (!query || docs.length === 0) return [];

  const qSet = new Set(tokenize(query));
  if (qSet.size === 0) return [];

  const tokenizedDocs = docs.map((d) => d.fields.map((f) => tokenize(f)));
  const df = documentFrequency(tokenizedDocs);
  const n = docs.length;
  const fieldCount = Math.max(...docs.map((d) => d.fields.length), 0);

  // 每个字段的平均长度：除以"该字段存在的文档数"而非总文档数，
  // 否则字段缺失的文档会把平均值拉低，间接惩罚字段齐全的文档
  const avgFieldLen: number[] = [];
  for (let i = 0; i < fieldCount; i++) {
    let total = 0;
    let present = 0;
    for (const fields of tokenizedDocs) {
      if (i < fields.length) {
        total += fields[i].length;
        present++;
      }
    }
    avgFieldLen.push(present > 0 ? total / present : 0);
  }

  const corpus: CorpusStats = { n, avgFieldLen, fieldCount };

  const scored: RankedDoc<T>[] = [];
  for (let i = 0; i < docs.length; i++) {
    const fields = docs[i].fields;
    const fieldTokens = tokenizedDocs[i];
    let score = 0;
    // 单字段文档：BM25 已带字段权重（1/(1+0)=1），无需短语加分（与切片 1-3 行为一致）
    if (fields.length === 1) {
      const tf = toTf(fieldTokens[0]);
      score = bm25Field(tf, fieldTokens[0].length, corpus.avgFieldLen[0] ?? 0, qSet, df, n);
    } else {
      for (let j = 0; j < fields.length; j++) {
        const w = fieldWeight(j);
        if (w === 0) continue;
        const tf = toTf(fieldTokens[j]);
        score += bm25Field(tf, fieldTokens[j].length, corpus.avgFieldLen[j] ?? 0, qSet, df, n) * w;
      }
      if (score > 0) score += phraseBoost(qSet, fields);
    }
    if (score > 0) scored.push({ item: docs[i].item, score });
  }

  // 稳定排序：分数降序，同分按输入下标升序 —— 同一输入两次调用顺序完全一致（确定性底线）
  const indexed = scored.map((s, i) => ({ ...s, i }));
  indexed.sort((a, b) => b.score - a.score || a.i - b.i);

  const out = indexed.map(({ item, score }) => ({ item, score }));
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * 单文档匹配分（便捷入口，保留给切片 1-3 的既有调用方）。
 *
 * 只给一篇文档时没有语料统计，df 退化为"该词是否在本篇出现"（出现=1，否则 0），
 * N=1 ⇒ 命中词的 IDF 恒为 `ln(1 + (1-1+0.5)/(1+0.5))`。因此它适合做
 * **"是否命中 + 命中多少词"的判断**（如 `atomStore.search()` 的过滤），
 * 而**跨文档的相关性排序应当用 `rankDocuments`**（那里才有真实的 df / avgdl）。
 *
 * @param fields 文档字段，按重要性从高到低排列
 * @returns > 0 表示匹配；0 表示不匹配。空查询或空字段返回 0（不抛错）。
 */
export function scoreMatch(query: string, fields: string[]): number {
  if (!query || fields.length === 0) return 0;
  const qSet = new Set(tokenize(query));
  if (qSet.size === 0) return 0;

  const fieldTokens = fields.map((f) => tokenize(f));
  const n = 1;
  const df = documentFrequency([fieldTokens]);

  let score = 0;
  for (let j = 0; j < fields.length; j++) {
    const w = fieldWeight(j);
    if (w === 0) continue;
    // 单文档下 avgdl = 该字段自身长度 ⇒ norm 恒为 1（无跨文档归一化可言）
    score += bm25Field(toTf(fieldTokens[j]), fieldTokens[j].length, fieldTokens[j].length, qSet, df, n) * w;
  }
  if (score > 0 && fields.length > 1) score += phraseBoost(qSet, fields);
  return score;
}
