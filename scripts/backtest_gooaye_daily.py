"""回測 MK 的價格類假說（日頻）：族群同步突破、大跌後最先站回前高、熱門股殺破季線、
大盤濾網、整理後突破、營收公布前先反映、投信族群連買。

    python scripts/backtest_gooaye_daily.py                     用 docs/data（網站只留兩年）
    GOOAYE_DATA=<解壓後的 docs/data> python scripts/backtest_gooaye_daily.py   用長歷史（2021-10 起）

只印表，不寫檔；結論整理在 BACKTEST.md。長歷史怎麼取得見 BACKTEST.md「長歷史放在哪裡」。
兩個目錄會合併：長歷史沒有的日子（最近幾天）從 docs/data 補。

- 進出場：訊號日隔天開盤進場，第 h 個交易日收盤出場；報酬用除權息因子還原（exright/）
- 超額：減掉同一進出場的全體普通股等權平均；贏中位＝高於同日中位數的比例
- t 值：先算每個訊號日的平均超額，再做 Newey-West（lag = h−1）
- 大盤：用還原後的 0050 當代理（taiex.json 只有最近一年多）
- 產業用目前的 industry.json，有些許後見之明（下市、轉產業的股票對不上）
"""

from __future__ import annotations

import math
import os
import statistics as st
from collections import defaultdict

from gooaye import SITE, Prices, common, dated_files, load, ma, roll_prev

DIRS = [d for d in (os.environ.get("GOOAYE_DATA"), SITE) if d]
HZ = (5, 20, 60)
VALUE_CUT = 3e7          # 法人單日買超至少 0.3 億


def files(sub):
    return dated_files(sub, DIRS)


P = Prices(DIRS)
dates, di, N, ret = P.dates, P.di, P.N, P.ret

COMMONS = [c for c in P.C if common(c)]
bench, bmed = {h: {} for h in HZ}, {h: {} for h in HZ}
for h in HZ:
    for i in range(N - h):
        xs = [r for c in COMMONS if (r := ret(c, i, h)) is not None]
        if len(xs) > 300:
            bench[h][i], bmed[h][i] = st.fmean(xs), st.median(xs)

industry = load(os.path.join(SITE, "industry.json"))["map"]
ind_size = defaultdict(int)
for c in COMMONS:
    if c in industry:
        ind_size[industry[c]] += 1

AC = {c: P.adj(c) for c in COMMONS + ["0050"]}


# ---------------- 統計 ----------------
def nw_t(x, lag):
    n = len(x)
    if n < 3:
        return float("nan")
    m = sum(x) / n
    e = [v - m for v in x]
    var = sum(v * v for v in e) / n
    for l in range(1, min(lag, n - 1) + 1):
        w = 1 - l / (lag + 1)
        var += 2 * w * sum(e[k] * e[k - l] for k in range(l, n)) / n
    return m / math.sqrt(var / n) if var > 0 else float("nan")


ROWS = []


def evaluate(name, events, note=""):
    """events: [(i, code)]。印出各持有期的平均超額、t、贏中位，以及 2022 與其後的分段。"""
    out = [name]
    byday = defaultdict(list)
    for i, code in events:
        byday[i].append(code)
    cells = []
    for h in HZ:
        dm, beats, seg = [], [], defaultdict(list)
        for i in sorted(byday):
            if i not in bench[h]:
                continue
            xs = [(r - bench[h][i], r > bmed[h][i]) for c in byday[i] if (r := ret(c, i, h)) is not None]
            if not xs:
                continue
            m = st.fmean(x[0] for x in xs)
            dm.append(m)
            beats += [x[1] for x in xs]
            seg["2022" if dates[i].startswith("2022") else ("≤2021" if dates[i] < "2022" else "2023+")].append(m)
        if not dm:
            cells.append(None)
            continue
        cells.append((st.fmean(dm), nw_t(dm, h - 1), st.fmean(beats), len(dm),
                      {k: st.fmean(v) for k, v in seg.items()}))
    ROWS.append((name, len(events), cells, note))


def print_rows(title):
    print(f"\n=== {title} ===")
    print(f"{'訊號':<40}{'事件':>7}" + "".join(f"{f'{h}日超額':>10}{'t':>6}{'贏中位':>6}" for h in HZ)
          + f"{'20日：2022':>12}{'2023+':>8}")
    for name, n, cells, note in ROWS:
        s = f"{name:<40}{n:>7}"
        for c in cells:
            s += f"{c[0] * 100:>+10.2f}{c[1]:>6.1f}{c[2] * 100:>5.0f}%" if c else f"{'—':>22}"
        c20 = cells[1]
        if c20:
            s += f"{c20[4].get('2022', float('nan')) * 100:>+12.2f}{c20[4].get('2023+', float('nan')) * 100:>+8.2f}"
        print(s + (f"  {note}" if note else ""))
    ROWS.clear()


# ---------------- 假說 ----------------
def brk_days(code, n=60, gap=20):
    """收盤創 n 日新高（還原），而且前 gap 天內沒有創過 → 第一次突破的日子。"""
    xs, out, last = AC[code], [], -999
    rm = roll_prev(xs, n)
    for i in range(n, N):
        if not xs[i]:
            continue
        m, _, k = rm[i]
        if m and k >= n * 0.8 and xs[i] > m:
            if i - last > gap:
                out.append(i)
            last = i
    return out


def h7_sync():
    brk = defaultdict(list)              # brk[i] = [code]
    for c in COMMONS:
        for i in brk_days(c):
            brk[i].append(c)
    sync, solo, allb = [], [], []
    for i, cs in brk.items():
        cnt = defaultdict(int)
        for c in cs:
            if c in industry:
                cnt[industry[c]] += 1
        for c in cs:
            allb.append((i, c))
            g = industry.get(c)
            if not g or ind_size[g] < 8:
                continue
            (sync if cnt[g] >= 3 else solo if cnt[g] == 1 else []).append((i, c))
    evaluate("H7 創 60 日新高（全部）", allb)
    evaluate("H7 同產業同日 ≥3 檔一起突破", sync)
    evaluate("H7 同產業只有它突破（獨漲）", solo)
    return allb


def h12_base():
    """創 250 日新高：舊高在 120 天以前（整理多季）vs 舊高在 20 天內（連續創高）。"""
    base, cont = [], []
    for c in COMMONS:
        xs = AC[c]
        rm = roll_prev(xs, 250)
        last = -999
        for i in range(250, N):
            if not xs[i]:
                continue
            m, j, k = rm[i]
            if k < 200 or xs[i] <= m:
                continue
            ago = i - j                                           # 舊高在幾天前
            if i - last > 20:
                if ago >= 120:
                    base.append((i, c))
                elif ago <= 20:
                    cont.append((i, c))
            last = i
    evaluate("H12 創 250 日新高，舊高在 120 天前（整理後突破）", base)
    evaluate("H12 創 250 日新高，舊高在 20 天內（連續創高）", cont)


def market_state():
    x = AC["0050"]
    st_ = {}
    for i in range(N):
        w60, w240 = [v for v in x[i - 59:i + 1] if v], [v for v in x[i - 239:i + 1] if v]
        if i < 240 or not x[i] or len(w240) < 200:
            continue
        ma60, ma240 = st.fmean(w60), st.fmean(w240)
        hi = max([v for v in x[i - 249:i + 1] if v] or [x[i]])
        day = x[i] / x[i - 1] - 1 if x[i - 1] else 0
        st_[i] = {"below60": x[i] < ma60, "below240": x[i] < ma240,
                  "blackhi": day <= -0.025 and x[i] >= 0.93 * hi}
    return st_


def h10_filter(allb):
    ms = market_state()
    x = AC["0050"]
    print("\n=== H10 大盤濾網：0050 之後 20／60 日報酬（還原） ===")
    for key, lab in (("all", "全部日子"), ("below60", "0050 在季線下"), ("above60", "0050 在季線上"),
                     ("below240", "0050 在年線下"), ("blackhi", "0050 高檔長黑（單日 ≤−2.5%、離 250 日高 7% 內）")):
        for h in (20, 60):
            rs = []
            for i, s in ms.items():
                ok = (key == "all" or (key == "above60" and not s["below60"]) or
                      (key not in ("all", "above60") and s[key]))
                if ok and (r := ret("0050", i, h)) is not None:
                    rs.append(r)
            if rs:
                print(f"  {lab:<40} {h:>2} 日  n={len(rs):>4}  平均 {st.fmean(rs) * 100:+.2f}%  "
                      f"上漲比例 {st.fmean(r > 0 for r in rs) * 100:.0f}%")
    # 突破訊號在不同大盤狀態下的「絕對」報酬
    print("  突破股（H7 全部）之後 20 日的絕對報酬：")
    for lab, cond in (("0050 在季線上", lambda s: not s["below60"]), ("0050 在季線下", lambda s: s["below60"]),
                      ("0050 在年線下", lambda s: s["below240"])):
        rs = [r for i, c in allb if i in ms and cond(ms[i]) and (r := ret(c, i, 20)) is not None]
        if rs:
            print(f"    {lab:<14} n={len(rs):>6}  平均 {st.fmean(rs) * 100:+.2f}%  中位 {st.median(rs) * 100:+.2f}%  "
                  f"上漲比例 {st.fmean(r > 0 for r in rs) * 100:.0f}%")


def h8_regain():
    """0050 從 60 日高點回落 ≥10% 的波段：低點後第 10 天，已經站回跌前高點的 vs 還躺平的。"""
    x = AC["0050"]
    events, i = [], 60
    while i < N:
        hi = max(v for v in x[i - 60:i + 1] if v)
        if x[i] and x[i] <= 0.9 * hi:
            p = max(range(i - 60, i + 1), key=lambda k: x[k] or 0)     # 跌前高點
            j, low = i, i
            while j < N and x[j] and x[j] < 0.97 * hi and j - i < 120:
                if x[j] < x[low]:
                    low = j
                j += 1
            events.append((p, low))
            i = j + 1
        else:
            i += 1
    print("\n0050 回落 ≥10% 的波段（跌前高點 → 低點）：" +
          "、".join(f"{dates[p]}→{dates[l]}（{x[l] / x[p] - 1:+.0%}）" for p, l in events))
    first, mid, flat = [], [], []
    for p, low in events:
        d = low + 10
        if d >= N:
            continue
        for c in COMMONS:
            xs = AC[c]
            pre = [v for v in xs[max(0, p - 20):p + 1] if v]
            if len(pre) < 15 or not xs[d] or not xs[low]:
                continue
            ph = max(pre)
            if xs[d] >= ph:
                first.append((d, c))
            elif xs[d] < 0.85 * ph:
                flat.append((d, c))
            else:
                mid.append((d, c))
    evaluate("H8 低點後第 10 天已站回跌前高點", first, f"{len(events)} 個波段")
    evaluate("H8 低點後第 10 天介於中間", mid)
    evaluate("H8 低點後第 10 天仍低於跌前高點 15%（躺平）", flat)


def h9_hot_break():
    """熱門股（60 日漲幅前 10%、過去 40 天都在季線上）第一次收盤跌破季線。"""
    above_run = {}
    for c in COMMONS:
        xs, m60 = AC[c], ma(AC[c], 60)
        run, out = 0, [0] * N
        for i in range(N):
            if xs[i] is None or m60[i] is None:
                run = 0
            elif xs[i] >= m60[i]:
                run += 1
            else:
                run = -1                       # -1 = 今天在季線下
            out[i] = run
        above_run[c] = out
    ev = []
    for i in range(120, N - 1):
        r60 = {}
        for c in COMMONS:
            xs = AC[c]
            if xs[i] and xs[i - 60]:
                r60[c] = xs[i] / xs[i - 60] - 1
        if len(r60) < 500:
            continue
        cut = sorted(r60.values())[int(len(r60) * 0.9)]
        for c, r in r60.items():
            if r >= cut and above_run[c][i] == -1 and above_run[c][i - 1] >= 40:
                ev.append((i, c))
    evaluate("H9 強勢股第一次收盤跌破季線", ev)


def h_lows_highs():
    hi, lo = [], []
    for c in COMMONS:
        xs = AC[c]
        rmx, rmn = roll_prev(xs, 250), roll_prev(xs, 250, -1)
        lh = ll = -999
        for i in range(250, N):
            if not xs[i] or rmx[i][2] < 200:
                continue
            if xs[i] > rmx[i][0]:
                if i - lh > 20:
                    hi.append((i, c))
                lh = i
            elif xs[i] < rmn[i][0]:
                if i - ll > 20:
                    lo.append((i, c))
                ll = i
    evaluate("H14 創 250 日新高（創高當天不賣）", hi)
    evaluate("H14 創 250 日新低（創低當天不抄底）", lo)


def h6_pre_announce():
    """營收創歷史新高＋YoY>20% 的月份：公布月 1～10 日（大多已公布）vs 11 日之後 20 天。"""
    revs = files("value/rev")
    rv = defaultdict(dict)
    for m, p in sorted(revs.items()):
        for code, row in load(p).items():
            if common(code) and row and row[0]:
                rv[code][m] = row
    hi = {}
    for code, s in rv.items():
        h, k = None, 0
        for n, m in enumerate(sorted(s)):
            hi[(code, m)] = n >= 12 and s[m][0] > h and (s[m][1] or 0) > 20
            h = s[m][0] if h is None else max(h, s[m][0])
    pre, post, post_all = [], [], []
    by_month = defaultdict(list)
    for (code, m), ok in hi.items():
        if ok:
            by_month[m].append(code)
    for m, codes in by_month.items():
        y, mm = int(m[:4]), int(m[5:])
        nm = f"{y + (mm == 12)}-{mm % 12 + 1:02d}"
        last_l = max((i for i, d in enumerate(dates) if d[:7] == m), default=None)   # 營收月最後一天
        ten = max((i for i, d in enumerate(dates) if d[:7] == nm and d[8:] <= "10"), default=None)
        if last_l is None or ten is None:
            continue
        for c in codes:
            pre.append((last_l, c, ten - last_l))
            post.append((ten, c))
    # pre：營收月最後一天收盤 → 次月 10 日收盤，用收盤到收盤
    ex = []
    for i, c, h in pre:
        a, b = AC[c][i], AC[c][i + h] if i + h < N else None
        if a and b:
            base = [AC[x][i + h] / AC[x][i] - 1 for x in COMMONS if AC[x][i] and AC[x][i + h]]
            ex.append(b / a - 1 - st.fmean(base))
    if ex:
        print(f"\n=== H6 營收公布前是否先反映（營收創歷史新高＋YoY>20%，{len(ex)} 筆） ===")
        print(f"  營收月最後一天 → 次月 10 日（公布期間）：平均超額 {st.fmean(ex) * 100:+.2f}%、"
              f"中位 {st.median(ex) * 100:+.2f}%")
    evaluate("H6 營收創高＋YoY>20%，10 日之後才進場", post)


def h11_trust():
    """投信：連買 3 天（每天 ≥0.3 億）、同產業同日 ≥3 檔投信買超；2023 起 ETF 大量發行前後分開看。"""
    ins = files("insti/daily")
    buy = defaultdict(dict)        # buy[i][code] = (投信, 外資) 買賣超金額
    for d, p in ins.items():
        if d not in di:
            continue
        x = load(p)
        for mk in ("twse", "tpex"):
            for code, row in (x.get("stocks", {}).get(mk) or {}).items():
                if common(code) and row[4]:
                    buy[di[d]][code] = (row[2] * row[4], row[1] * row[4])
    days = sorted(buy)
    run = defaultdict(int)
    tr3, tr3_grp, tr1, fo3 = [], [], [], []
    frun, srun = defaultdict(int), defaultdict(int)
    sell3 = []
    for i in days:
        today = buy[i]
        cnt = defaultdict(int)
        for c, (t, f) in today.items():
            if t >= VALUE_CUT and c in industry:
                cnt[industry[c]] += 1
        for c in set(run) | set(today):
            t, f = today.get(c, (0, 0))
            run[c] = run[c] + 1 if t >= VALUE_CUT else 0
            frun[c] = frun[c] + 1 if f >= VALUE_CUT else 0
            srun[c] = srun[c] + 1 if t <= -VALUE_CUT else 0
            if srun[c] == 3:
                sell3.append((i, c))
            if t >= VALUE_CUT:
                tr1.append((i, c))
            if run[c] == 3:
                tr3.append((i, c))
                if cnt[industry.get(c, "")] >= 3:
                    tr3_grp.append((i, c))
            if frun[c] == 3:
                fo3.append((i, c))
    for lab, ev in (("H11 投信買超 ≥0.3 億（單日）", tr1), ("H11 投信剛滿連買 3 天", tr3),
                    ("H11 投信連買 3 天＋同產業 ≥3 檔投信買", tr3_grp), ("H11 對照：外資剛滿連買 3 天", fo3),
                    ("H11 對照：投信剛滿連賣 3 天", sell3)):
        evaluate(lab, ev)


def h_sbl():
    """借券賣出餘額 20 天內翻倍（增加 ≥0.5 億）vs 20 天內減半（回補 ≥0.5 億）。資料只有 2024-10 起。"""
    sbl = defaultdict(dict)
    for d, p in files("margin/daily").items():
        if d in di:
            x = load(p)
            if "b" in x:
                for code, v in x["b"].items():
                    sbl[code][di[d]] = v
    days = sorted({i for s in sbl.values() for i in s})
    if not days:
        print("\n（沒有借券資料，跳過 H15）")
        return
    up, down = [], []
    for code, s in sbl.items():
        if not common(code):
            continue
        last_up = last_dn = -999
        for k in range(20, len(days)):
            i, j = days[k], days[k - 20]          # 檔裡只存餘額不是 0 的，沒有的那天就是 0
            a, b = s.get(j, 0), s.get(i, 0)
            px = P.C[code].get(i)
            if not px:
                continue
            if b >= 2 * a and (b - a) * 1000 * px >= 5e7 and i - last_up > 20:
                up.append((i, code))
                last_up = i
            if a >= 2 * b and (a - b) * 1000 * px >= 5e7 and i - last_dn > 20:
                down.append((i, code))
                last_dn = i
    evaluate("H15 借券賣出 20 天內翻倍（增加 ≥0.5 億）", up, f"{dates[days[0]]} 起")
    evaluate("H15 對照：借券賣出 20 天內減半（回補 ≥0.5 億）", down)


if __name__ == "__main__":
    print(f"資料：{dates[0]} ~ {dates[-1]}，{N} 個交易日；目錄 {DIRS}")
    allb = h7_sync()
    h12_base()
    h_lows_highs()
    print_rows("價格型態")
    h8_regain()
    h9_hot_break()
    print_rows("大跌與熱門股")
    h6_pre_announce()
    print_rows("營收公布時點")
    h11_trust()
    h_sbl()
    print_rows("投信（20 日欄的 2022 ≈ ETF 熱潮前、2023+ ≈ ETF 熱潮後）")
    h10_filter(allb)
