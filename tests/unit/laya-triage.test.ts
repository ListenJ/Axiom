/**
 * Laya 决策链判定核心的行为测试。
 *
 * 用 fake runner 走公共接口 `triage()` / `decideAndRun()`，锁住的是**闸门语义**，
 * 不是模型输出本身。重点：模型只能提高警觉（ESCALATE）；不可用与禁用必须落到
 * UNAVAILABLE 而绝不落到 AUTO；被领域封杀的决策无论模型是否可用都 ESCALATE。
 *
 * questions 采用 laya 的真实入参形状（以 key 索引的对象）——传字符串数组会被
 * 库里的 `list.keys()` 直接打回，这条也在下面被隐式覆盖。
 */
import { describe, it, expect } from "bun:test";
import {
  createLayaTriage,
  toWslPath,
  type LayaAnswer,
  type LayaGateSpec,
  type LayaQuestion,
} from "../../src/decision/laya-triage.js";

const choiceQ: Record<string, LayaQuestion> = { "next step?": { type: "choice", criteria: { a: "甲", b: "乙" }, instructions: "下一步选哪个？" } };
const approvalQ: Record<string, LayaQuestion> = {
  approval: { type: "noul", instructions: "该动作是否需要用户批准后才可执行？" },
};

const spec = (over: Partial<LayaGateSpec> = {}): LayaGateSpec => ({
  state: { project: "axiom", tsc_exit: 0 },
  decisions: [{
    id: "d-choice", domain: "triage", questions: choiceQ,
    optionBlastRadius: { a: "local_reversible", b: "local_reversible" },
    forbiddenAuto: [],
  }],
  ...over,
});

const fake = (answers: Record<string, Record<string, LayaAnswer>>) => async () => answers;

describe("toWslPath —— Windows 盘符转 WSL 挂载路径", () => {
  it("D 盘绝对路径转换", () => {
    expect(toWslPath("D:\\repo\\scripts\\laya\\laya_gate.py")).toBe("/mnt/d/repo/scripts/laya/laya_gate.py");
  });
  it("正斜杠也能处理", () => {
    expect(toWslPath("C:/a/b")).toBe("/mnt/c/a/b");
  });
  it("非盘符路径原样返回", () => {
    expect(toWslPath("/srv/x/y.py")).toBe("/srv/x/y.py");
  });
});

describe("闸门规则（与 laya_gate.py 同口径）", () => {
  it("margin 足够且非不可逆 ⇒ AUTO", async () => {
    const t = createLayaTriage({
      run: fake({ "d-choice": { "next step?": { type: "choice", probabilities: { a: 0.8, b: 0.2 } } } }),
    });
    const [r] = await t.triage(spec());
    expect(r.verdict).toBe("AUTO");
    expect(r.chosen).toBe("a");
    expect(r.margin).toBeCloseTo(0.6, 5);
  });

  it("margin < 0.15 ⇒ ESCALATE，并给出可核对的数值理由", async () => {
    const t = createLayaTriage({
      run: fake({ "d-choice": { "next step?": { type: "choice", probabilities: { a: 0.52, b: 0.49 } } } }),
    });
    const [r] = await t.triage(spec());
    expect(r.verdict).toBe("ESCALATE");
    expect(r.reasons.join(" ")).toMatch(/margin 0\.030 < 0\.15/);
  });

  it("选中的**选项**半径为外写 ⇒ 即使 margin 很大也 ESCALATE", async () => {
    const s = spec({
      decisions: [{
        id: "d-choice", domain: "triage", questions: choiceQ,
        optionBlastRadius: { a: "external_write", b: "local_reversible" },
      }],
    });
    const t = createLayaTriage({
      run: fake({ "d-choice": { "next step?": { type: "choice", probabilities: { a: 0.99, b: 0.01 } } } }),
    });
    const [r] = await t.triage(s);
    expect(r.verdict).toBe("ESCALATE");
    expect(r.reasons.join(" ")).toMatch(/半径=external_write ⇒ 外写\/不可逆/);
  });

  // D5 回归：半径必须按选项判。上一版按**问题**登记不可逆，于是同一道题里
  // 模型选中最低不可逆性的那个选项，也被连带判成"属不可逆/外写动作"。
  it("同一题里有外写选项，但模型选中的是可逆选项 ⇒ 不得因不可逆升级", async () => {
    const s = spec({
      decisions: [{
        id: "d-choice", domain: "triage", questions: choiceQ,
        optionBlastRadius: { a: "external_write", b: "local_reversible" },
      }],
    });
    const t = createLayaTriage({
      run: fake({ "d-choice": { "next step?": { type: "choice", probabilities: { b: 0.93, a: 0.07 } } } }),
    });
    const [r] = await t.triage(s);
    expect(r.chosen).toBe("b");
    expect(r.verdict).toBe("AUTO");
    expect(r.reasons).toEqual([]);
  });

  it("选中的选项未登记半径 ⇒ ESCALATE（登记表是唯一依据，未知动作不自动执行）", async () => {
    const s = spec({
      decisions: [{
        id: "d-choice", domain: "triage", questions: choiceQ,
        optionBlastRadius: { b: "local_reversible" },
      }],
    });
    const t = createLayaTriage({
      run: fake({ "d-choice": { "next step?": { type: "choice", probabilities: { a: 0.9, b: 0.1 } } } }),
    });
    const [r] = await t.triage(s);
    expect(r.verdict).toBe("ESCALATE");
    expect(r.reasons.join(" ")).toMatch(/未登记爆炸半径/);
  });

  // noul 与爆炸半径实测分不开（Spearman +0.41、min(tier3)<max(tier0)）：
  // 把它当批准判据不是保守，是让闸门对所有输入都 ESCALATE、自动化归零。
  // 故 noul 只做交叉核对留痕，裁定权在登记表。
  it("noul 再高也不改裁定：登记表说可逆就仍 AUTO，但留下不一致的痕迹", async () => {
    const s = spec({
      decisions: [{
        id: "d-choice", domain: "escalation", questions: approvalQ,
        actionBlastRadius: "local_reversible",
      }],
    });
    const hi = createLayaTriage({ run: fake({ "d-choice": { approval: { type: "noul", noul: 0.72 } } }) });
    const [r] = await hi.triage(s);
    expect(r.verdict).toBe("AUTO");
    expect(r.reasons).toEqual([]);
    expect(r.notes?.join(" ")).toMatch(/noul 0\.720 高.*以登记表为准/s);
  });

  // 剥掉 noul 的裁定权之后，纯 noul 题的闸门只能来自动作半径登记；
  // 漏登记必须是升级，否则这类决策会变成"没有任何闸门"。
  it("纯 noul 决策未登记 actionBlastRadius ⇒ ESCALATE（不得因失去 noul 判据而变成无闸门）", async () => {
    const s = spec({
      decisions: [{ id: "d-choice", domain: "escalation", questions: approvalQ }],
    });
    const t = createLayaTriage({ run: fake({ "d-choice": { approval: { type: "noul", noul: 0.02 } } }) });
    const [r] = await t.triage(s);
    expect(r.verdict).toBe("ESCALATE");
    expect(r.reasons.join(" ")).toMatch(/未登记 actionBlastRadius/);
  });

  it("noul 低但登记表判外写 ⇒ 仍按登记表 ESCALATE，并留不一致痕迹", async () => {
    const s = spec({
      decisions: [{
        id: "d-mixed", domain: "escalation",
        questions: {
          "next step?": { type: "choice", criteria: { a: "甲", b: "乙" }, instructions: "下一步选哪个？" },
          approval: { type: "noul", instructions: "该动作是否需要用户批准后才可执行？" },
        },
        optionBlastRadius: { a: "destructive", b: "local_reversible" },
      }],
    });
    const t = createLayaTriage({
      run: fake({
        "d-mixed": {
          "next step?": { type: "choice", probabilities: { a: 0.95, b: 0.05 } },
          approval: { type: "noul", noul: 0.11 },
        },
      }),
    });
    const [r] = await t.triage(s);
    expect(r.verdict).toBe("ESCALATE");
    expect(r.reasons.join(" ")).toMatch(/半径=destructive/);
    expect(r.notes?.join(" ")).toMatch(/noul 0\.110 低.*以登记表为准/s);
  });

  it("模型没作答 ⇒ ESCALATE（缺答不等于通过）", async () => {
    const t = createLayaTriage({ run: fake({}) });
    const [r] = await t.triage(spec());
    expect(r.verdict).toBe("ESCALATE");
    expect(r.reasons.join(" ")).toMatch(/未作答/);
  });
});

describe("能力边界与失败方向", () => {
  it("domain=numeric / engineering ⇒ 直接 ESCALATE，连模型都不问", async () => {
    let asked = 0;
    const t = createLayaTriage({
      run: async () => {
        asked++;
        return { "d-choice": { "next step?": { type: "choice", probabilities: { a: 0.99, b: 0.01 } } } };
      },
    });
    const s = spec({ decisions: [{ id: "d-choice", domain: "numeric", questions: choiceQ }] });
    const [r] = await t.triage(s);
    expect(r.verdict).toBe("ESCALATE");
    expect(asked).toBe(0);
    expect(r.reasons.join(" ")).toMatch(/不可委托/);
  });

  it("runner 抛错 ⇒ 可问的记 UNAVAILABLE，被封杀的仍是 ESCALATE", async () => {
    const t = createLayaTriage({
      run: async () => {
        throw new Error("WSL 不可达");
      },
    });
    const s = spec({
      decisions: [
        { id: "askable", domain: "triage", questions: choiceQ },
        { id: "blocked", domain: "engineering", questions: choiceQ },
      ],
    });
    const rs = await t.triage(s);
    expect(rs.find((r) => r.id === "askable")?.verdict).toBe("UNAVAILABLE");
    const blocked = rs.find((r) => r.id === "blocked")!;
    expect(blocked.verdict).toBe("ESCALATE");
    expect(blocked.reasons.join(" ")).toMatch(/不可委托/);
  });

  it("全部决策都被封杀时不触碰 runner", async () => {
    let called = false;
    const t = createLayaTriage({
      run: async () => {
        called = true;
        return {};
      },
    });
    const s = spec({ decisions: [{ id: "b1", domain: "engineering", questions: choiceQ }] });
    await t.triage(s);
    expect(called).toBe(false);
  });

  it("enabled=false ⇒ UNAVAILABLE（禁用不等于放行）", async () => {
    const t = createLayaTriage({ run: fake({}), enabled: false });
    expect((await t.triage(spec()))[0].verdict).toBe("UNAVAILABLE");
  });
});

describe("decideAndRun：只跑 AUTO 且必须有对应动作", () => {
  it("AUTO 执行、ESCALATE 一律不执行", async () => {
    const ran: string[] = [];
    const s = spec({
      decisions: [
        { id: "go", domain: "triage", questions: choiceQ, optionBlastRadius: { yes: "local_reversible", no: "local_reversible" } },
        { id: "stop", domain: "triage", questions: choiceQ, optionBlastRadius: { yes: "local_reversible", no: "local_reversible" } },
      ],
    });
    const t = createLayaTriage({
      run: async () => ({
        go: { "next step?": { type: "choice", probabilities: { yes: 0.9, no: 0.1 } } },
        stop: { "next step?": { type: "choice", probabilities: { yes: 0.53, no: 0.47 } } },
      }),
    });
    const out = await t.decideAndRun(s, {
      go: async () => void ran.push("go"),
      stop: async () => void ran.push("stop"),
    });
    expect(ran).toEqual(["go"]);
    expect(out.executed.map((e) => e.id)).toEqual(["go"]);
    expect(out.escalated.map((e) => e.id)).toEqual(["stop"]);
  });

  it("判为 AUTO 但没有注册动作 ⇒ 记为 ESCALATE，不静默丢弃", async () => {
    const t = createLayaTriage({
      run: fake({ "d-choice": { "next step?": { type: "choice", probabilities: { a: 0.95, b: 0.05 } } } }),
    });
    const out = await t.decideAndRun(spec(), {});
    expect(out.executed).toEqual([]);
    expect(out.escalated[0].reasons.join(" ")).toMatch(/无对应可执行动作/);
  });

  it("动作抛错被如实回报", async () => {
    const t = createLayaTriage({
      run: fake({ "d-choice": { "next step?": { type: "choice", probabilities: { a: 0.95, b: 0.05 } } } }),
    });
    const out = await t.decideAndRun(spec(), {
      "d-choice": async () => {
        throw new Error("执行失败");
      },
    });
    expect(out.executed).toEqual([{ id: "d-choice", ok: false, detail: "执行失败" }]);
  });
});
