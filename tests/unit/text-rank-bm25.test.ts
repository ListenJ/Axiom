import { describe, it, expect } from "bun:test";
import { rankDocuments, tokenize, type RankableDoc } from "../../src/dre/runtime/text-rank.js";

/**
 * BM25 排序（步骤 1.2 切片 4：把手搓权重换成正统 IR 工程实践）
 *
 * 上一版 `scoreMatch` 是自拟公式（命中词数 × 0.6 + 覆盖率 × 0.4）× 字段权重，
 * **缺少 df 维度** —— 一个出现在语料几乎所有文档里的常见词，与一个只出现在
 * 一两篇里的稀有词贡献相同分数，检索判别力差。
 *
 * BM25 是业界标准（SQLite FTS5 用的也是它），引入 IDF 与文档长度归一化：
 *   IDF(t)  = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 *   score   = Σ_t IDF(t) · (tf·(k1+1)) / (tf + k1·(1 - b + b·|D|/avgdl))
 * 收敛到 DRE 后要"检索质量不劣于收敛前"（收敛前是 FTS5 的 bm25），
 * 因此必须用同一族打分函数，而不是自拟权重。
 */

function doc(content: string, name = ""): RankableDoc<string> {
  return { item: content, fields: [name, content] };
}

describe("BM25 语料统计与判别力（切片 4）", () => {
  it("IDF：稀有词比常见词更有判别力（上一版缺失的维度）", () => {
    // "系统" 出现在全部 5 篇；"量子退火" 只出现在第 5 篇
    const docs = [
      doc("系统 架构 设计"),
      doc("系统 性能 调优"),
      doc("系统 安全 加固"),
      doc("系统 部署 运维"),
      doc("系统 量子退火 实验"),
    ];
    const ranked = rankDocuments("系统 量子退火", docs);
    expect(ranked[0].item).toContain("量子退火");

    // 反向对照：只查常见词时，不应因为"哪篇更长"而随意胜出
    const common = rankDocuments("系统", docs);
    expect(common.length).toBe(5);
  });

  it("df 越高（词越普遍）⇒ 该词带来的分数越低", () => {
    // 同一篇目标文档，两次查询分别用「普遍词」与「稀有词」
    const target = doc("alpha beta gamma");
    const withCommon = [
      doc("common alpha x"), doc("common alpha y"), doc("common alpha z"),
      target,
    ];
    const commonScore = rankDocuments("alpha", withCommon).find((r) => r.item === target.item)!.score;

    const withRare = [
      doc("misc x"), doc("misc y"), doc("misc z"),
      target,
    ];
    const rareScore = rankDocuments("alpha", withRare).find((r) => r.item === target.item)!.score;

    expect(rareScore).toBeGreaterThan(commonScore);
  });

  it("长度归一化：同样命中一次，短文档得分高于被灌水的长文档", () => {
    const short = doc("alpha");
    const padded = doc("alpha " + Array.from({ length: 40 }, (_, i) => `pad${i}`).join(" "));
    const ranked = rankDocuments("alpha", [padded, short]);
    expect(ranked[0].item).toBe("alpha");
  });

  it("tf 饱和：同一个词重复很多次不会线性拉高分数（k1 的作用）", () => {
    const once = doc("alpha");
    const many = doc("alpha ".repeat(20).trim());
    const s1 = rankDocuments("alpha", [once]).find((r) => r.item === once.item)!.score;
    const s2 = rankDocuments("alpha", [many]).find((r) => r.item === many.item)!.score;
    // 重复 20 次带来的增益应远小于 20 倍（饱和）
    expect(s2).toBeLessThan(s1 * 4);
  });
});

describe("BM25 排序行为（切片 4）", () => {
  it("按分数降序返回，同分按稳定兜底（不依赖输入顺序的随机性）", () => {
    const docs = [doc("beta"), doc("alpha"), doc("alpha beta")];
    const r1 = rankDocuments("alpha beta", docs).map((r) => r.item);
    const r2 = rankDocuments("alpha beta", docs).map((r) => r.item);
    expect(r1).toEqual(r2);
    expect(r1[0]).toBe("alpha beta"); // 两个词都命中
  });

  it("limit 生效", () => {
    const docs = Array.from({ length: 10 }, (_, i) => doc(`alpha item${i}`));
    expect(rankDocuments("alpha", docs, 3)).toHaveLength(3);
  });

  it("空查询 / 空语料 / 全不匹配 → 空数组且不抛错", () => {
    expect(rankDocuments("", [doc("x")])).toEqual([]);
    expect(rankDocuments("x", [])).toEqual([]);
    expect(rankDocuments("zzzq-nonexistent", [doc("alpha")])).toEqual([]);
  });

  it("空格分隔的中文查询仍能命中连写内容（切片 1-3 的既有能力不退化）", () => {
    const target = doc("确定性检索引擎的设计");
    const ranked = rankDocuments("确定性 检索", [doc("无关内容"), target]);
    expect(ranked.map((r) => r.item)).toContain(target.item);
  });

  it("字段权重：命中 name 优于命中 body", () => {
    const inName = { item: "A", fields: ["检索", "无关正文"] };
    const inBody = { item: "B", fields: ["无关标题", "检索"] };
    const ranked = rankDocuments("检索", [inBody, inName]);
    expect(ranked[0].item).toBe("A");
  });

  it("短语命中获得额外加权", () => {
    const phrase = doc("确定性检索");
    const scattered = doc("确定性 引擎 检索 无关");
    const ranked = rankDocuments("确定性检索", [scattered, phrase]);
    expect(ranked[0].item).toBe("确定性检索");
  });

  it("分词器不变（回归保护）", () => {
    expect(tokenize("确定性检索")).toEqual(["确定", "定性", "性检", "检索"]);
  });
});
