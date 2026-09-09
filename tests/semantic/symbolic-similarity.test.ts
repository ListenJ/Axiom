/**
 * S-A8 演进切片 1：symbolic-similarity 纯函数 + 校准矩阵（TDD RED→GREEN）
 *
 * 计划口径（docs/superpowers/plans/2026-09-10-sa8-evolution-l4-symbolic-plan.md 第二节 D2 + 第三节切片 1）：
 * - normalizeEntity：小写 + trim + 全/半角折叠 + 去除 [\\s\\-_./]（腿 1 归一化精确匹配的基础）；
 * - bigrams：CJK 连续段切相邻二字组 + 拉丁/数字段切字符二元组（范式对齐
 *   settings-search charBigrams / deterministic-search CJK bigram，独立实现零跨模块依赖）；
 * - bigramJaccard：|A∩B|/|A∪B|，任一侧空集 → 0（fail 向不匹配侧）；
 * - 校准矩阵即规格：postgres~postgresql ≥0.4 匹配 / docker~kubernetes <0.4 不匹配
 *   （修复 S-A8 切片 6 字符频率余弦 0.51 越阈教训）/ 机器学习~深度学习 0.20 / kubernetes~k8s 0。
 */
import { describe, expect, it } from "bun:test";
import {
  normalizeEntity,
  bigrams,
  bigramJaccard,
} from "../../src/semantic/symbolic-similarity.js";

/** 计划 D2 冻结阈值（0.4 起步，本矩阵实测复核） */
const THRESHOLD = 0.4;

describe("演进切片 1：normalizeEntity（表面归一化）", () => {
  it("小写 + trim：'  Kubernetes ' → 'kubernetes'", () => {
    expect(normalizeEntity("  Kubernetes ")).toBe("kubernetes");
  });

  it("去除连字符/下划线/点/斜杠/空格：'Post-Gre SQL' / 'a.b' / 'a/b' 折叠", () => {
    expect(normalizeEntity("Post-Gre SQL")).toBe("postgresql");
    expect(normalizeEntity("post_gre")).toBe("postgre");
    expect(normalizeEntity("a.b/c d-e_f")).toBe("abcdef");
  });

  it("全角→半角折叠：'ｇｏｏｇｌｅ' → 'google'；全角空格 U+3000 去除", () => {
    expect(normalizeEntity("ｇｏｏｇｌｅ")).toBe("google");
    expect(normalizeEntity("a　b")).toBe("ab"); // eslint-disable-line no-irregular-whitespace
  });

  it("CJK 原样保留：'机器学习' → '机器学习'", () => {
    expect(normalizeEntity(" 机器学习 ")).toBe("机器学习");
  });

  it("变体归一后相等（腿 1 判定语义）：大小写/连字符/空格变体同形", () => {
    expect(normalizeEntity("Kubernetes")).toBe(normalizeEntity("kubernetes"));
    expect(normalizeEntity("Kube-Stack")).toBe(normalizeEntity("kube stack"));
    expect(normalizeEntity("KUBE_STACK")).toBe(normalizeEntity("kube.stack"));
  });
});

describe("演进切片 1：bigrams（混合文字二元组切分）", () => {
  it("CJK 连续段切相邻二字组：'机器学习' → {机器,器学,学习}", () => {
    expect(bigrams("机器学习")).toEqual(new Set(["机器", "器学", "学习"]));
  });

  it("拉丁段切字符二元组：'docker' → {do,oc,ck,ke,er}", () => {
    expect(bigrams("docker")).toEqual(new Set(["do", "oc", "ck", "ke", "er"]));
  });

  it("数字并入拉丁段：'k8s' → {k8,8s}", () => {
    expect(bigrams("k8s")).toEqual(new Set(["k8", "8s"]));
  });

  it("混合脚本分段：'AI学习' → {ai,学习}（不产生跨脚本伪 bigram）", () => {
    expect(bigrams("AI学习")).toEqual(new Set(["ai", "学习"]));
  });

  it("单字/单字符段无二元组：'a机' → 空集", () => {
    expect(bigrams("a机")).toEqual(new Set());
  });

  it("先归一化再切分：'Post-Gre SQL' 与 'postgresql' 同集合", () => {
    expect(bigrams("Post-Gre SQL")).toEqual(bigrams("postgresql"));
  });
});

describe("演进切片 1：bigramJaccard 校准矩阵（计划 D2，测试即规格）", () => {
  it("postgres ~ postgresql ≈0.778（7/9）→ ≥ 阈值，匹配", () => {
    const s = bigramJaccard("postgres", "postgresql");
    expect(s).toBeCloseTo(7 / 9, 6);
    expect(s).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it("docker ~ kubernetes ≈0.077（仅共享 'er'，1/13）→ < 阈值，不匹配（切片 6 余弦 0.51 越阈教训修复）", () => {
    const s = bigramJaccard("docker", "kubernetes");
    expect(s).toBeCloseTo(1 / 13, 10);
    expect(s).toBeLessThan(THRESHOLD);
  });

  it("机器学习 ~ 深度学习 = 0.20（仅共享 '学习'）→ < 阈值，不匹配（已知弱点：交别名表腿，不做项）", () => {
    const s = bigramJaccard("机器学习", "深度学习");
    expect(s).toBeCloseTo(0.2, 10);
    expect(s).toBeLessThan(THRESHOLD);
  });

  it("kubernetes ~ k8s = 0（缩写无表面重叠，已知弱点同上）", () => {
    expect(bigramJaccard("kubernetes", "k8s")).toBe(0);
  });

  it("同名经归一化 → 1.0：'Kubernetes' ~ 'kubernetes'", () => {
    expect(bigramJaccard("Kubernetes", "kubernetes")).toBe(1);
  });

  it("边界 fail 向不匹配侧：空串 / 纯符号串 / 单字符 → 0", () => {
    expect(bigramJaccard("", "docker")).toBe(0);
    expect(bigramJaccard("docker", "")).toBe(0);
    expect(bigramJaccard("---", "...")).toBe(0); // 双方空集 → 0（非 0/0 NaN）
    expect(bigramJaccard("a", "a")).toBe(0); // 单字符无二元组
  });

  it("对称性：jaccard(a,b) === jaccard(b,a)", () => {
    expect(bigramJaccard("postgres", "postgresql")).toBe(
      bigramJaccard("postgresql", "postgres"),
    );
  });
});
