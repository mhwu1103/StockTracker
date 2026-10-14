"""族群法人資金四象限的算法。網站（build_sector_flow.py）與回測（backtest_sector_flow.py）共用這一份，
免得畫在網頁上的點跟回測測的不是同一個東西。

每一族、每一天：
- 淨流入 = 族內普通股法人買賣超（股數 × 收盤）加總；法人檔只收單日夠大的，小筆的沒算到
- 尺度   = 近 20 日每天 |淨流入| 的加總——各族大小差很多，不除的話台積電那族永遠在最右邊
- 橫軸 X = 近 5 日淨流入 ÷ 尺度（> 0：這週法人在買）
- 縱軸 Y = （近 5 日日均 − 近 20 日日均）÷ 尺度日均（> 0：這週比這個月更積極）
- 象限：加碼 X>0,Y>0／買盤收斂 X>0,Y<0（還在買、力道收）／賣壓收斂 X<0,Y>0（還在賣、力道回）／減碼 X<0,Y<0

族群分三種：官方產業別（industry.json，一檔一類）、題材大類與題材細項（themes.json 的 groups 與
subs，一檔可多類）。回測只測前兩種。
ETF 不算：ETF 的法人買賣超大多是申購買回，不是看好哪一族。
"""

from __future__ import annotations

from collections import defaultdict

MIN_SIZE = 5          # 族裡至少幾檔普通股
MIN_SUB = 3           # 題材細項本來就切得細，放寬到 3 檔
WHO = ("三大", "外資", "投信")
QUADS = ("加碼", "買盤收斂", "賣壓收斂", "減碼")


def common(code: str) -> bool:
    return len(code) == 4 and code.isdigit() and not code.startswith("0")


def groups(industry: dict, themes: list, codes=None) -> dict:
    """{"industry"|"theme"|"sub": {族: [代號]}}；codes 給的話只收這些代號。"""
    ok = (lambda c: common(c) and (codes is None or c in codes))
    ind = defaultdict(list)
    for c, g in industry.items():
        if ok(c):
            ind[g].append(c)
    th = {g["name"]: sorted({c for s in g["subs"] for c in s["codes"] if ok(c)}) for g in themes}
    sub = {s["name"]: sorted({c for c in s["codes"] if ok(c)}) for g in themes for s in g["subs"]}
    keep = lambda d, n=MIN_SIZE: {k: sorted(v) for k, v in d.items() if len(v) >= n and k != "其他"}
    return {"industry": keep(ind), "theme": keep(th), "sub": keep(sub, MIN_SUB)}


def amounts(day: dict) -> dict:
    """一個法人日檔 → {誰: {代號: 買賣超金額}}，只收普通股。"""
    out = {k: {} for k in WHO}
    for rows in (day.get("stocks") or {}).values():
        for code, r in rows.items():
            if common(code) and r[4]:
                out["外資"][code] = r[1] * r[4]
                out["投信"][code] = r[2] * r[4]
                out["三大"][code] = (r[1] + r[2] + r[3]) * r[4]
    return out


def coords(flow: dict, members: dict) -> dict:
    """flow[i][代號] = 金額，i 是交易日序號。回傳 xy[族][i] = (X, Y, 近 5 日淨流入, 尺度)。
    前 20 個有檔的日子橫跨超過 25 個交易日（中間缺檔）就不給。"""
    days = sorted(flow)
    xy = defaultdict(dict)
    for g, cs in members.items():
        net = [sum(flow[i].get(c, 0) for c in cs) for i in days]
        for k in range(19, len(days)):
            if days[k] - days[k - 19] > 25:
                continue
            w = net[k - 19:k + 1]
            gross = sum(abs(v) for v in w)
            if gross <= 0:
                continue
            f5, f20 = sum(w[-5:]), sum(w)
            xy[g][days[k]] = (f5 / gross, (f5 / 5 - f20 / 20) / (gross / 20), f5, gross)
    return xy


def quad(x, y):
    return ("加碼" if y > 0 else "買盤收斂") if x > 0 else ("賣壓收斂" if y > 0 else "減碼")
