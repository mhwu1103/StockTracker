"""跌深頁 → docs/data/drawdown.json：今年每一檔股票從高點到之後低點的最大跌幅。

    python scripts/build_drawdown.py

## 算法

- 範圍：最後一個交易日所在的那一年（1 月第一個交易日起），上市與上櫃的普通股（strategy.common）
- 價格：還原除權息的收盤價（gooaye.Prices：除權息表的因子，加上單日差超過 ±20% 的分割、減資），
  停牌日沿用前一天。頁面上的價格換算成「今天的基準」，所以現價就是最後一天的原始收盤
- **最大回落**：今年先出現的高點，到它之後最低的那一天，跌了多少（max drawdown）。這是「高點買進、
  抱到最低」最慘會賠多少，跟「現在離高點多遠」不一樣——後者另外一欄
- 年初就在交易的才算（第一筆收盤要在今年前 5 個交易日內），今年才上市的跳過；最後一筆收盤離最後
  一個交易日超過 10 個交易日的（長期停牌）也跳過

只存最大回落超過 25% 的，檔案才不會太大；加權指數另外算一份當對照。

排在 build_history.py 之後（要最新的 close/）。
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import numpy as np

import strategy as S
import twse
from gooaye import SITE, dated_files, load

TPE = timezone(timedelta(hours=8))
KEEP = -0.25        # 最大回落超過這個才存
LATE_START = 5      # 第一筆收盤最晚在今年第幾個交易日
STALE = 10          # 最後一筆收盤最多落後幾個交易日
NEW_LOW = 5         # 今年最低點落在最近幾個交易日內 = 還在破底
COLS = ["c", "n", "ind", "mk", "hd", "hp", "ld", "lp", "dd", "pd", "pp", "cl", "cur", "reb", "ytd", "liq"]


def r1(x):
    return round(float(x) * 100, 1)


def px(x):
    x = float(x)
    return round(x, 2) if x < 100 else round(x, 1) if x < 1000 else round(x)


def drawdown(v):
    """v 是一段沒有 NaN 的價格；回傳 (最大回落, 高點位置, 低點位置)。"""
    run = np.maximum.accumulate(v)
    dd = v / run - 1
    lo = int(np.argmin(dd))
    hi = int(np.argmax(v[:lo + 1]))
    return float(dd[lo]), hi, lo


def main() -> int:
    D = S.Data([SITE])
    dates, last = D.dates, D.T - 1
    asof = dates[last]
    year = asof[:4]
    i0 = next(i for i, d in enumerate(dates) if d[:4] == year)
    ind = (load(os.path.join(SITE, "industry.json")) or {}).get("map") or {}
    names = (load(os.path.join(SITE, "industry.json")) or {}).get("names") or {}
    tw = dated_files("close/twse", [SITE])
    twse_codes = set((load(tw[max(tw)]) or {}).get("c", {})) if tw else set()

    AC, ACf = D.AC, D.ACf
    rows, skipped = [], 0
    for c, k in D.ci.items():
        real = np.nonzero(np.isfinite(AC[i0:, k]))[0]
        if not len(real) or real[0] >= LATE_START or (last - i0) - real[-1] > STALE:
            skipped += 1
            continue
        v = ACf[i0 + real[0]:last + 1, k]
        base = i0 + real[0]
        dd, hi, lo = drawdown(v)
        if dd > KEEP:
            continue
        scale = D.RCf[last, k] / ACf[last, k]          # 換成今天的基準
        pk = int(np.argmax(v))
        rows.append([
            c, names.get(c) or D.names.get(c) or c, ind.get(c) or "", "上市" if c in twse_codes else "上櫃",
            dates[base + hi], px(v[hi] * scale), dates[base + lo], px(v[lo] * scale), r1(dd),
            dates[base + pk], px(v[pk] * scale), px(D.RCf[last, k]),
            r1(v[-1] / v[pk] - 1), r1(v[-1] / v[lo] - 1), r1(v[-1] / v[0] - 1),
            1 if D.LIQ[last, k] else 0,
        ])
    rows.sort(key=lambda r: r[8])

    # 加權指數當對照
    tx = load(os.path.join(SITE, "taiex.json")) or {}
    pairs = [(d, x) for d, x in zip(tx.get("d", []), tx.get("c", [])) if d[:4] == year and d <= asof and x]
    taiex = None
    if pairs:
        v = np.array([x for _, x in pairs], float)
        dd, hi, lo = drawdown(v)
        pk = int(np.argmax(v))
        taiex = {"hd": pairs[hi][0], "hp": round(v[hi], 2), "ld": pairs[lo][0], "lp": round(v[lo], 2), "dd": r1(dd),
                 "pd": pairs[pk][0], "pp": round(v[pk], 2), "cl": round(v[-1], 2), "cur": r1(v[-1] / v[pk] - 1),
                 "ytd": r1(v[-1] / v[0] - 1), "d": pairs[-1][0]}

    n_all = D.N - skipped
    dds = np.array([r[8] for r in rows])
    out = {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "asof": asof, "year": year, "from": dates[i0], "keep": r1(KEEP), "newLow": NEW_LOW,
        "lowSince": dates[max(i0, last - NEW_LOW + 1)],
        "count": {"all": int(n_all), "kept": len(rows),
                  "d30": int((dds <= -30).sum()), "d50": int((dds <= -50).sum()), "d70": int((dds <= -70).sum())},
        "taiex": taiex,
        "cols": COLS, "rows": rows,
    }
    twse.write_if_changed(twse.DATA_DIR / "drawdown.json", out)
    print(f"跌深：{year} 年（{dates[i0]} ～ {asof}）{n_all} 檔，最大回落超過 30% 的 {out['count']['d30']} 檔、"
          f"超過 50% 的 {out['count']['d50']} 檔；最深 {rows[0][0]} {rows[0][1]} {rows[0][8]}%" if rows else "跌深：沒有資料")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
