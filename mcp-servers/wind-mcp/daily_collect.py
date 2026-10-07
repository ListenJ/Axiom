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
1. **额度硬闸**：每次调用前查当日用量，达 `WIND_DAILY_CAP`（默认 270，账号实际 300，留 30 余量）即停。
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
DEFAULT_CAP = 270
INDEXES = [("000300", "沪深300"), ("000905", "中证500"), ("000852", "中证1000")]

CATEGORY_BUDGET: dict[str, float] = {
    "kline": 0.60,
    "fundamentals": 0.20,
    "macro": 0.15,
    "announcements": 0.05,
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


def run_category(category: str, limit: int, cap: int, force: bool) -> tuple[int, int]:
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
        if used_today() >= cap:
            print(f"[{category}] 达到日上限 {cap}，停止（本批已完成 {i-1}）")
            break
        st, tool = t["tool"]
        t0, out, err = time.time(), "", None
        for attempt in range(2):
            try:
                out = wind._call_wind(st, tool, t["args"])
                err = None
            except Exception as e:                                  # 网络/认证异常
                out, err = "", f"{type(e).__name__}: {e}"
            if is_success(out):
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
            "bytes": len(out or ""), "raw": str(raw_path.relative_to(REPO)) if raw_path else None,
            "error": err,
        })
        if good:
            done.add(t["key"])
            ok += 1
        else:
            fail += 1
        if i % 10 == 0 or i == len(batch):
            print(f"  [{category}] {i}/{len(batch)}  成功 {ok} 失败 {fail}  (今日 {used_today()}/{cap})")

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
    args = ap.parse_args()

    if args.refresh_universe:
        print("刷新成分股清单（AkShare，免费）…")
        print(f"完成：合计 {refresh_universe()} 条（含跨指数重复前）")
        return 0
    if not (args.plan or args.run):
        ap.print_help()
        return 0

    cap = int(os.environ.get("WIND_DAILY_CAP", DEFAULT_CAP))
    cats = [args.category] if args.category else CATEGORY_ORDER
    total_used = used_today()
    by_cat = used_today_by_category()

    # 各品类今日配额（按配比切分 cap）
    quota = {c: (args.max_calls if args.category and args.max_calls else max(0, round(cap * CATEGORY_BUDGET[c]))) for c in cats}
    print(f"额度: 账号 300/日, 脚本上限 {cap}, 今日已用 {total_used}（{by_cat or '无'}）")
    print("预算配比:", ", ".join(f"{c}={int(CATEGORY_BUDGET[c]*100)}%" for c in cats))

    grand_ok = grand_fail = 0
    for c in cats:
        remain_total = max(0, cap - used_today())
        remain_cat = max(0, quota[c] - by_cat.get(c, 0))
        limit = min(remain_total, remain_cat)
        tasks = build_tasks(c)
        rot = set(load_json(ROTATION_FILE, {}).get(c, []))
        pending = [t for t in tasks if args.force or t["key"] not in rot]
        print(f"  {c}: 池 {len(tasks)}, 已采 {len(rot)}, 待采 {len(pending)}, 今日配额 {quota[c]}, 本次可跑 {min(limit, len(pending))}")
        if args.plan:
            for t in pending[:3]:
                print(f"      · {t['label']}")
            continue
        if limit <= 0:
            print(f"      （配额用尽或无待采，跳过）")
            continue
        ok, fail = run_category(c, min(limit, len(pending)), cap, args.force)
        grand_ok += ok
        grand_fail += fail

    if args.run:
        print(f"全部完成：成功 {grand_ok}，失败 {grand_fail}，今日累计 {used_today()}/{cap}")
    return 0 if grand_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
