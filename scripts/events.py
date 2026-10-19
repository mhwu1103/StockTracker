"""公告事件（events/，fetch_events.py 抓的）的共用規則：回測（backtest_events.py）與頁面（build_events.py）用同一套。

- 財報同一家同一個報導期間只算第一則（更正、會計師核閱後再公告的不算）
- 方向用**單季**歸屬母公司淨利跟去年同季比：累計數減掉同一年上一季的累計數，Q1 就是累計數本身
- 進場是公告之後的第一個開盤；反應＝進場開盤 ÷ 公告前最後一個收盤 − 1
- 訊號（回測見 BACKTEST.md「財報、自結與法說會」）：
  好＝年增 ≥ 30% 或轉盈，而且反應 ≥ +2%；壞＝年減 > 30% 或轉虧，而且反應 ≤ −2%；抱 20 個交易日
"""

from __future__ import annotations

import bisect
import glob
import json
import os

GROW = 0.3          # 單季淨利年增門檻
REACT = 0.02        # 開盤反應門檻
HOLD = 20           # 抱幾個交易日
CONF_LOOK = 60      # 法說會公告最早可以在召開前幾天


def load_news(site: str) -> list:
    rows = []
    for p in sorted(glob.glob(os.path.join(site, "events", "[0-9]*.json"))):
        with open(p, encoding="utf-8") as f:
            rows += json.load(f)
    return rows


def load_conf(site: str) -> list:
    """[[代號, 召開日, 迄日, 時間, 擇要], ...]，同一家同一天只留一筆。"""
    out, seen = [], set()
    for p in sorted(glob.glob(os.path.join(site, "events", "conf_*.json"))):
        with open(p, encoding="utf-8") as f:
            for r in json.load(f):
                if (r[0], r[1]) not in seen:
                    seen.add((r[0], r[1]))
                    out.append(r)
    return out


def host(note: str) -> str:
    """券商論壇、投資人會議（別人辦的）算受邀；擇要訊息沒提到這些的算自辦。"""
    return "受邀" if any(k in note for k in ("受邀", "邀請", "主辦", "舉辦", "論壇")) else "自辦"


def first_fin(rows: list) -> dict:
    """{(代號, 期初, 期末): (公告日, 時間, 數字)}，每期只留最早的一則。"""
    first = {}
    for d, tm, code, kind, subj, x in rows:
        if kind != "fin" or not x or not x.get("p") or not x["p"][0] or not x["p"][1]:
            continue
        key = (code, x["p"][0], x["p"][1])
        if key not in first or (d, tm) < first[key][:2]:
            first[key] = (d, tm, x)
    return first


def quarterly(first: dict) -> dict:
    """{(代號, 年, 期末月): 單季歸屬母公司淨利}，只算年初起算、期末是季底的。"""
    ytd = {(c, p1[:4], p1[5:7]): x["ni"] for (c, p0, p1), (_, _, x) in first.items()
           if p0[5:] == "01-01" and x.get("ni") is not None}
    out = {}
    for (c, y, m), v in ytd.items():
        if m == "03":
            out[(c, y, m)] = v
        elif m in ("06", "09", "12"):
            prev = ytd.get((c, y, f"{int(m) - 3:02d}"))
            if prev is not None:
                out[(c, y, m)] = v - prev
    return out


def growth(q: dict, code: str, p1: str):
    """單季淨利跟去年同季比：小數（0.3 = +30%）、"轉盈"、"轉虧"、"續虧"，沒得比是 None。"""
    a, b = q.get((code, p1[:4], p1[5:7])), q.get((code, str(int(p1[:4]) - 1), p1[5:7]))
    if a is None or b is None:
        return None
    if a < 0 <= b:
        return "轉虧"
    if a > 0 >= b:
        return "轉盈"
    if a <= 0 and b <= 0:
        return "續虧"
    return a / b - 1


def is_good(g) -> bool:
    return g == "轉盈" or isinstance(g, float) and g >= GROW


def is_bad(g) -> bool:
    return g == "轉虧" or isinstance(g, float) and g < -GROW


def signal(g, react):
    if react is None:
        return None
    if is_good(g) and react >= REACT:
        return "good"
    if is_bad(g) and react <= -REACT:
        return "bad"
    return None


def entry(dates: list, d: str, tm: str):
    """(訊號日 s, 公告前最後一個收盤 k)：s+1 開盤進場。dates 是交易日清單；超出範圍回 None。
    盤後（13:30 起）公告：隔天開盤進；盤中：也是隔天（保守）；盤前或假日：當天（下一個交易日）開盤就進。"""
    i0 = bisect.bisect_left(dates, d)
    if i0 < len(dates) and dates[i0] == d and tm >= "13:30":
        return i0, i0
    if i0 < len(dates) and dates[i0] == d and tm >= "09:00":
        return i0, i0 - 1
    return i0 - 1, i0 - 1
