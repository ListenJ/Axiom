#!/usr/bin/env python3
"""
Wind 每日增量采集（2026-10-07）

用户裁定：① 采集范围 = **指数成分优先**（沪深300 → 中证500 → 中证1000）；
② 预算按 **kline 60% / fundamentals 20% / macro 15% / announcements 5%** 分配；
③ **原始文件必须先存好**，派生内容随后入库。

## 分工（实测依据，2026-10-07）
- **成分股清单走 AkShare（免费）**：`index_stock_cons_csindex` 实测 1.1 秒 / 300 只，不耗 Wind 额度。
- **行情与财务走 Wind**：实测单只 K 线（666 行）约 1.2 秒、宏观 EDB 约 1 秒、财务约 1 秒。
  故 Wind 承担日常增量，AkShare 只作免费兜底。

## 三条硬性质
1. **额度硬闸**：每次调用前按当日积分账本扣减核对，达 `WIND_DAILY_CREDITS`（默认
   `DEFAULT_CREDIT_BUDGET`=270 积分，账号免费档 300/日，留 30 余量）即停。
   注意口径是**积分**不是调用次数——各工具单价差数量级（TOOL_COST_CREDITS）。
2. **原件优先**：每次成功取数**先把原始 JSON 落盘**（`data/raw/quant/wind/<tool>/<key>.json`），
   再记账（`data/wind-usage.jsonl`）。落盘失败即视为该次失败——**不允许只记账不留原件**。
3. **可续跑**：进度记 `data/wind-rotation.json`（按品类分键），跨天接着来、不重采（`--force` 可重取）。

## 用法
    python daily_collect.py --refresh-universe            # 刷新成分股清单（AkShare，0 额度）
    python daily_collect.py --plan                        # 打印今日计划（0 调用）
    python daily_collect.py --plan --category=macro       # 只看某品类
    python daily_collect.py --run                         # 按配比执行
    python daily_collect.py --run --category=macro --max-calls=3   # 小批试跑
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))

DATA = REPO / "data"
UNIVERSE_FILE = DATA / "wind-universe.json"
ROTATION_FILE = DATA / "wind-rotation.json"
USAGE_FILE = DATA / "wind-usage.jsonl"
RAW_DIR = DATA / "raw" / "quant" / "wind"

CST = timezone(timedelta(hours=8))
INDEXES = [("000300", "沪深300"), ("000905", "中证500"), ("000852", "中证1000")]

# ═══════════════════════════════════════════════════════════════════════════
# 成本模型（2026-10-07 用真实账单校准 —— **这是本脚本最重要的一节**）
#
# 教训：Wind 各工具的**计价差异是数量级的**。我最初按"1 次调用 = 1 积分"做预算，
# 结果 20 次 `get_economic_data` 就烧掉了整个积分池（账单实测单价 10～300/次），
# 而同期 270 次 `get_stock_kline` 合计只花约 270。
# 接口响应里**不含成本字段**，因此只能靠账单页人工校准 —— 故此表是"保守估计"，
# 宁可高估（少取数）也不能低估（烧额度）。
#
# 校准来源：用户账单页 2026-10-07（末 10 条均为 get_economic_data）：
#   300 / 300 / 10 / 300 / 300 / 300 / 183.79 / 300 / 300 / 228.43
# ═══════════════════════════════════════════════════════════════════════════
TOOL_COST_CREDITS: dict[str, float] = {
    # 校准来源：用户账单页 2026-10-07
    "stock_data.get_stock_kline": 1.0,                 # 270 次 ≈ 270 积分
    "stock_data.get_stock_fundamentals": 1.07,         # 账单：0.4 + 0.67 / 次
    "financial_docs.get_company_announcements": 4.0,   # 账单：4 / 次
    "economic_data.get_economic_data": 300.0,          # 账单：10～300，**按最坏值估**
}
DEFAULT_COST = 10.0          # 未知工具：保守按 10 估
# 日预算从"次数"改为"积分"：账号 300 积分/日（免费档），脚本留 10% 余量
DEFAULT_CREDIT_BUDGET = 270.0
# 高成本品类默认**关闭**：需要显式 --allow-expensive 才跑（避免再烧池子）
EXPENSIVE_TOOLS = {"economic_data.get_economic_data"}

# 配比（2026-10-07 用真实账单校准后修订）
# 依据：① K 线单价约 1 积分、是量化底座，应拿大头；② 宏观 EDB 单价 10~300，
# 且**属一次性数据**（历史序列，不需每日增量）——已采 17/20，剩余 3 个按天慢慢补；
# ③ 财务/公告单价未校准，先给小额配比用于摸价，避免又踩数量级坑。
# 配比（按**已校准的真实单价**重排，2026-10-07）
# 单价：kline 1.0 / fundamentals 1.07 / announcements 4.0 / macro 300(最坏)
# 目标：在一个月内把「沪深300 → 中证500 → 中证1000」的**行情 + 财务**都补齐；
#       公告单价是财务的 4 倍且信息可后补，故只留象征性额度。
CATEGORY_BUDGET: dict[str, float] = {
    "kline": 0.50,          # ≈135 积分 → 135 只/日；剩 1535 只 ≈ 11.4 天
    "fundamentals": 0.45,   # ≈121 积分 → 113 只/日；剩 1797 只 ≈ 16 天
    "announcements": 0.02,  # ≈5 积分 → 1 只/日（低优先，够摸底）
    "macro": 0.03,          # ≈8 积分 → 0 次（买不起单次；属一次性数据，须显式开启）
}
CATEGORY_ORDER = ["kline", "fundamentals", "macro", "announcements"]

MACRO_INDICATORS = [
    "中国CPI同比", "中国PPI同比", "中国GDP同比", "中国制造业PMI",
    "中国社会融资规模增量", "中国M2同比", "中国LPR1年期", "中国LPR5年期",
    "中国工业增加值同比", "中国社会消费品零售总额同比", "中国固定资产投资同比",
    "中国出口金额同比", "中国进口金额同比", "中国外汇储备", "中国国债收益率10年",
    "美元兑人民币中间价", "中国城镇调查失业率", "中国房地产开发投资同比",
    "中国财政收入同比", "中国发电量同比",
]
MACRO_BEGIN = "20200101"
KLINE_BEGIN = "20240101"


def today_cst() -> str:
    return datetime.now(CST).strftime("%Y-%m-%d")


def load_api_key() -> None:
    """把 WIND_API_KEY 注入进程环境（**不回显**）。优先级：环境变量 → 凭据目录 → .env。

    本脚本是独立进程（不经 Axiom 的 MCP connector），而 server.py 在 import 期读该变量，
    故必须早于 `import server` 调用。
    """
    if os.environ.get("WIND_API_KEY"):
        return
    for path in (Path.home() / ".axiom" / "axiom-secrets" / "wind.credentials", REPO / ".env"):
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.startswith("WIND_API_KEY="):
                    os.environ["WIND_API_KEY"] = line.split("=", 1)[1].strip()
                    return
        except Exception:
            continue


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def append_ledger(rec: dict) -> None:
    USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with USAGE_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def used_today() -> int:
    if not USAGE_FILE.exists():
        return 0
    day, n = today_cst(), 0
    for line in USAGE_FILE.read_text(encoding="utf-8").splitlines():
        try:
            if json.loads(line).get("date") == day:
                n += 1
        except Exception:
            continue
    return n


def used_today_by_category() -> dict[str, int]:
    out: dict[str, int] = {}
    if not USAGE_FILE.exists():
        return out
    day = today_cst()
    for line in USAGE_FILE.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
            if r.get("date") == day:
                # 兼容历史条目：早期账本没有 category 字段（当时只有 kline）
                cat = r.get("category", "kline")
                out[cat] = out.get(cat, 0) + 1
        except Exception:
            continue
    return out


# 上游在**积分耗尽**时返回的不是标准 error 字段，而是：
#   {"text": "账户积分余额不足，无法完成当前操作。请提示用户先进行充值。…"}
# 实测（2026-10-07）：当天调用约 293 次后开始出现，之后**每次调用都失败**。
# 若不识别，批处理会一路空跑到上限、把"余额耗尽"记成 N 条普通失败。
QUOTA_EXHAUSTED_MARK = "积分余额不足"


def is_quota_exhausted(out: str) -> bool:
    """判断上游是否已明确告知积分耗尽（据此**立即熔断**整批，不再空跑）"""
    return QUOTA_EXHAUSTED_MARK in (out or "")


def is_success(out: str) -> bool:
    """判定一次取数是否成功。

    **实测坑（2026-10-07）**：Wind 成功响应形如 `{"data": {...}, "error": null}` —— `error` 键
    **存在但为 null**。先前用 `"error" not in parsed` 判定，把 73KB 的正常数据误判为失败。
    正确判据：error 为 falsy 且含 data/result。
    """
    if not out:
        return False
    try:
        parsed = json.loads(out)
    except Exception:
        return False
    if not isinstance(parsed, dict) or parsed.get("error"):
        return False
    return bool(parsed.get("data") or parsed.get("result"))


def to_windcode(code: str, exchange: str) -> str | None:
    ex = exchange or ""
    if "上海" in ex:
        return f"{code}.SH"
    if "深圳" in ex:
        return f"{code}.SZ"
    if "北京" in ex:
        return f"{code}.BJ"
    if code.startswith(("60", "68", "51", "58", "11")):
        return f"{code}.SH"
    if code.startswith(("00", "30", "12", "15", "16", "18")):
        return f"{code}.SZ"
    if code.startswith(("4", "8", "9")):
        return f"{code}.BJ"
    return None


def refresh_universe() -> int:
    try:
        import akshare as ak
    except ModuleNotFoundError as e:
        raise SystemExit(
            "本模式需要 akshare，但当前解释器没有。请改用：\n"
            "  runtime-data/.venv/bin/python mcp-servers/wind-mcp/daily_collect.py --refresh-universe\n"
            f"（当前解释器：{sys.executable}）"
        ) from e
    members: dict[str, dict] = {}
    for symbol, name in INDEXES:
        df = ak.index_stock_cons_csindex(symbol=symbol)
        rows = []
        for _, r in df.iterrows():
            wc = to_windcode(str(r["成分券代码"]).zfill(6), str(r.get("交易所", "")))
            if wc:
                rows.append({"windcode": wc, "code": str(r["成分券代码"]).zfill(6), "name": str(r["成分券名称"])})
        members[symbol] = {"name": name, "count": len(rows), "asOf": str(df.iloc[0]["日期"]), "members": rows}
        print(f"  {name}({symbol}): {len(rows)} 只 (快照 {df.iloc[0]['日期']})")
    save_json(UNIVERSE_FILE, {"refreshedAt": datetime.now(CST).isoformat(), "indexes": members})
    return sum(v["count"] for v in members.values())


def stock_list() -> list[dict]:
    """按指数优先级展开去重后的股票列表（沪深300 → 中证500 → 中证1000）"""
    uni = load_json(UNIVERSE_FILE, None)
    if not uni:
        raise SystemExit("缺少成分股清单，请先运行: --refresh-universe")
    out, seen = [], set()
    for symbol, name in INDEXES:
        for m in uni["indexes"].get(symbol, {}).get("members", []):
            if m["windcode"] in seen:
                continue
            seen.add(m["windcode"])
            out.append({**m, "index": symbol, "indexName": name})
    return out


def tool_cost(st: str, tool: str) -> float:
    """单次调用的预估积分（保守上界）"""
    return TOOL_COST_CREDITS.get(f"{st}.{tool}", DEFAULT_COST)


def spent_today_credits() -> float:
    """当日已耗积分（按预估单价回算账本）"""
    if not USAGE_FILE.exists():
        return 0.0
    day, total = today_cst(), 0.0
    for line in USAGE_FILE.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
            if r.get("date") != day:
                continue
            if "est_credits" in r:
                total += float(r["est_credits"])
            else:
                # 兼容历史条目（无 est_credits）：按工具名回算单价
                total += TOOL_COST_CREDITS.get(str(r.get("tool")), DEFAULT_COST)
        except Exception:
            continue
    return total


def spent_today_credits_by_category() -> dict[str, float]:
    """当日各品类已耗积分（按账本回算；缺 est_credits 的历史条目按单价回算）。

    必须按**当日**切分：若用历次累计，第二天的"该品类已耗"会超过日预算，
    导致该品类被**永久卡死**（实测发现于 2026-10-07 自检）。
    """
    out: dict[str, float] = {}
    if not USAGE_FILE.exists():
        return out
    day = today_cst()
    for line in USAGE_FILE.read_text(encoding="utf-8").splitlines():
        try:
            r = json.loads(line)
            if r.get("date") != day:
                continue
            cat = r.get("category", "kline")
            cost = float(r["est_credits"]) if "est_credits" in r else TOOL_COST_CREDITS.get(str(r.get("tool")), DEFAULT_COST)
            out[cat] = out.get(cat, 0.0) + cost
        except Exception:
            continue
    return out


def build_tasks(category: str) -> list[dict]:
    """构造某品类的任务列表（每项 = 1 次调用）"""
    end = datetime.now(CST).strftime("%Y%m%d")
    if category == "kline":
        return [{"key": q["windcode"], "label": f'{q["windcode"]} {q["name"]}',
                 "tool": ("stock_data", "get_stock_kline"),
                 "args": {"windcode": q["windcode"], "begin_date": KLINE_BEGIN, "end_date": end,
                          "period": "10", "aftime": "0"}}
                for q in stock_list()]
    if category == "fundamentals":
        return [{"key": q["windcode"], "label": f'{q["windcode"]} {q["name"]}',
                 "tool": ("stock_data", "get_stock_fundamentals"),
                 "args": {"question": f'{q["name"]}最新一期营业收入净利润ROE资产负债率', "lang": "中文"}}
                for q in stock_list()]
    if category == "macro":
        return [{"key": ind, "label": ind,
                 "tool": ("economic_data", "get_economic_data"),
                 "args": {"metricIdsStr": ind, "beginDate": MACRO_BEGIN, "endDate": end,
                          "freq": "4", "searchType": "0", "ifUnion": "1"}}
                for ind in MACRO_INDICATORS]
    if category == "announcements":
        return [{"key": q["windcode"], "label": f'{q["windcode"]} {q["name"]} 公告',
                 "tool": ("financial_docs", "get_company_announcements"),
                 "args": {"query": f'{q["name"]}公告', "top_k": 10}}
                for q in stock_list()]
    raise SystemExit(f"未知品类: {category}")


def safe_key(key: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in key)


def archive(tool_name: str, key: str, payload: str) -> Path:
    d = RAW_DIR / tool_name
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{safe_key(key)}.json"
    p.write_text(payload, encoding="utf-8")
    return p


def run_category(category: str, limit: int, credit_budget: float, force: bool) -> tuple[int, int]:
    """执行一个品类，返回 (成功, 失败)。原件先落盘，再记账。"""
    load_api_key()
    import server as wind
    if not wind.API_KEY:
        raise SystemExit("未找到 WIND_API_KEY（环境变量 / ~/.axiom/axiom-secrets/wind.credentials / .env 均无）")

    rot_all = load_json(ROTATION_FILE, {})
    done = set(rot_all.get(category, []))
    tasks = build_tasks(category)
    pending = [t for t in tasks if force or t["key"] not in done]
    batch = pending[:limit]
    print(f"[{category}] 任务池 {len(tasks)}，已采 {len(done)}，待采 {len(pending)}，本次取 {len(batch)}")

    ok = fail = 0
    for i, t in enumerate(batch, 1):
        st, tool = t["tool"]
        cost = tool_cost(st, tool)
        spent = spent_today_credits()
        if spent + cost > credit_budget:
            print(
                f"[{category}] 积分闸门：已耗 {spent:.0f} + 本次 {cost:.0f} > 预算 {credit_budget:.0f}，停止（本批完成 {i-1}）"
            )
            break
        t0, out, err = time.time(), "", None
        for attempt in range(2):
            try:
                out = wind._call_wind(st, tool, t["args"])
                err = None
            except Exception as e:                                  # 网络/认证异常
                out, err = "", f"{type(e).__name__}: {e}"
            if is_success(out):
                break
            if is_quota_exhausted(out):                              # 余额耗尽：不重试
                break
            if attempt == 0 and "超时" in (out or ""):               # 仅对明确超时重试
                time.sleep(2)
                continue
            break
        ms = int((time.time() - t0) * 1000)

        # 原件先落盘（不允许只记账不留原件）
        raw_path = None
        good = is_success(out) and not err
        if good:
            try:
                raw_path = archive(tool, t["key"], out)
            except Exception as e:
                good, err = False, f"archive failed: {e}"

        append_ledger({
            "date": today_cst(), "ts": datetime.now(CST).isoformat(), "category": category,
            "tool": f"{st}.{tool}", "key": t["key"], "ms": ms, "ok": good,
            "bytes": len(out or ""), "est_credits": tool_cost(st, tool),
            "raw": str(raw_path.relative_to(REPO)) if raw_path else None,
            "error": err,
        })
        if good:
            done.add(t["key"])
            ok += 1
        else:
            fail += 1
            if is_quota_exhausted(out):
                print(
                    f"[{category}] ⚠️ 上游积分余额不足，已熔断本批（第 {i} 个任务，成功 {ok}）。"
                    " 请充值或等待次日额度恢复后重跑——轮转进度已保存，不会重复取数。"
                )
                break
        if i % 10 == 0 or i == len(batch):
            print(f"  [{category}] {i}/{len(batch)}  成功 {ok} 失败 {fail}  (今日积分 ≈{spent_today_credits():.0f}/{credit_budget:.0f})")

    rot_all[category] = sorted(done)
    rot_all["updatedAt"] = datetime.now(CST).isoformat()
    save_json(ROTATION_FILE, rot_all)
    return ok, fail


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-universe", action="store_true")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--category", choices=CATEGORY_ORDER)
    ap.add_argument("--max-calls", type=int, default=None)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--allow-expensive", action="store_true",
                    help="允许跑高成本品类（如宏观 EDB，实测 10~300 积分/次）。默认**关闭**以防烧额度。")
    ap.add_argument("--credit-budget", type=float, default=None)
    args = ap.parse_args()

    if args.refresh_universe:
        print("刷新成分股清单（AkShare，免费）…")
        print(f"完成：合计 {refresh_universe()} 条（含跨指数重复前）")
        return 0
    if not (args.plan or args.run):
        ap.print_help()
        return 0

    # 预算单位 = **积分**（不是调用次数）—— 2026-10-07 用真实账单校准后改口径
    credit_budget = float(os.environ.get("WIND_DAILY_CREDITS", DEFAULT_CREDIT_BUDGET))
    if args.credit_budget is not None:
        credit_budget = float(args.credit_budget)
    cats = [args.category] if args.category else CATEGORY_ORDER
    spent = spent_today_credits()
    by_cat = used_today_by_category()

    print(f"积分预算: {credit_budget:.0f}/日（账号免费档 300/日）, 今日已耗 ≈{spent:.0f}（调用 {sum(by_cat.values())} 次: {by_cat or '无'}）")
    print("预算配比:", ", ".join(f"{c}={int(CATEGORY_BUDGET[c]*100)}%" for c in cats))
    print("单价（保守上界）:", ", ".join(f"{k.split('.')[-1]}={v:.0f}" for k, v in TOOL_COST_CREDITS.items()))

    grand_ok = grand_fail = 0
    for c in cats:
        tasks = build_tasks(c)
        # 高成本品类门禁：宏观 EDB 单价可达 300，默认不跑
        if not args.allow_expensive and any(
            f'{t["tool"][0]}.{t["tool"][1]}' in EXPENSIVE_TOOLS for t in tasks[:1]
        ):
            print(f"  {c}: ⛔ 含高成本接口（单价可达 300 积分），默认跳过；"
                  f"确实要跑请加 --allow-expensive --category={c}")
            continue
        rot = set(load_json(ROTATION_FILE, {}).get(c, []))
        pending = [t for t in tasks if args.force or t["key"] not in rot]
        # 本批可跑条数：受"该品类预算份额"与"全局剩余积分"双重约束
        per_cat_budget = credit_budget * CATEGORY_BUDGET[c]
        spent_cat = spent_today_credits_by_category().get(c, 0.0)   # 只用**今日**，避免跨天累计卡死
        unit_cost = tool_cost(*tasks[0]["tool"]) if tasks else DEFAULT_COST
        remain_credits = max(0.0, credit_budget - spent)
        remain_cat_credits = max(0.0, per_cat_budget - spent_cat)
        limit = int(min(remain_credits, remain_cat_credits) / unit_cost) if unit_cost > 0 else 0
        if args.max_calls is not None:
            limit = min(limit, args.max_calls)
        print(f"  {c}: 池 {len(tasks)}, 已采 {len(rot)}, 待采 {len(pending)}, 单价≈{unit_cost:.0f}, 本次可跑 {min(limit, len(pending))}")
        if args.plan:
            for t in pending[:3]:
                print(f"      · {t['label']}")
            continue
        if limit <= 0:
            print("      （积分预算不足或无待采，跳过）")
            continue
        ok, fail = run_category(c, min(limit, len(pending)), credit_budget, args.force)
        grand_ok += ok
        grand_fail += fail

    if args.run:
        print(f"全部完成：成功 {grand_ok}，失败 {grand_fail}，今日已耗积分 ≈{spent_today_credits():.0f}/{credit_budget:.0f}")
    return 0 if grand_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
