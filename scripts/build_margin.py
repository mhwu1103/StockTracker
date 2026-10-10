"""融資的時間序列 -> docs/data/margin.json。讀 margin/daily/ 與 close/。

每一天算四個數：
    融資金額（億）      上市、上櫃各自的官方合計
    融資維持率（%）     Σ(各檔融資餘額 × 1000 股 × 當日收盤) ÷ 融資金額。官方沒有公布大盤維持率，
                        市場上流傳的數字都是這樣估的。上市融資成數六成，剛買進時約 166%，
                        跌到 130% 附近開始有追繳、斷頭賣壓
    券資比（%）         融券餘額 ÷ 融資餘額（張）
    融資餘額（張）

原始檔只留兩年（prune_data.py），但這份序列要看長期的位置（例如「融資餘額跌回兩千億」），
所以舊的日子沿用 margin.json 裡已經算好的值，只重算還有原始檔的日子。

    python scripts/build_margin.py
    python scripts/build_margin.py --close-dir <長歷史>/docs/data/close   # 回補時，兩年以前的收盤從這裡讀
"""

from __future__ import annotations

import argparse
from pathlib import Path

import twse

DAILY = twse.DATA_DIR / "margin" / "daily"
OUT = twse.DATA_DIR / "margin.json"
KEYS = ("amt_tw", "amt_tp", "mt_tw", "mt_tp", "mt", "sr", "sh")


def closes(day: str, mk: str, extra: Path | None) -> dict:
    for base in (twse.DATA_DIR / "close", extra):
        if base and (p := base / mk / f"{day}.json").exists():
            return (twse.read_json(p) or {}).get("c") or {}
    return {}


def one(path: Path, extra) -> dict | None:
    x = twse.read_json(path) or {}
    if "tw" not in x or "tp" not in x:
        return None                       # 有一邊還沒抓到，等下一次
    d, s = x["date"], x.get("s", {})
    out = {"amt_tw": round(x["tw"][0] / 1e5, 1), "amt_tp": round(x["tp"][0] / 1e5, 1)}
    val = {}
    for mk, key in (("twse", "tw"), ("tpex", "tp")):
        c = closes(d, mk, extra)
        if not c:
            return None
        val[key] = sum(s[code][0] * 1000 * px for code, px in c.items() if code in s and px)
        amt = x[key][0] * 1000
        out[f"mt_{key}"] = round(val[key] / amt * 100, 1) if amt else None
    amt_all = (x["tw"][0] + x["tp"][0]) * 1000
    out["mt"] = round((val["tw"] + val["tp"]) / amt_all * 100, 1) if amt_all else None
    sh = x["tw"][1] + x["tp"][1]
    out["sr"] = round((x["tw"][2] + x["tp"][2]) / sh * 100, 2) if sh else None
    out["sh"] = sh
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="融資時間序列")
    ap.add_argument("--close-dir", type=Path, help="另一個 close/ 資料夾（回補用）")
    args = ap.parse_args()

    old = twse.read_json(OUT) if OUT.exists() else None
    rows = {}
    if old:
        for i, d in enumerate(old["d"]):
            rows[d] = {k: old[k][i] for k in KEYS}
    n = 0
    for p in sorted(DAILY.glob("*.json")):
        r = one(p, args.close_dir)
        if r:
            rows[p.stem] = r
            n += 1
    days = sorted(rows)
    payload = {"d": days, **{k: [rows[d][k] for d in days] for k in KEYS}}
    changed = twse.write_if_changed(OUT, payload)
    print(f"{len(days)} 天（重算 {n} 天）{'，已更新' if changed else '，沒有變化'}")
    if days:
        last = rows[days[-1]]
        print(f"{days[-1]}：融資 {last['amt_tw'] + last['amt_tp']:,.0f} 億（上市 {last['amt_tw']:,.0f}／上櫃 "
              f"{last['amt_tp']:,.0f}），維持率 {last['mt']}%（上市 {last['mt_tw']}／上櫃 {last['mt_tp']}），"
              f"券資比 {last['sr']}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
