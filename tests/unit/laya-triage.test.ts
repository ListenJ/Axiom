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

const choiceQ: Record<string, LayaQuestion> = { "next step?": { type: "choice", options: { a: "甲", b: "乙" } } };
const approvalQ: Record<string, LayaQuestion> = {
  approval: { type: "noul", instructions: "该动作是否需要用户批准后才可执行？" },
};

const spec = (over: Partial<LayaGateSpec> = {}): LayaGateSpec => ({
  state: { project: "axiom", tsc_exit: 0 },
  decisions: [{ id: "d-choice", domain: "triage", questions: choiceQ, irreversibleQuestions: [], forbiddenAuto: [] }],
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

  it("选中不可逆动作 ⇒ 即使 margin 很大也 ESCALATE", async () => {
    const s = spec({
      decisions: [{ id: "d-choice", domain: "triage", questions: choiceQ, irreversibleQuestions: ["next step?"] }],
    });
    const t = createLayaTriage({
      run: fake({ "d-choice": { "next step?": { type: "choice", probabilities: { a: 0.99, b: 0.01 } } } }),
    });
    const [r] = await t.triage(s);
    expect(r.verdict).toBe("ESCALATE");
    expect(r.reasons.join(" ")).toMatch(/不可逆|禁止自动/);
  });

  it("noul > 0.5 且问的是「需人批准」⇒ ESCALATE；低概率不升级", async () => {
    const s = spec({ decisions: [{ id: "d-choice", domain: "escalation", questions: approvalQ }] });
    const hi = createLayaTriage({ run: fake({ "d-choice": { approval: { type: "noul", noul: 0.72 } } }) });
    expect((await hi.triage(s))[0].verdict).toBe("ESCALATE");
    const lo = createLayaTriage({ run: fake({ "d-choice": { approval: { type: "noul", noul: 0.31 } } }) });
    expect((await lo.triage(s))[0].verdict).toBe("AUTO");
  });

  it("noul 高但问句不涉及批准 ⇒ 不因此升级（避免把任意 noul 当否决）", async () => {
    const s = spec({
      decisions: [{
        id: "d-choice", domain: "escalation",
        questions: { stat: { type: "noul", instructions: "这些统计是否支持结论？" } },
      }],
    });
    const t = createLayaTriage({ run: fake({ "d-choice": { stat: { type: "noul", noul: 0.9 } } }) });
    expect((await t.triage(s))[0].verdict).toBe("AUTO");
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
        { id: "go", domain: "triage", questions: choiceQ },
        { id: "stop", domain: "triage", questions: choiceQ },
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
