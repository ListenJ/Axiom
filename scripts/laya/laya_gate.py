"""仓库内的 Laya 决策闸门：模型出概率，**代码**决定 AUTO / ESCALATE。

与 src/decision/laya-triage.ts 同口径；两侧规则必须一致，由 tests/unit/laya-triage.test.ts
的表驱动用例锁住在 TS 侧，Python 侧只负责把模型的原始答案如实吐成 JSON，
不在这里做裁决 —— 裁决口径集中在被测试的那一层。

用法：
    wsl -d Arch /root/.venvs/laya/bin/python /mnt/d/openclaw-fusion/scripts/laya/laya_gate.py --stdin-json
    （stdin 收 LayaGateSpec JSON，stdout 出 {decision_id: {question: answer}}）

    --check   只自检（包能否 import、权重是否存在），不加载模型，秒级返回
"""
import argparse
import json
import os
import sys

CKPT = os.environ.get("LAYA_CKPT", "/root/models/laya")
DTYPE = os.environ.get("LAYA_DTYPE", "bf16")  # 实测 749ms→132ms，概率漂移 ≤0.0069，argmax 不变


def check() -> int:
    out = {"python": sys.executable, "ckpt": CKPT, "ckpt_exists": os.path.isdir(CKPT),
           "typed_decisions": os.path.isdir(os.path.join(CKPT, "typed-decisions"))}
    try:
        import laya  # noqa: F401
        out["laya_import"] = True
    except Exception as e:  # 缺包/缺依赖都是不可用，交由上层判 UNAVAILABLE
        out["laya_import"] = False
        out["error"] = f"{type(e).__name__}: {str(e)[:180]}"
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out["laya_import"] and out["ckpt_exists"] else 1


def load_agent():
    import torch
    from laya import RLAgent

    agent = RLAgent(model_id_or_path=CKPT, device="cuda")
    if DTYPE == "bf16":
        # 包内没有 dtype 开关（amp_dtype 是训练期配置），装载后转精度
        for _, m in vars(agent).items():
            if isinstance(m, torch.nn.Module):
                m.to(torch.bfloat16)
    return agent


def run_spec(spec: dict) -> dict:
    agent = load_agent()
    answers = {}
    for dec in spec["decisions"]:
        res = agent.predict(spec["state"], dec["questions"])
        answers[dec["id"]] = res.get("answers", res)
    return answers


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只自检可用性")
    ap.add_argument("--stdin-json", action="store_true", help="从 stdin 读 spec，结果写 stdout")
    ap.add_argument("--spec", help="spec JSON 文件路径")
    ap.add_argument("--out", help="结果写入文件（默认 stdout）")
    args = ap.parse_args()

    if args.check:
        return check()

    if args.stdin_json:
        spec = json.load(sys.stdin)
    elif args.spec:
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
    else:
        print(json.dumps({"error": "需要 --stdin-json 或 --spec"}), file=sys.stderr)
        return 2

    answers = run_spec(spec)
    payload = json.dumps(answers, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(payload)
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
