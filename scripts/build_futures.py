"""期貨頁 → docs/data/futpage.json：外資部位與成本、散戶多空比、大額交易人、P/C 比、基差、選擇權關卡。

    python scripts/build_futures.py

指標的算式在 scripts/futures.py（回測 backtest_futures_factors.py 用同一份）。每一個指標附三樣東西：
今天的值、在近一年（250 個交易日）裡的百分位、回測說它有沒有預測力（VERDICT，數字出處在 BACKTEST.md
「期貨籌碼的七個指標」）。沒有預測力的照樣列出來，但頁面上會明講——那是給人看盤面的，不是訊號。

排在 fetch_futures.py 與 fetch_taiex.py 之後。
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import numpy as np

import futures as F
import twse
from gooaye import SITE, load

TPE = timezone(timedelta(hours=8))
SHOW = 250                  # 圖上畫幾個交易日
FAST = 0.2                  # 外資空單「加最快」：近 20 日變化在近一年的百分位低於這個

# 回測（backtest_futures_factors.py、backtest_futures.py）說的話。ok：兩段（2022-07 前後）同方向而且有量級
VERDICT = {
    "net": {"ok": True, "say": "看變化，不看水位：近 20 日外資加多最多的五分之一日子，之後 5 天大盤比加空最多的五分之一多約 0.9 個百分點"
            "（2022-07 前 +0.86、後 +0.96），2019～2026 有 7 年同方向。水位本身前後段方向相反，沒有預測力。"},
    "pnl": {"ok": False, "say": "估算損益高或低，之後 5／20 天大盤都差不多（前後段的差距都不到 0.5 個百分點）。只當參考。"},
    "retail": {"ok": True, "say": "反向指標成立：散戶最偏多的五分之一日子，之後 5 天比最偏空的五分之一少 0.5～1.0 個百分點"
               "（前段 −0.96、後段 −0.52），2020～2026 每一年都同方向；之後 1 天、20 天也同方向。"},
    "large": {"ok": False, "say": "水位前後段方向相反；5 日變化只有 2022-07 以前有效（+2.0），之後只剩 +0.1。"},
    "pc": {"ok": False, "say": "P/C 高的時候之後略好（5 日 +0.25／+0.48 個百分點），方向一致但太小；20 日前段還相反。"},
    "basis": {"ok": False, "say": "正價差大小跟之後漲跌的關係，2022-07 前後方向相反。"},
    "wall": {"ok": False, "say": "不像支撐壓力：收盤在賣權關卡之下的日子（62 天），之後 20 天平均 +4.9%，反而常是反彈；"
             "剛站上買權關卡之後也沒有比較強。樣本少，只當盤面參考。"},
}
WALL_FAR = 0.2              # 關卡離加權指數超過這個比例就不算
HOT = 0.8                   # 散戶多空比在近一年的百分位高於這個＝散戶偏多到前 20%

def r(x, d=0):
    return None if x is None or not np.isfinite(x) else (round(float(x), d) if d else int(round(float(x))))


def main() -> int:
    days, s = F.load()
    tx = load(os.path.join(SITE, "taiex.json")) or {}
    idx = dict(zip(tx.get("d") or [], tx.get("c") or []))
    keep = [i for i, d in enumerate(days) if d in idx]
    if len(keep) < 260:
        print("! 期貨與加權指數重疊不到 260 天，跳過")
        return 0
    days = [days[i] for i in keep]
    s = {k: v[keep] for k, v in s.items()}
    c = np.array([idx[d] for d in days], float)

    # 關卡離指數超過 20% 的（到期前幾天，冷門的深價外履約價偶爾未平倉最大）不算關卡
    far = lambda w: np.where(np.abs(w / c - 1) <= WALL_FAR, w, np.nan)
    s["opt.cw"], s["opt.pw"] = far(s["opt.cw"]), far(s["opt.pw"])
    net = F.foreign_net(s)
    cost, pnl = F.foreign_cost(net, F.fut_price(s))
    retail = F.retail_ratio(s)
    large = F.large_net(s, True)
    pc = s["opt.pco"]
    bpts, bpct = F.basis(s, c)
    net20 = F.change(net, 20)
    fast_rank = F.rolling_rank(net20)

    last = len(days) - 1
    lo = max(0, last - SHOW + 1)

    def pack(key, x, digits=0, extra=None):
        rk = F.rolling_rank(x)
        out = {"now": r(x[last], digits), "rank": r(rk[last] * 100) if np.isfinite(rk[last]) else None,
               "chg5": r(x[last] - x[last - 5], digits) if last >= 5 else None,
               "chg20": r(x[last] - x[last - 20], digits) if last >= 20 else None,
               "series": [r(v, digits) for v in x[lo:]], **VERDICT[key]}
        if extra:
            out.update(extra)
        return out

    out = {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "asof": days[last],
        "d": days[lo:],
        "index": [r(v, 0) for v in c[lo:]],
        "net": pack("net", net, 0, {"fast": bool(fast_rank[last] < FAST), "fastRank": r(fast_rank[last] * 100),
                                    "tx": r(s["tx.fo"][last]), "mtx": r(s["mtx.fo"][last]),
                                    "tr": r(s["tx.tr"][last]), "de": r(s["tx.de"][last])}),
        "pnl": pack("pnl", pnl, 1, {"cost": r(cost[last]), "price": r(F.fut_price(s)[last]),
                                    "costSeries": [r(v) for v in cost[lo:]]}),
        "retail": pack("retail", retail, 1, {"oi": r(s["mkt.mtxoi"][last]),
                                             "hot": bool(np.isfinite(F.rolling_rank(retail)[last])
                                                         and F.rolling_rank(retail)[last] >= HOT)}),
        "large": pack("large", large, 1, {"b10": r(s["lt.pb10"][last]), "s10": r(s["lt.ps10"][last]),
                                          "oi": r(s["lt.oi"][last])}),
        "pc": pack("pc", pc, 1, {"pcv": r(s["opt.pcv"][last], 1)}),
        "basis": pack("basis", bpts, 0, {"pct": r(bpct[last], 2), "fut": r(s["mkt.txc"][last])}),
        "wall": {"cw": r(s["opt.cw"][last]), "pw": r(s["opt.pw"][last]), "cwo": r(s["opt.cwo"][last]),
                 "pwo": r(s["opt.pwo"][last]), "close": r(c[last]),
                 "cwSeries": [r(v) for v in s["opt.cw"][lo:]], "pwSeries": [r(v) for v in s["opt.pw"][lo:]],
                 **VERDICT["wall"]},
        "rules": {"show": SHOW, "fast": int(FAST * 100), "hot": int((1 - HOT) * 100), "win": 250},
    }
    twse.write_if_changed(twse.DATA_DIR / "futpage.json", out)
    n = out["net"]
    print(f"期貨頁 {days[last]}：外資約當大台 {n['now']:+,} 口（近一年第 {n['rank']}%），"
          f"散戶多空比 {out['retail']['now']}%，P/C {out['pc']['now']}%，關卡 {out['wall']['pw']}～{out['wall']['cw']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
