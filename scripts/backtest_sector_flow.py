"""回測族群法人資金四象限：法人的錢流進哪一族，之後那一族會不會比較強？

    python scripts/backtest_sector_flow.py                                  用 docs/data（網站只留兩年）
    GOOAYE_DATA=<解壓後的 docs/data> python scripts/backtest_sector_flow.py   用長歷史（2021-10 起）

只印表，不寫檔；結論整理在 BACKTEST.md。進出場、超額、t 值都跟 backtest_gooaye_daily.py 同一套
（直接 import 它）：訊號日隔天開盤進場、減全體普通股等權平均、Newey-West。

族群、橫縱軸與象限的算法都在 sector_flow.py（網站的「資金 → 動向」分頁畫的是同一份）。

報酬是族內普通股等權平均，再對同一天的全體普通股；一天裡同象限的各族先各算一個，再平均。
族群分兩種：官方產業別（industry.json，一檔一類）與題材（themes.json 的大類，一檔可多類）。
題材名單原本是事後挑「曾進過成交值前 200 大」的股票，本身有後見之明；2026-10-17 起依細產業補進其餘個股，後見之明變小但沒消失——只看象限之間的相對差。
"""

from __future__ import annotations

import os
import statistics as st
from collections import defaultdict

from backtest_gooaye_daily import COMMONS, HZ, N, bench, dates, di, files, industry, nw_t, ret
from gooaye import SITE, load
from sector_flow import QUADS, WHO, amounts, coords, quad
from sector_flow import groups as make_groups


def groups():
    g = make_groups(industry, load(os.path.join(SITE, "themes.json"))["groups"], set(COMMONS))
    return {"產業": g["industry"], "題材": g["theme"]}


def flows():
    """flow[誰][i][代號] = 買賣超金額；誰 = 三大／外資／投信。"""
    out = {k: {} for k in WHO}
    for d, p in files("insti/daily").items():
        if d in di:
            for k, v in amounts(load(p)).items():
                out[k][di[d]] = v
    return out


def grp_ret(cs, i, h):
    xs = [r for c in cs if (r := ret(c, i, h)) is not None]
    return st.fmean(xs) - bench[h][i] if len(xs) >= 3 and i in bench[h] else None


def seg(i):
    return "2022" if dates[i].startswith("2022") else ("≤2021" if dates[i] < "2022" else "2023+")


def report(name, picks, members):
    """picks[i] = [族]。每天先把當天的族各算一個超額再平均。"""
    cells = []
    for h in HZ:
        dm, sg, beat = [], defaultdict(list), []
        for i in sorted(picks):
            xs = [r for g in picks[i] if (r := grp_ret(members[g], i, h)) is not None]
            if xs:
                dm.append(st.fmean(xs))
                sg[seg(i)].append(dm[-1])
                beat += [x > 0 for x in xs]
        cells.append((dm, sg, beat))
    n = sum(len(v) for v in picks.values())
    s = f"  {name:<30}{n:>7}"
    for h, (dm, sg, beat) in zip(HZ, cells):
        s += f"{st.fmean(dm) * 100:>+9.2f}{nw_t(dm, h - 1):>6.1f}{st.fmean(beat) * 100:>5.0f}%" if dm else f"{'—':>20}"
    dm, sg, _ = cells[1]
    if dm:
        s += "".join(f"{sg.get(k) and st.fmean(sg[k]) * 100 or float('nan'):>+9.2f}" for k in ("2022", "2023+"))
    print(s)


def paired(name, a, b, members):
    """同一天兩邊都有：A 的族平均超額 − B 的。"""
    s = f"  {name:<30}"
    for h in HZ:
        dm, sg = [], defaultdict(list)
        for i in sorted(set(a) & set(b)):
            ra = [r for g in a[i] if (r := grp_ret(members[g], i, h)) is not None]
            rb = [r for g in b[i] if (r := grp_ret(members[g], i, h)) is not None]
            if ra and rb:
                dm.append(st.fmean(ra) - st.fmean(rb))
                sg[seg(i)].append(dm[-1])
        if dm:
            s += f"  {h}日 {st.fmean(dm) * 100:+.2f}%（t {nw_t(dm, h - 1):.1f}，{len(dm)} 天，" \
                 f"2022 {st.fmean(sg['2022']) * 100 if sg['2022'] else float('nan'):+.2f}%" \
                 f"／2023+ {st.fmean(sg['2023+']) * 100 if sg['2023+'] else float('nan'):+.2f}%）"
    print(s)


def header(title):
    print(f"\n=== {title} ===")
    print(f"  {'訊號':<30}{'族·日':>7}" + "".join(f"{f'{h}日超額':>9}{'t':>6}{'贏':>6}" for h in HZ)
          + f"{'20日2022':>9}{'2023+':>9}")


def run(kind, members, who, flow):
    xy = coords(flow, members)
    state = defaultdict(lambda: defaultdict(list))      # state[象限][i] = [族]
    enter = defaultdict(lambda: defaultdict(list))      # 剛進這個象限（前一天不在）
    top, bot = defaultdict(list), defaultdict(list)     # X 排名前後 3 族
    last = {}
    for g, s in xy.items():
        prev = None
        for i in sorted(s):
            q = quad(*s[i][:2])
            state[q][i].append(g)
            if prev is not None and q != prev and i - last.get((g, q), -999) > 20:
                enter[q][i].append(g)
                last[(g, q)] = i
            prev = q
    for i in {i for s in xy.values() for i in s}:
        rk = sorted((s[i][0], g) for g, s in xy.items() if i in s)
        if len(rk) >= 10:
            bot[i] = [g for _, g in rk[:3]]
            top[i] = [g for _, g in rk[-3:]]
    days = sorted({i for s in xy.values() for i in s})
    header(f"{kind}（{len(members)} 族）× {who}；{dates[days[0]]} ~ {dates[days[-1]]}")
    for q in QUADS:
        report(f"身在{q}（每天）", state[q], members)
    for q in QUADS:
        report(f"剛進{q}（20 日內第一次）", enter[q], members)
    report("X 前 3 族（這週買最多）", top, members)
    report("X 後 3 族（這週賣最多）", bot, members)
    paired("加碼 − 減碼（同日）", state["加碼"], state["減碼"], members)
    paired("剛進加碼 − 剛進減碼", enter["加碼"], enter["減碼"], members)
    paired("X 前 3 − 後 3", top, bot, members)


if __name__ == "__main__":
    print(f"資料：{dates[0]} ~ {dates[-1]}，{N} 個交易日")
    G = groups()
    F = flows()
    for kind in ("產業", "題材"):
        for who in ("三大", "外資", "投信"):
            run(kind, G[kind], who, F[who])
