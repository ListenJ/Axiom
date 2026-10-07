#!/usr/bin/env python3
"""
Wind 每日增量采集（2026-10-07）

用户裁定：**指数成分优先**（沪深300 → 中证500 → 中证1000），额度为 300 次/日（另有 2300 积分池）。

## 分工（实测依据）
- **成分股清单走 AkShare（免费）**：`index_stock_cons_csindex` 实测 1.1 秒返回 300 只，不耗 Wind 额度。
- **行情/财务走 Wind**：实测单次 0.6 秒且数据权威，故由 Wind 承担日常增量；AkShare 只作免费兜底。

## 三条硬性质
1. **额度硬闸**：每次调用前先查当日用量，达到 `WIND_DAILY_CAP`（默认 270，留 30 次余量应对临时查询）立即停止，不越界。
2. **可审计**：每 1 次调用写一行 `data/wind-usage.jsonl`（时间/工具/标的/耗时/成败/字节数）；原件另存 `data/raw/quant/wind/`。
3. **可续跑**：轮转进度记在 `data/wind-rotation.json`，中断/跨天都能接着来，不重复取已有标的（`--force` 可重取）。

## 用法
    python daily_collect.py --refresh-universe   # 刷新成分股清单（AkShare，0 额度）
    python daily_collect.py --plan               # 打印今日计划与预计消耗（0 调用）
    python daily_collect.py --run                # 执行（受日上限约束）
    python daily_collect.py --run --max-calls=20 # 小批试跑
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
# 指数 → Windcode 后缀按交易所推断；三个宽基指数按用户裁定的优先级
INDEXES = [("000300", "沪深300"), ("000905", "中证500"), ("000852", "中证1000")]
KLINE_BEGIN = "20240101"


def load_api_key() -> None:
    """把 WIND_API_KEY 注入进程环境（**不回显**）。

    优先级：已有环境变量 → 本地凭据目录（权威副本）→ 仓库 .env。
    本脚本是独立进程（不经 Axiom 的 MCP connector），故需自己装载；
    server.py 在 import 时读取该变量，所以必须在 `import server` 之前调用。
    """
    if os.environ.get("WIND_API_KEY"):
        return
    cred = Path.home() / ".axiom" / "axiom-secrets" / "wind.credentials"
    candidates = [cred, REPO / ".env"]
    for path in candidates:
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.startswith("WIND_API_KEY="):
                    os.environ["WIND_API_KEY"] = line.split("=", 1)[1].strip()
                    return
        except Exception:
            continue


def today_cst() -> str:
    return datetime.now(CST).strftime("%Y-%m-%d")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def used_today() -> int:
    """当日已用次数（按 CST 日期过滤账本）"""
    if not USAGE_FILE.exists():
        return 0
    day = today_cst()
    n = 0
    for line in USAGE_FILE.read_text(encoding="utf-8").splitlines():
        try:
            if json.loads(line).get("date") == day:
                n += 1
        except Exception:
            continue
    return n


def to_windcode(code: str, exchange: str) -> str | None:
    """AkShare 的 6 位代码 + 交易所名 → Wind 代码（600519.SH / 000001.SZ / 8xxxxx.BJ）"""
    ex = exchange or ""
    if "上海" in ex:
        return f"{code}.SH"
    if "深圳" in ex:
        return f"{code}.SZ"
    if "北京" in ex:
        return f"{code}.BJ"
    # 交易所缺失时按代码段兜底推断
    if code.startswith(("60", "68", "51", "58", "11")):
        return f"{code}.SH"
    if code.startswith(("00", "30", "12", "15", "16", "18")):
        return f"{code}.SZ"
    if code.startswith(("4", "8", "9")):
        return f"{code}.BJ"
    return None


def refresh_universe() -> int:
    """用 AkShare 拉三大指数成分股（免费，不占 Wind 额度）"""
    # akshare 装在 runtime-data/.venv（与 Wind 的 venv 刻意隔离：akshare-mcp 要 mcp>=2，
    # 而本目录 server.py 要 mcp<2 —— 两个 SDK 大版本互斥，见 config/mcp-servers.yaml 注释）。
    # 故 --refresh-universe 必须用 runtime-data 的解释器跑：
    #   runtime-data/.venv/bin/python mcp-servers/wind-mcp/daily_collect.py --refresh-universe
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


def build_queue() -> list[dict]:
    """按指数优先级展开待采集队列（已轮转过的跳过，除非 --force）"""
    uni = load_json(UNIVERSE_FILE, None)
    if not uni:
        print("缺少成分股清单，请先运行: --refresh-universe", file=sys.stderr)
        sys.exit(2)
    rot = load_json(ROTATION_FILE, {"done": []})
    done = set(rot.get("done", []))
    queue: list[dict] = []
    seen: set[str] = set()
    for symbol, name in INDEXES:                       # 指数优先级即顺序
        for m in uni["indexes"].get(symbol, {}).get("members", []):
            wc = m["windcode"]
            if wc in seen:
                continue                                   # 跨指数去重（沪深300 ⊂ 中证800）
            seen.add(wc)
            queue.append({**m, "index": symbol, "indexName": name, "done": wc in done})
    return queue


def is_success(out: str) -> bool:
    """判定一次取数是否成功。

    **实测坑（2026-10-07）**：Wind 的成功响应形如 `{"data": {...}, "error": null}` ——
    `error` 键**存在**但值为 `null`。先前用 `"error" not in parsed` 判定，
    把 73KB 的正常数据误判为失败。正确判据是"error 为 falsy 且有 data/result"。
    """
    if not out:
        return False
    try:
        parsed = json.loads(out)
    except Exception:
        return False
    if not isinstance(parsed, dict):
        return False
    if parsed.get("error"):
        return False
    return bool(parsed.get("data") or parsed.get("result"))


def archive(tool: str, key: str, payload: str) -> Path:
    d = RAW_DIR / tool
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{key}.json"
    p.write_text(payload, encoding="utf-8")
    return p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-universe", action="store_true")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--max-calls", type=int, default=None)
    ap.add_argument("--force", action="store_true", help="忽略轮转进度，重取全部")
    args = ap.parse_args()

    if args.refresh_universe:
        print("刷新成分股清单（AkShare，免费）…")
        total = refresh_universe()
        print(f"完成：合计 {total} 条（含跨指数重复前）")
        return 0

    if not (args.plan or args.run):
        ap.print_help()
        return 0

    cap = int(os.environ.get("WIND_DAILY_CAP", DEFAULT_CAP))
    used = used_today()
    remain = max(0, cap - used)
    limit = remain if args.max_calls is None else min(args.max_calls, remain)

    queue = build_queue()
    pending = [q for q in queue if args.force or not q["done"]]
    print(f"额度: 上限 {cap}/日, 今日已用 {used}, 剩余 {remain} | 本次计划 {min(limit, len(pending))} 次")
    print(f"队列: 总计 {len(queue)} 只, 已采 {len(queue) - len(pending)}, 待采 {len(pending)}")
    per_index = {name: sum(1 for q in pending if q["indexName"] == name) for _, name in INDEXES}
    print("待采分布:", ", ".join(f"{k}={v}" for k, v in per_index.items()))
    if limit <= 0:
        print("额度已用尽或无待采标的，退出（0 次调用）。")
        return 0

    batch = pending[:limit]
    if args.plan:
        print("\n本次将采集（前 10 只示意）:")
        for q in batch[:10]:
            print(f"  {q['windcode']}  {q['name']}  [{q['indexName']}]")
        print(f"… 共 {len(batch)} 只；预计消耗 {len(batch)} 次额度")
        return 0

    # ── 执行 ────────────────────────────────────────────────────────────────
    load_api_key()          # 必须早于 import server（server 在 import 期读该变量）
    import server as wind   # 复用已验证的 Wind 客户端（含 Bearer 认证与重试）
    if not wind.API_KEY:
        raise SystemExit("未找到 WIND_API_KEY（环境变量 / ~/.axiom/axiom-secrets/wind.credentials / .env 均无）")
    rot = load_json(ROTATION_FILE, {"done": []})
    done = set(rot.get("done", []))
    end_date = datetime.now(CST).strftime("%Y%m%d")
    ok = fail = 0
    USD = USAGE_FILE.parent
    USD.mkdir(parents=True, exist_ok=True)

    for i, q in enumerate(batch, 1):
        if used_today() >= cap:
            print(f"达到日上限 {cap}，停止（已完成 {i-1} 只）。")
            break
        t0 = time.time()
        out, err = "", None
        # 上游偶发超时（实测 {"error": "Wind stock_data 请求超时"}），
        # 仅对这类**明确未取到数据**的错误重试 1 次；其它错误不重试（避免无谓额度消耗）。
        for attempt in range(2):
            try:
                out = wind._call_wind("stock_data", "get_stock_kline", {
                    "windcode": q["windcode"], "begin_date": KLINE_BEGIN, "end_date": end_date,
                    "period": "10", "aftime": "0",
                })
                err = None
            except Exception as e:                                # 网络/认证异常
                out, err = "", f"{type(e).__name__}: {e}"
            if is_success(out):
                break
            if attempt == 0 and "超时" in (out or ""):
                time.sleep(2)
                continue
            break
        ms = int((time.time() - t0) * 1000)
        good = is_success(out) and not err
        if good:
            archive("stock_kline", q["windcode"], out)
            done.add(q["windcode"])
            ok += 1
        else:
            fail += 1

        with USAGE_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "date": today_cst(), "ts": datetime.now(CST).isoformat(),
                "tool": "stock_data.get_stock_kline", "windcode": q["windcode"],
                "ms": ms, "ok": good, "bytes": len(out or ""), "error": err,
            }, ensure_ascii=False) + "\n")

        if i % 20 == 0 or i == len(batch):
            print(f"  进度 {i}/{len(batch)}  成功 {ok} 失败 {fail}  (已用 {used_today()}/{cap})")

    save_json(ROTATION_FILE, {"done": sorted(done), "updatedAt": datetime.now(CST).isoformat()})
    print(f"完成：成功 {ok}，失败 {fail}，今日累计用量 {used_today()}/{cap}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
