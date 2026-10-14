"""族群法人資金四象限 -> docs/data/sector_flow.json（「資金 → 動向」分頁）。

算法在 sector_flow.py，跟 backtest_sector_flow.py 是同一份。只留最近 KEEP 個交易日，
夠畫回放就好；每天整份重寫。

## 這是描述，不是訊號

回測（BACKTEST.md 2026-10-15）：同一天「加碼 − 減碼」的族，之後 20 日只多 +0.26%
（官方產業，t 2.4，2022 空頭歸零），比一趟來回成本還小；縱軸（加速／收手）沒有資訊，
「剛進加碼」反而比剛進減碼差。所以畫面上只講「錢這週往哪裡跑」，不講「該買哪一族」。

檔案格式：
    days    交易日（舊 → 新）
    groups  {industry|theme|sub: [{name, n, pts: {三大|外資|投信: [[近5日淨買賣, 日均差, 20日量] | null, …]}}]}
            單位都是億：近 5 日淨買賣加總；日均差＝近 5 日日均 − 近 20 日日均（億/天）；
            20 日量＝近 20 日每天 |淨買賣| 的加總（泡泡大小）。
            pts 的每一格對應 days 的同一格；那一天算不出來（前 20 天缺檔、整族沒有法人買賣）是 null

畫面直接畫金額（對數式刻度），回測用的是除以 20 日量之後的比例。兩者的正負號完全一樣
（除的是正數），所以落在哪個象限不受影響，回測結論照樣適用。

用法：
    python scripts/build_sector_flow.py
"""

from __future__ import annotations

import glob
import json
import os
import sys
from datetime import datetime

import twse
from sector_flow import WHO, amounts, coords, groups

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
OUT = os.path.join(DATA, "sector_flow.json")
KEEP = 60
VERSION = 2


def load(p):
    with open(p, encoding="utf8") as f:
        return json.load(f)


def main() -> int:
    dates = load(os.path.join(DATA, "index.json"))["dates"]
    di = {d: i for i, d in enumerate(dates)}
    flow = {k: {} for k in WHO}
    for p in sorted(glob.glob(os.path.join(DATA, "insti", "daily", "*.json"))):
        d = os.path.basename(p)[:-5]
        if d in di:
            for k, v in amounts(load(p)).items():
                flow[k][di[d]] = v
    have = sorted(flow["三大"])
    if len(have) < 20:
        print(f"法人日檔只有 {len(have)} 天，湊不滿 20 天，不寫檔", file=sys.stderr)
        return 1

    themes = load(os.path.join(DATA, "themes.json"))["groups"]
    G = groups(load(os.path.join(DATA, "industry.json"))["map"], themes)
    keep = have[-KEEP:]
    out_groups = {}
    for mode, members in G.items():
        xy = {k: coords(flow[k], members) for k in WHO}
        rows = []
        for g, cs in members.items():
            pts = {}
            for k in WHO:
                s = xy[k].get(g, {})
                # Y 是 (日均差 ÷ 尺度日均)，乘回尺度日均就是億/天
                pts[k] = [[round(s[i][2] / 1e8, 2), round(s[i][1] * s[i][3] / 20 / 1e8, 3), round(s[i][3] / 1e8, 1)]
                          if i in s else None for i in keep]
            if any(p for v in pts.values() for p in v):
                rows.append({"name": g, "n": len(cs), "pts": pts})
        out_groups[mode] = rows

    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "v": VERSION,
        "days": [dates[i] for i in keep],
        "groups": out_groups,
    }
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"寫入 {OUT}：{payload['days'][0]} ~ {payload['days'][-1]}，"
          + "、".join(f"{m} {len(r)} 族" for m, r in out_groups.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
