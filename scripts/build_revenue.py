"""營收頁 → docs/data/revenue/：最近 12 個月的月營收、族群對照與公布後的股價反應。

    python scripts/build_revenue.py

回答的問題：**這個月誰的營收剛公布、創了新高？股價反應了沒？同一族的其他家呢？**

- **新高**有兩種：「12 個月新高」跟策略頁同一個定義（比前 12 個月都高、前面至少有 10 個月的資料）；
  「2019 起新高」是比本站有資料以來（2019-01 起）的每一個月都高，前面至少要有 36 個月才算
- **連續年增**：年增率連續大於 0 的月數，算到這個月
- **公布日**是本站第一次在公開資訊觀測站的彙總表上看到（value/revdate/，fetch_value.py 記的）；
  2026-10 以前的月份沒有記，那些用申報期限（隔月 10 日）當基準，頁面上會標出是哪一種
- **公布後**：基準日收盤 → 窗口結束那天的收盤，還原除權息。基準日是公布當天——排程在收盤後跑，
  那天看到的多半是盤後才申報的，所以從那天的收盤算起。窗口結束在**下一次申報期限**（m 月營收算到
  m+2 月 10 日），還沒到就是最新收盤：過去的月份數字固定下來，不會每天變；**公布前 20 日**是
  基準日往前 20 個交易日到基準日，看消息是不是早就反映了
- **股價 60 日新高**：窗口結束那天的還原收盤是近 60 個交易日的最高（最新的月份就是今天）。跟
  「營收 12 個月新高」同時成立就是策略頁的進場條件（策略另外還要流動性，見 strategy.py）

## 檔案

`revenue/index.json` 是月份清單與共用的東西（子族群名、門檻）；`revenue/<月>.json` 是那個月每一家
與族群彙總，前端切到那個月才抓。一個月約 250 KB，12 個月攤在一個檔裡太大；而且過去的月份窗口已經
結束，檔案不會再變，每天的 git 差異只有最近兩個月。
- **族群**用題材族群的子族群（themes.json）：已公布幾家、年增中位數、幾家創新高

排在 fetch_value.py 與 build_history.py 之後（要最新的 value/rev 與 close/）。
"""

from __future__ import annotations

import os
import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from gooaye import SITE, Prices, common, dated_files, load
from strategy import nextm
import twse

TPE = timezone(timedelta(hours=8))
MONTHS = 12         # 頁面上能切的月份數
OUT_DIR = twse.DATA_DIR / "revenue"
HI_PREV = 12        # 12 個月新高：比前幾個月都高
HI_MIN = 10         # 前面至少要有幾個月
ALL_MIN = 36        # 2019 起新高：前面至少要有幾個月
PRE = 20            # 公布前看幾個交易日
NH = 60             # 股價創幾日新高


def r1(x):
    return None if x is None else round(x, 1)


def slim(row):
    """兩千家，空值與 False 不寫：檔案小一半，前端讀不到就當沒有。"""
    return {k: v for k, v in row.items() if v is not None and v is not False and v != []}


def main() -> int:
    revs = {m: load(p) for m, p in dated_files("value/rev", [SITE]).items()}
    ms = sorted(revs)
    if len(ms) < 2:
        print("! 月營收不到兩個月，跳過")
        return 0
    dates_of = {m: load(p) for m, p in dated_files("value/revdate", [SITE]).items()}
    ind = load(os.path.join(SITE, "industry.json")) or {}
    names, industry = ind.get("names") or {}, ind.get("map") or {}
    themes = (load(os.path.join(SITE, "themes.json")) or {}).get("groups") or []
    subs = []                                   # [(族群, 子族群, 成分股)]
    sub_of = defaultdict(list)                  # 代號 → subs 的索引
    for g in themes:
        for s in g.get("subs") or []:
            sub_of_codes = [c for c in s.get("codes") or [] if common(c)]
            for c in sub_of_codes:
                sub_of[c].append(len(subs))
            subs.append((g["name"], s["name"], sub_of_codes))

    P = Prices([SITE])
    last = P.N - 1
    asof = P.dates[last]

    def close_on_or_before(d):
        """那一天或之前最近的交易日索引。"""
        i = None
        for k, x in enumerate(P.dates):
            if x > d:
                break
            i = k
        return i

    def series(code):
        return P.adj(code) if code in P.C else None

    def at(xs, i):
        """xs 在 i 或之前最近一個有值的位置。"""
        while i is not None and i >= 0:
            if xs[i] is not None:
                return xs[i]
            i -= 1
        return None

    def month_block(j):
        m = ms[j]
        cur, prev = revs[m], revs[ms[j - 1]] if j else {}
        pub = dates_of.get(m) or {}
        deadline = f"{nextm(m)}-10"
        i_dead = close_on_or_before(deadline)
        end = f"{nextm(nextm(m))}-10"
        i_end = min(last, close_on_or_before(end))
        rows = []
        for c, v in cur.items():
            if not common(c) or not v or not v[0]:
                continue
            now, yoy = v[0], v[1]
            back = [revs[ms[j - q]].get(c, [None])[0] for q in range(1, j + 1)]   # 由近到遠
            back = [x for x in back if x]
            near = [x for x in (revs[ms[j - q]].get(c, [None])[0] for q in range(1, HI_PREV + 1) if j - q >= 0) if x]
            hi12 = len(near) >= HI_MIN and now > max(near)
            hi_all = len(back) >= ALL_MIN and now > max(back)
            p = (prev.get(c) or [None])[0]
            mom = (now / p - 1) * 100 if p and p > 0 else None
            run = 0
            for q in range(0, j + 1):
                y = (revs[ms[j - q]].get(c) or [None, None])[1]
                if y is None or y <= 0:
                    break
                run += 1
            d_pub = pub.get(c)
            i0 = close_on_or_before(d_pub) if d_pub else i_dead
            xs = series(c)
            react = pre = None
            nh = False
            if xs and i0 is not None:
                b, e = at(xs, i0), at(xs, i_end)
                if b and e and i0 < i_end:
                    react = (e / b - 1) * 100
                if i0 >= PRE:
                    a = at(xs, i0 - PRE)
                    if a and b:
                        pre = (b / a - 1) * 100
            if xs and xs[i_end] is not None and i_end >= NH - 1:
                w = [x for x in xs[i_end - NH + 1:i_end + 1] if x is not None]
                nh = len(w) >= NH // 2 and xs[i_end] >= max(w)
            rows.append(slim({
                "c": c, "n": names.get(c, c), "ind": industry.get(c),
                "rev": round(now / 1e5, 2),                     # 千元 → 億元
                "yoy": yoy, "mom": r1(mom), "hi": hi12, "hiAll": hi_all, "run": run,
                "pub": d_pub, "react": r1(react), "pre": r1(pre), "nh": nh,
                "subs": sub_of.get(c, []),
            }))
        rows.sort(key=lambda r: (r.get("pub") or "", r.get("yoy", -1e9)), reverse=True)

        # 族群：子族群裡已公布的
        by = {r["c"]: r for r in rows}
        groups = []
        for k, (g, s, codes) in enumerate(subs):
            got = [by[c] for c in codes if c in by]
            if not got:
                continue
            ys = [r["yoy"] for r in got if "yoy" in r]
            rs = [r["react"] for r in got if "react" in r]
            groups.append({
                "k": k, "n": len(codes), "got": len(got),
                "yoy": r1(statistics.median(ys)) if ys else None,
                "up": sum(1 for y in ys if y > 0),
                "hi": sum(1 for r in got if r.get("hi")),
                "react": r1(statistics.median(rs)) if rs else None,
            })
        known = sum(1 for r in rows if "pub" in r)
        return {
            "m": m, "count": len(rows), "prevCount": sum(1 for c in prev if common(c)),
            "known": known, "deadline": deadline, "end": P.dates[i_end], "rows": rows, "groups": groups,
        }

    blocks = [month_block(j) for j in range(len(ms) - 1, max(-1, len(ms) - 1 - MONTHS), -1)]
    changed = 0
    for b in blocks:
        changed += twse.write_if_changed(OUT_DIR / f"{b['m']}.json", {"rows": b["rows"], "groups": b["groups"]})
    keep = {f"{b['m']}.json" for b in blocks} | {"index.json"}
    for old in OUT_DIR.glob("*.json"):
        if old.name not in keep:
            old.unlink()
    twse.write_if_changed(OUT_DIR / "index.json", {
        "updated": datetime.now(TPE).isoformat(timespec="seconds"),
        "asof": asof,
        "today": max((d for m in dates_of.values() for d in m.values() if d), default=None),
        "subs": [[g, s] for g, s, _ in subs],
        "months": [{k: v for k, v in b.items() if k not in ("rows", "groups")} for b in blocks],
        "rules": {"hiPrev": HI_PREV, "hiMin": HI_MIN, "allMin": ALL_MIN, "pre": PRE, "nh": NH,
                  "since": ms[0]},
    })
    b = blocks[0]
    print(f"營收 {b['m']}：{b['count']} 家（上月 {b['prevCount']}），"
          f"12 個月新高 {sum(1 for r in b['rows'] if r.get('hi'))} 家；共 {len(blocks)} 個月，{changed} 個月的檔有變")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
