"""營收頁的「公告」分頁 → docs/data/events/page.json：財報訊號、法說會日曆。

    python scripts/build_events.py

回答的問題：**這陣子誰公布了財報、是好是壞、市場怎麼反應？接下來誰要開法說會？**

- **財報**：最近 RECENT 個交易日內進場的每一則（公告之後的第一個開盤）。單季淨利年增、開盤反應、
  進場後的漲跌（算到第 20 個交易日為止，還沒滿就是最新收盤）都在這裡算；規則與門檻在 events.py，跟回測同一套
  - 好＝年增 ≥ 30% 或轉盈、反應 ≥ +2%；壞＝年減 > 30% 或轉虧、反應 ≤ −2%。抱 20 個交易日
  - 還沒到進場日的（今天盤後才公告）反應是 null，前端標「明天開盤」
- **法說會**：召開日在 PAST 天前到 AHEAD 天後的。公告日是重大訊息裡召開前 60 天內最早的一則法說會公告；
  **會前**＝公告隔天開盤 → 召開日收盤（還沒開就是最新收盤）。回測只有會前這一段有東西，會後沒有

股價用網站的 close/（兩年），還原除權息。排在 fetch_events.py 與 build_history.py 之後。
"""

from __future__ import annotations

import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import events as E
from gooaye import SITE, Prices, common, load
import twse

TPE = timezone(timedelta(hours=8))
OUT = twse.DATA_DIR / "events" / "page.json"
RECENT = 60         # 財報列最近幾個交易日進場的（兩季之間也看得到上一季的結果）
PAST, AHEAD = 7, 45  # 法說會日曆的範圍（日曆日）


def r1(x):
    return None if x is None else round(x * 100, 1)


def main() -> int:
    rows = E.load_news(SITE)
    if not rows:
        print("! 沒有 events/，跳過")
        return 0
    P = Prices([SITE])
    dates, last = P.dates, P.N - 1
    names = (load(os.path.join(SITE, "industry.json")) or {}).get("names") or {}

    def px(code, i, kind="c"):
        """還原後的開盤（o）或收盤（c）；收盤沒有就往前找最近的。"""
        cu = P.cum.get(code)
        if not cu:
            return None
        if kind == "o":
            v = P.O[code].get(i)
            return v / cu[i] if v else None
        while i >= 0:
            v = P.C[code].get(i)
            if v:
                return v / cu[i]
            i -= 1
        return None

    def quarter(p0, p1):
        if p1[5:7] == "12" and p0[5:] == "01-01":
            return f"{p1[:4]} Q4"
        return f"{p1[:4]} Q{(int(p1[5:7]) + 2) // 3}"

    # ---- 財報
    first = E.first_fin(rows)
    qn = E.quarterly(first)
    fin = []
    for (code, p0, p1), (d, tm, x) in first.items():
        if not common(code) or p0[5:] != "01-01" or p1[5:7] not in ("03", "06", "09", "12"):
            continue
        s, k = E.entry(dates, d, tm)
        if s < last - RECENT or k < 0:
            continue
        g = E.growth(qn, code, p1)
        react = ret = None
        held = 0
        if s + 1 <= last:                       # 已經進場
            o, b = px(code, s + 1, "o"), px(code, k)
            if o and b:
                react = o / b - 1
                ret = px(code, min(last, s + E.HOLD)) / o - 1
            held = last - s
        sig = E.signal(g, react)
        fin.append({k2: v for k2, v in {
            "c": code, "n": names.get(code, code), "d": d, "t": tm, "q": quarter(p0, p1),
            "g": g if isinstance(g, str) else r1(g), "eps": x.get("eps"),
            "react": r1(react), "ret": r1(ret), "held": held, "sig": sig,
        }.items() if v is not None})
    fin.sort(key=lambda r: (r["d"], r["t"]), reverse=True)

    # ---- 法說會
    today = twse.taipei_today()
    lo, hi = (today - timedelta(days=PAST)).isoformat(), (today + timedelta(days=AHEAD)).isoformat()
    ann = defaultdict(list)
    for d, tm, code, kind, subj, x in rows:
        if kind == "conf":
            ann[code].append(d)
    conf = []
    for code, start, end, tm, note in E.load_conf(SITE):
        if not common(code) or not lo <= start <= hi:
            continue
        a = [x for x in ann.get(code, []) if x <= start
             and (datetime.fromisoformat(start) - datetime.fromisoformat(x)).days <= E.CONF_LOOK]
        pre = None
        if a:
            s0, _ = E.entry(dates, min(a), "13:30")
            i1 = min(last, next((i for i, x in enumerate(dates) if x >= start), last))
            if dates[i1] > start:
                i1 -= 1
            o = px(code, s0 + 1, "o") if s0 + 1 <= last else None
            c = px(code, i1)
            if o and c and i1 > s0:
                pre = c / o - 1
        conf.append({k: v for k, v in {
            "c": code, "n": names.get(code, code), "d": start, "end": end, "t": tm, "host": E.host(note),
            "note": note, "ann": min(a) if a else None, "pre": r1(pre),
        }.items() if v is not None})
    conf.sort(key=lambda r: (r["d"], r["t"], r["c"]))

    twse.write_if_changed(OUT, {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "asof": dates[last], "today": today.isoformat(),
        "rules": {"grow": E.GROW * 100, "react": E.REACT * 100, "hold": E.HOLD, "recent": RECENT},
        "fin": fin, "conf": conf,
    })
    good = sum(1 for r in fin if r.get("sig") == "good" and r["held"] <= E.HOLD)
    bad = sum(1 for r in fin if r.get("sig") == "bad" and r["held"] <= E.HOLD)
    print(f"公告：財報 {len(fin)} 則（訊號中 好 {good}、壞 {bad}），法說會 {len(conf)} 場（{lo} ～ {hi}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
