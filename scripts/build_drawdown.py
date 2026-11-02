"""跌深頁 → docs/data/drawdown.json ＋ docs/data/drawdown/<年>.json：每一檔的還原收盤，讓頁面算任一段期間
的最大跌幅。

    python scripts/build_drawdown.py

## 為什麼是頁面自己算

頁面可以選起訖日（結束日預設最新一天），任一段期間的最大回落沒辦法事先算好，所以這裡只存價格，
算在 drawdown.js：

- `drawdown/<年>.json`：那一年每一檔的還原收盤。為了小，存的是對數報酬（萬分之一為單位，帶誤差補償，
  還原回來的價格誤差不到 0.005%）：`{代號: [第一筆在第幾天, 最後一筆在第幾天, 第一筆價格, 差1, 差2, ...]}`，
  中間停牌的日子差是 0（沿用前一天）。價格的基準是**那一年最後一個交易日**，所以過去年份的檔案不會
  因為今天有人除息就整份重寫；換成今天基準的係數放在主檔的 `scale`
- `drawdown.json`：名稱、產業、市場、成交熱門、各年份檔的換算係數、加權指數收盤，與頁面要用的參數

## 算法（drawdown.js）

- 價格：還原除權息的收盤價（gooaye.Prices：除權息表的因子，加上單日差超過 ±20% 的分割、減資），
  停牌日沿用前一天，換成今天的基準
- **最大回落**：期間內先出現的高點，到它之後最低的那一天跌了多少（max drawdown）
- 期間開始時就在交易的才算（第一筆收盤要在前 5 個交易日內）；最後一筆收盤離結束日超過 10 個交易日的
  （長期停牌）跳過

排在 build_history.py 之後（要最新的 close/）。
"""

from __future__ import annotations

import math
import os
from datetime import datetime, timedelta, timezone

import numpy as np

import strategy as S
import twse
from gooaye import SITE, load

TPE = timezone(timedelta(hours=8))
LATE_START = 5      # 第一筆收盤最晚在期間第幾個交易日
STALE = 10          # 最後一筆收盤最多落後幾個交易日
NEW_LOW = 5         # 最低點落在最近幾個交易日內 = 還在破底
UNIT = 1e4          # 對數報酬的單位：萬分之一


def sig(x, n=6):
    """留 n 位有效數字。"""
    return float(f"{x:.{n}g}")


def encode(v):
    """一段沒有 NaN 的價格 → [第一筆價格, 差1, 差2, ...]，差帶誤差補償，不會越累積越偏。"""
    p0 = sig(float(v[0]))
    out, acc = [p0], math.log(p0)
    for x in v[1:]:
        q = round((math.log(float(x)) - acc) * UNIT)
        acc += q / UNIT
        out.append(q)
    return out


def main() -> int:
    D = S.Data([SITE])
    dates, last = D.dates, D.T - 1
    asof = dates[last]
    info = load(os.path.join(SITE, "industry.json")) or {}
    ind, names = info.get("map") or {}, info.get("names") or {}
    twse_codes = set()
    tw = sorted(p for p in os.listdir(os.path.join(SITE, "close", "twse")) if p.endswith(".json"))
    if tw:
        twse_codes = set((load(os.path.join(SITE, "close", "twse", tw[-1])) or {}).get("c", {}))

    years = sorted({d[:4] for d in dates})
    scale, sizes = {}, {}
    out_dir = twse.DATA_DIR / "drawdown"
    out_dir.mkdir(exist_ok=True)
    for y in years:
        idx = [i for i, d in enumerate(dates) if d[:4] == y]
        a, b = idx[0], idx[-1]
        series, sc = {}, {}
        for c, k in D.ci.items():
            real = np.nonzero(np.isfinite(D.AC[a:b + 1, k]))[0]
            if not len(real):
                continue
            s, e = int(real[0]), int(real[-1])
            cum = D.P.cum[c]
            v = D.ACf[a + s:a + e + 1, k] * cum[b]           # 那一年最後一天的基準
            series[c] = [s, e] + encode(v)
            f = cum[last] / cum[b]
            if abs(f - 1) > 1e-7:
                sc[c] = sig(f, 7)
        payload = {"year": y, "dates": dates[a:b + 1], "s": series}
        twse.write_if_changed(out_dir / f"{y}.json", payload)
        sizes[y] = len(series)
        scale[y] = sc
    # 資料修剪掉的年份，檔案也一起刪
    for p in out_dir.glob("*.json"):
        if p.stem not in years:
            p.unlink()

    meta = {c: [names.get(c) or D.names.get(c) or c, ind.get(c) or "", "上市" if c in twse_codes else "上櫃",
                1 if D.LIQ[last, k] else 0] for c, k in D.ci.items()}
    tx = load(os.path.join(SITE, "taiex.json")) or {}
    pairs = [(d, x) for d, x in zip(tx.get("d", []), tx.get("c", [])) if dates[0] <= d <= asof and x]

    out = {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "asof": asof, "first": dates[0], "years": years, "unit": UNIT,
        "lateStart": LATE_START, "stale": STALE, "newLow": NEW_LOW,
        "meta": meta, "scale": scale,
        "taiex": {"d": [d for d, _ in pairs], "c": [x for _, x in pairs]},
    }
    twse.write_if_changed(twse.DATA_DIR / "drawdown.json", out)
    print(f"跌深：{dates[0]} ～ {asof}，" + "、".join(f"{y} 年 {n} 檔" for y, n in sizes.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
