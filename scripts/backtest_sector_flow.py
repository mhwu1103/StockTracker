"""回測族群法人資金四象限：法人的錢流進哪一族，之後那一族會不會比較強？

    python scripts/backtest_sector_flow.py                                  用 docs/data（網站只留兩年）
    GOOAYE_DATA=<解壓後的 docs/data> python scripts/backtest_sector_flow.py   用長歷史（2021-10 起）

只印表，不寫檔；結論整理在 BACKTEST.md。進出場、超額、t 值都跟 backtest_gooaye_daily.py 同一套
（直接 import 它）：訊號日隔天開盤進場、減全體普通股等權平均、Newey-West。

每一族、每一天：
- 淨流入 = 族內普通股法人買賣超（股數 × 收盤）加總；法人檔只收單日夠大的，小筆的沒算到
- 尺度   = 近 20 日每天 |淨流入| 的加總——各族大小差很多，不除的話台積電那族永遠在最右邊
- 橫軸 X = 近 5 日淨流入 ÷ 尺度（> 0：這週法人在買）
- 縱軸 Y = （近 5 日日均 − 近 20 日日均）÷ 尺度日均（> 0：這週比這個月更積極）
- 象限：加碼 X>0,Y>0／買盤收斂 X>0,Y<0（還在買、力道收）／賣壓收斂 X<0,Y>0（還在賣、力道回）／減碼 X<0,Y<0

報酬是族內普通股等權平均，再對同一天的全體普通股；一天裡同象限的各族先各算一個，再平均。
族群分兩種：官方產業別（industry.json，一檔一類）與題材（themes.json 的大類，一檔可多類）。
題材名單是事後挑「曾進過成交值前 200 大」的股票，本身有後見之明——只看象限之間的相對差。
"""

from __future__ import annotations

import os
import statistics as st
from collections import defaultdict

from backtest_gooaye_daily import COMMONS, HZ, N, bench, dates, di, files, industry, nw_t, ret
from gooaye import SITE, common, load

MIN_SIZE = 5          # 族裡至少幾檔普通股
QUADS = ("加碼", "買盤收斂", "賣壓收斂", "減碼")


def groups():
    """{'產業': {族: [代號]}, '題材': {族: [代號]}}"""
    ind = defaultdict(list)
    cs = set(COMMONS)
    for c, g in industry.items():
        if c in cs:
            ind[g].append(c)
    th = {}
    for g in load(os.path.join(SITE, "themes.json"))["groups"]:
        codes = sorted({c for s in g["subs"] for c in s["codes"] if c in cs})
        th[g["name"]] = codes
    keep = lambda d: {k: v for k, v in d.items() if len(v) >= MIN_SIZE and k != "其他"}
    return {"產業": keep(ind), "題材": keep(th)}


def flows():
    """flow[誰][i][代號] = 買賣超金額；誰 = 三大／外資／投信。"""
    out = {k: defaultdict(dict) for k in ("三大", "外資", "投信")}
    for d, p in files("insti/daily").items():
        if d not in di:
            continue
        i = di[d]
        for mk, rows in (load(p).get("stocks") or {}).items():
            for code, r in rows.items():
                if common(code) and r[4]:
                    out["外資"][i][code] = r[1] * r[4]
                    out["投信"][i][code] = r[2] * r[4]
                    out["三大"][i][code] = (r[1] + r[2] + r[3]) * r[4]
    return out


def coords(flow, members):
    """xy[族][i] = (X, Y)；只給前 20 天都有法人檔的日子。"""
    days = sorted(flow)
    xy = defaultdict(dict)
    for g, cs in members.items():
        net = [sum(flow[i].get(c, 0) for c in cs) for i in days]
        for k in range(19, len(days)):
            w = net[k - 19:k + 1]
            if days[k] - days[k - 19] > 25:          # 中間缺檔
                continue
            gross = sum(abs(v) for v in w)
            if gross <= 0:
                continue
            f5, f20 = sum(w[-5:]), sum(w)
            xy[g][days[k]] = (f5 / gross, (f5 / 5 - f20 / 20) / (gross / 20))
    return xy


def quad(x, y):
    return ("加碼" if y > 0 else "買盤收斂") if x > 0 else ("賣壓收斂" if y > 0 else "減碼")


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
            q = quad(*s[i])
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
