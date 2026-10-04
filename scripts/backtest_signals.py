"""回測：各分頁的訊號，之後 1／5／10／20 個交易日的超額報酬。

    python scripts/backtest_signals.py        只印出表格，不寫檔；結論整理在 BACKTEST.md

進場＝訊號日隔天開盤（收盤後才知道訊號），出場＝第 h 個交易日收盤。
超額＝個股報酬 − 同日同 h「同一群股票」的等權平均（UNIV：前 300 名、法人名單、
電子股、題材成分股；沒指定就是全市場普通股）。只跟全市場比的話，爆量、進榜這類
只會出現在大型股身上的訊號，會把「大型股這段剛好比較會漲」誤算成訊號的功勞。
beat＝報酬高於同群當日中位數的比例（50% 是沒有鑑別力）。
t 值以「日」為單位：先算每個訊號日的平均超額，再對這些日平均做 t 檢定（同日事件高度相關），
持有期重疊的部分用 Newey-West（lag = h−1）修正。[前半/後半] 是把訊號日切兩段各自的平均超額。
"""
import json, glob, os, math, statistics as st
from collections import defaultdict

D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")
def load(p):
    with open(p, encoding="utf8") as f:
        return json.load(f)

# ---------------- 全市場四價 ----------------
dates = sorted({os.path.basename(p)[:-5] for p in glob.glob(D + "/close/twse/*.json")})
O, H, L, C = {}, {}, {}, {}
for d in dates:
    for m in ("twse", "tpex"):
        p = f"{D}/close/{m}/{d}.json"
        if not os.path.exists(p):
            continue
        x = load(p)
        for k, dst in (("o", O), ("h", H), ("l", L), ("c", C)):
            dst.setdefault(d, {}).update(x[k])
di = {d: i for i, d in enumerate(dates)}
def common(code):
    return len(code) == 4 and code.isdigit() and not code.startswith("0")

HZ = (1, 5, 10, 20)
# 只評估某一段的訊號日（訊號照樣用全部資料算，均線等指標的暖身不受影響）：
#   BT_FROM=2024-08-16 python scripts/backtest_signals.py
BT_FROM = os.environ.get("BT_FROM", "0000")
BT_TO = os.environ.get("BT_TO", "9999")
def in_window(events):
    return sorted({e for e in events if BT_FROM <= e[0] <= BT_TO})
# fwd[h][d][code] = 隔日開盤進場到第 h 日收盤
fwd = {h: {} for h in HZ}
bench = {h: {} for h in HZ}
for i, d in enumerate(dates):
    if i + 1 >= len(dates):
        break
    nd = dates[i + 1]
    for h in HZ:
        if i + h >= len(dates):
            continue
        ed = dates[i + h]
        r = {}
        for code, o in O.get(nd, {}).items():
            if not common(code) or not o:
                continue
            c = C[ed].get(code)
            if c:
                r[code] = c / o - 1
        if r:
            fwd[h][d] = r
            bench[h][d] = st.mean(r.values())

def nw_t(x, lag):
    n = len(x)
    if n < 3:
        return float("nan")
    m = sum(x) / n
    e = [v - m for v in x]
    g0 = sum(v * v for v in e) / n
    var = g0
    for l in range(1, min(lag, n - 1) + 1):
        w = 1 - l / (lag + 1)
        var += 2 * w * sum(e[i] * e[i - l] for i in range(l, n)) / n
    return m / math.sqrt(var / n) if var > 0 else float("nan")

UNIV = {}          # key -> {date: set(codes)}；None = 全市場
_ub = {}
def ubench(key, h, d):
    """同一群股票當日的平均與中位數報酬。"""
    k = (key, h, d)
    if k not in _ub:
        r = fwd[h].get(d, {})
        if key is None:
            vals = list(r.values())
        else:
            members = UNIV[key].get(d)
            vals = [r[c] for c in members if c in r] if members else []
        _ub[k] = (st.mean(vals), st.median(vals)) if len(vals) >= 30 else None
    return _ub[k]

def evaluate(events, uni=None):
    """events: list of (date, code) -> {h: stats}；超額是相對同一群股票（uni）的當日平均"""
    out = {}
    for h in HZ:
        per_day = defaultdict(list)
        allx = []
        beat = 0
        for d, code in events:
            r = fwd[h].get(d, {}).get(code)
            b = ubench(uni, h, d)
            if r is None or b is None:
                continue
            x = r - b[0]
            beat += r > b[1]
            per_day[d].append(x)
            allx.append(x)
        if len(allx) < 20 or len(per_day) < 5:
            out[h] = None
            continue
        ds = sorted(per_day)
        dm = [st.mean(per_day[d]) for d in ds]
        t = nw_t(dm, h - 1)
        half = len(ds) // 2
        a = [x for d in ds[:half] for x in per_day[d]]
        b = [x for d in ds[half:] for x in per_day[d]]
        out[h] = dict(n=len(allx), days=len(per_day), mean=st.mean(allx) * 100,
                      dmean=st.mean(dm) * 100,
                      med=st.median(allx) * 100, hit=beat / len(allx) * 100,
                      t=t, h1=st.mean(a) * 100 if a else None, h2=st.mean(b) * 100 if b else None)
    return out

SIG = {}   # name -> (group, events, uni)
def add(group, name, events, uni=None):
    SIG[name] = (group, events, uni)

# ---------------- 均線、MACD（全市場收盤自己算）----------------
def ema_series(vals, n):
    k = 2 / (n + 1); e = None; out = []
    for v in vals:
        e = v if e is None else v * k + e * (1 - k)
        out.append(e)
    return out

codes_all = sorted({c for d in dates for c in C[d] if common(c)})
ev = defaultdict(list)
for code in codes_all:
    seq = []  # (i, close) contiguous
    for i, d in enumerate(dates):
        c = C[d].get(code)
        seq.append(c)
    # 要求連續；有缺值的就斷
    ma = {}
    for n in (5, 10, 20, 60):
        arr = [None] * len(dates)
        for i in range(n - 1, len(dates)):
            w = seq[i - n + 1:i + 1]
            if all(w):
                arr[i] = sum(w) / n
        ma[n] = arr
    for i in range(1, len(dates)):
        c, pc = seq[i], seq[i - 1]
        if not c or not pc:
            continue
        d = dates[i]
        for n in (20, 60):
            m, pm = ma[n][i], ma[n][i - 1]
            if m and pm:
                if pc <= pm and c > m:
                    ev[f"站上 MA{n}"].append((d, code))
                if pc >= pm and c < m:
                    ev[f"跌破 MA{n}"].append((d, code))
        if all(ma[n][i] for n in (5, 10, 20, 60)) and all(ma[n][i - 1] for n in (5, 10, 20, 60)):
            up = all(c > ma[n][i] for n in (5, 10, 20, 60))
            pup = all(pc > ma[n][i - 1] for n in (5, 10, 20, 60))
            dn = all(c < ma[n][i] for n in (5, 10, 20, 60))
            pdn = all(pc < ma[n][i - 1] for n in (5, 10, 20, 60))
            if up and not pup:
                ev["剛變四線全上"].append((d, code))
            if dn and not pdn:
                ev["剛變四線全下"].append((d, code))
            if up:
                ev["四線全上（狀態）"].append((d, code))
    # MACD 12/26/9，需從資料起點連續
    if all(seq):
        e12, e26 = ema_series(seq, 12), ema_series(seq, 26)
        dif = [a - b for a, b in zip(e12, e26)]
        dea = ema_series(dif, 9)
        for i in range(35, len(dates)):
            if dif[i - 1] <= dea[i - 1] and dif[i] > dea[i]:
                ev["MACD 黃金交叉"].append((dates[i], code))
                if dif[i] < 0:
                    ev["MACD 零軸下黃金交叉"].append((dates[i], code))
            if dif[i - 1] >= dea[i - 1] and dif[i] < dea[i]:
                ev["MACD 死亡交叉"].append((dates[i], code))
    # 動能基準：過去 20 日報酬（每天取前 10%）另外處理
for k in ("站上 MA20", "站上 MA60", "剛變四線全上", "四線全上（狀態）", "MACD 黃金交叉", "MACD 零軸下黃金交叉"):
    add("技術", k, ev[k])
for k in ("跌破 MA20", "跌破 MA60", "剛變四線全下", "MACD 死亡交叉"):
    add("技術（空方）", k, ev[k])

# 動能／反轉基準
mom_top, mom_bot, rev5 = [], [], []
for i in range(20, len(dates)):
    d, p20, p5 = dates[i], dates[i - 20], dates[i - 5]
    r = {c: C[d][c] / C[p20][c] - 1 for c in C[d] if common(c) and C[p20].get(c)}
    if len(r) < 200:
        continue
    s = sorted(r, key=r.get)
    k = len(s) // 10
    mom_top += [(d, c) for c in s[-k:]]
    mom_bot += [(d, c) for c in s[:k]]
    r5 = {c: C[d][c] / C[p5][c] - 1 for c in C[d] if common(c) and C[p5].get(c)}
    s5 = sorted(r5, key=r5.get)
    rev5 += [(d, c) for c in s5[:len(s5) // 10]]
add("基準", "20 日漲幅前 10%（動能）", mom_top)
add("基準", "20 日跌幅前 10%", mom_bot)
add("基準", "5 日跌幅前 10%（短反轉）", rev5)

# ---------------- 排行／爆量（前 300 名日檔）----------------
new200, jump, vol20, vol60, vol20dn, top300 = [], [], [], [], [], []
prev = None
for p in sorted(glob.glob(D + "/daily/all/*.json")):
    x = load(p); d = x["date"]
    if d not in di:
        prev = {s["code"]: s["rank"] for s in x["stocks"]}
        continue
    cur = {s["code"]: s for s in x["stocks"]}
    for s in x["stocks"]:
        code = s["code"]
        if not common(code):
            continue
        pr = prev.get(code) if prev else None
        if s["rank"] <= 200 and (pr is None or pr > 200):
            new200.append((d, code))
        if pr and pr - s["rank"] >= 100:
            jump.append((d, code))
        vh = s.get("vh", 1)
        # 2026-03 以前的 daily/ 沒存開盤價，改讀 close/ 的四價（回補過，整段都有）
        op, cl = O.get(d, {}).get(code), C.get(d, {}).get(code)
        if s["volume"] >= 5_000_000 and op and cl:
            if vh >= 20 and cl > op:
                vol20.append((d, code))
            if vh >= 60 and cl > op:
                vol60.append((d, code))
            if vh >= 20 and cl < op:
                vol20dn.append((d, code))
    top300 += [(d, s["code"]) for s in x["stocks"] if common(s["code"])]
    UNIV.setdefault("top300", {})[d] = {s["code"] for s in x["stocks"] if common(s["code"])}
    prev = {s["code"]: s["rank"] for s in x["stocks"]}
add("基準", "成交值前 300 名全體（流動性基準）", top300)
add("排行", "新進前 200", new200, "top300")
add("排行", "名次一天跳升 ≥100", jump, "top300")
add("技術", "爆量收紅（≥5千張、20 日量新高）", vol20, "top300")
add("技術", "爆量收紅（≥5千張、60 日量新高）", vol60, "top300")
add("技術（空方）", "爆量收黑（≥5千張、20 日量新高）", vol20dn, "top300")

# ---------------- 結構（k=5）----------------
st_ev = defaultdict(list)
prevrow = {}
for p in sorted(glob.glob(D + "/structure/2*.json")):
    x = load(p); d = x["date"]
    UNIV.setdefault("elec", {})[d] = {c for c in x["s"] if common(c)}
    for code, row in x["s"].items():
        for kk, off in (("k3", 0), ("k5", 6)):
            dr, ph = row[off], row[off + 1]
            pv = prevrow.get((code, kk))
            if pv != (dr, ph):
                name = {(1, 0): "突破", (1, 1): "突破後回踩中", (1, 2): "回踩守住", (1, 3): "突破失敗",
                        (-1, 0): "破位", (-1, 1): "破位後反彈中", (-1, 2): "反彈受阻", (-1, 3): "破位失敗"}.get((dr, ph))
                if name and pv is not None:
                    st_ev[f"{name}（{kk}）"].append((d, code))
            prevrow[(code, kk)] = (dr, ph)
for name in ("突破", "回踩守住", "突破失敗", "破位失敗"):
    for kk in ("k3", "k5"):
        add("結構（電子股）", f"{name}（{kk}）", st_ev[f"{name}（{kk}）"], "elec")
for name in ("破位", "反彈受阻"):
    for kk in ("k3", "k5"):
        add("結構（空方）", f"{name}（{kk}）", st_ev[f"{name}（{kk}）"], "elec")

# ---------------- 法人 ----------------
ins = {}
for p in sorted(glob.glob(D + "/insti/daily/*.json")):
    x = load(p); d = x["date"]
    row = {}
    for m in ("twse", "tpex"):
        for code, v in x["stocks"].get(m, {}).items():
            row[code] = v  # name, fo, tr, de, close (股)
    ins[d] = row
    UNIV.setdefault("insti", {})[d] = {c for c in row if common(c)}
idates = sorted(ins)
TH = 0.3e8
tuy, tuy_s, trb, fo_contra, fo_force, trust_first = [], [], [], [], [], []
streak = defaultdict(int)
trs, fob, fos, tr_vs_fo, trb1 = [], [], [], [], []
fo5, fo_sell5 = [], []
absbase = defaultdict(list)
for d in idates:
    if d not in di:
        continue
    i = di[d]
    for code, v in ins[d].items():
        if not common(code):
            continue
        _, fo, tr, de, cl = v
        cl = cl or C[d].get(code)
        if not cl:
            continue
        fa, ta = fo * cl, tr * cl
        if fa >= TH and ta >= TH:
            tuy.append((d, code))
        if fa <= -TH and ta <= -TH:
            tuy_s.append((d, code))
        if ta >= TH:
            trb.append((d, code))
            if fa <= -TH:
                tr_vs_fo.append((d, code))
            if ta >= 1e8:
                trb1.append((d, code))
        if ta <= -TH:
            trs.append((d, code))
        if fa >= TH:
            fob.append((d, code))
        if fa <= -TH:
            fos.append((d, code))
        pc = C[dates[i - 1]].get(code) if i else None
        if fa >= TH and pc and C[d].get(code) and C[d][code] < pc:
            fo_contra.append((d, code))
        base = absbase[code]
        if len(base) >= 10 and fa >= TH:
            avg = sum(base[-10:]) / 10
            if avg > 0 and fa >= 3 * avg:
                fo_force.append((d, code))
        base.append(abs(fa))
        s_prev = streak[code]
        streak[code] = (s_prev + 1 if s_prev > 0 else 1) if fo > 0 else ((s_prev - 1 if s_prev < 0 else -1) if fo < 0 else 0)
        if streak[code] == 5:
            fo5.append((d, code))
        if streak[code] == -5:
            fo_sell5.append((d, code))
    # 沒出現在當日檔的，連續中斷
    for code in list(streak):
        if code not in ins[d]:
            streak[code] = 0
add("籌碼", "土洋同買（各 ≥0.3 億）", tuy, "insti")
add("籌碼", "投信買超 ≥1 億", trb1, "insti")
add("籌碼", "投信買、外資賣（各 ≥0.3 億）", tr_vs_fo, "insti")
add("籌碼", "外資買超 ≥0.3 億", fob, "insti")
add("籌碼（空方）", "投信賣超 ≥0.3 億", trs, "insti")
add("籌碼（空方）", "外資賣超 ≥0.3 億", fos, "insti")
add("籌碼", "投信買超 ≥0.3 億", trb, "insti")
add("籌碼", "外資逆勢買超（買 ≥0.3 億、收黑）", fo_contra, "insti")
add("籌碼", "外資力道 ≥3 倍（且 ≥0.3 億）", fo_force, "insti")
add("籌碼", "外資剛滿連買 5 天", fo5, "insti")
add("籌碼（空方）", "土洋同賣（各 ≥0.3 億）", tuy_s, "insti")
add("籌碼（空方）", "外資剛滿連賣 5 天", fo_sell5, "insti")

# ---------------- 大戶（集保週資料）----------------
hw = {}
for p in sorted(glob.glob(D + "/holders/weekly/*.json")):
    x = load(p)
    hw[x["date"]] = x["stocks"]
hd = sorted(hw)
big_up, big_dn, hold_dn = [], [], []
for a, b in zip(hd, hd[1:]):
    # 只取相鄰一週（間隔 ≤ 8 天）
    from datetime import date
    da, db = date.fromisoformat(a), date.fromisoformat(b)
    if (db - da).days > 8:
        continue
    # 訊號日＝資料日當天或之後第一個交易日（週五資料週末公布，隔週一開盤進場 → 以週五當訊號日）
    sd = next((d for d in dates if d >= b), None)
    if not sd:
        continue
    chg, hch = {}, {}
    for code, v in hw[b].items():
        if not common(code) or code not in hw[a]:
            continue
        u = hw[a][code]
        if v[22] < 5000:   # 太小的股本略過
            continue
        chg[code] = v[11] - u[11]
        if u[21]:
            hch[code] = v[21] / u[21] - 1
    s = sorted(chg, key=chg.get)
    k = len(s) // 10
    big_up += [(sd, c) for c in s[-k:]]
    big_dn += [(sd, c) for c in s[:k]]
    s2 = sorted(hch, key=hch.get)
    hold_dn += [(sd, c) for c in s2[:len(s2) // 10]]
add("籌碼", "400 張大戶週增幅前 10%", big_up)
add("籌碼", "股東人數週減幅前 10%", hold_dn)
add("籌碼（空方）", "400 張大戶週減幅前 10%", big_dn)

# ---------------- 族群動能（題材族群）----------------
themes = load(D + "/themes.json")
groups = {}
for g in themes["groups"]:
    for sub in g.get("subs", []):
        groups[f"{g['name']}/{sub['name']}"] = sub["codes"]
theme_codes = {c for lst in groups.values() for c in lst if common(c)}
UNIV["theme"] = {d: theme_codes for d in dates}
gtop, gbot = [], []
for i in range(5, len(dates)):
    d, p5 = dates[i], dates[i - 5]
    gr = {}
    for g, lst in groups.items():
        rs = [C[d][c] / C[p5][c] - 1 for c in lst if common(c) and C[d].get(c) and C[p5].get(c)]
        if len(rs) >= 3:
            gr[g] = (st.mean(rs), lst)
    if len(gr) < 10:
        continue
    s = sorted(gr, key=lambda g: gr[g][0])
    for g in s[-3:]:
        gtop += [(d, c) for c in gr[g][1] if common(c) and C[d].get(c)]
    for g in s[:3]:
        gbot += [(d, c) for c in gr[g][1] if common(c) and C[d].get(c)]
add("資金", "5 日最強 3 個題材族群的成分股", gtop, "theme")
add("資金", "5 日最弱 3 個題材族群的成分股", gbot, "theme")

# 同一套規則換成官方產業別：themes.json 是今天才整理的，偏向這兩年漲起來的族群；
# 官方產業一檔一類、跟著證交所走，沒有「事後挑進清單」的問題。
industry = load(D + "/industry.json")["map"]
ind_groups = defaultdict(list)
for code, name in industry.items():
    if common(code) and name not in ("其他", "存託憑證"):
        ind_groups[name].append(code)
ind_codes = {c for lst in ind_groups.values() for c in lst}
UNIV["ind"] = {d: ind_codes for d in dates}
itop, ibot = [], []
for i in range(5, len(dates)):
    d, p5 = dates[i], dates[i - 5]
    gr = {}
    for g, lst in ind_groups.items():
        rs = [C[d][c] / C[p5][c] - 1 for c in lst if C[d].get(c) and C[p5].get(c)]
        if len(rs) >= 5:
            gr[g] = st.mean(rs)
    if len(gr) < 10:
        continue
    s = sorted(gr, key=gr.get)
    for g in s[-3:]:
        itop += [(d, c) for c in ind_groups[g] if C[d].get(c)]
    for g in s[:3]:
        ibot += [(d, c) for c in ind_groups[g] if C[d].get(c)]
add("資金", "5 日最強 3 個官方產業的成分股", itop, "ind")
add("資金", "5 日最弱 3 個官方產業的成分股", ibot, "ind")

# ---------------- 輸出 ----------------
res = []
for name, (group, events, uni) in SIG.items():
    events = in_window(events)
    r = evaluate(events, uni)
    span = (min(e[0] for e in events), max(e[0] for e in events)) if events else ("", "")
    res.append(dict(group=group, name=name, uni=uni or "all", events=len(events), span=span, h=r))
print(f"groups parsed: {len(groups)}; dates {dates[0]}..{dates[-1]} ({len(dates)}); 評估 {BT_FROM}..{BT_TO}")
def fmt(s):
    if not s:
        return f"{'—':>34}"
    return f"{s['mean']:+6.2f}% beat{s['hit']:3.0f} t{s['t']:+5.1f} [{s['h1']:+5.1f}/{s['h2']:+5.1f}]"
for r in sorted(res, key=lambda r: r["group"]):
    print(f"{r['group']:<8} {r['name']:<26} {r['uni']:<6} n={r['events']:<6} | " +
          " | ".join(f"{h}d {fmt(r['h'][h])}" for h in HZ))


# ---------------- 多空對照：同一個門檻的「買方 − 賣方」----------------
# 跟同群比還不夠：法人單日 ≥0.3 億的股票不論買賣，都是比較大、比較有人關注的那一群，
# 本身就跑贏法人檔全體。拿同門檻的反向訊號當對照，兩邊的股票大小相近，相減剩下的才是方向的功勞。
PAIRS = [
    ("投信買超 ≥0.3 億", "投信賣超 ≥0.3 億"),
    ("外資買超 ≥0.3 億", "外資賣超 ≥0.3 億"),
    ("土洋同買（各 ≥0.3 億）", "土洋同賣（各 ≥0.3 億）"),
    ("外資剛滿連買 5 天", "外資剛滿連賣 5 天"),
    ("爆量收紅（≥5千張、20 日量新高）", "爆量收黑（≥5千張、20 日量新高）"),
    ("站上 MA20", "跌破 MA20"),
    ("剛變四線全上", "剛變四線全下"),
    ("MACD 黃金交叉", "MACD 死亡交叉"),
    ("突破（k5）", "破位（k5）"),
    ("回踩守住（k5）", "反彈受阻（k5）"),
    ("5 日最強 3 個題材族群的成分股", "5 日最弱 3 個題材族群的成分股"),
    ("5 日最強 3 個官方產業的成分股", "5 日最弱 3 個官方產業的成分股"),
]

def day_means(events, h):
    out = defaultdict(list)
    for d, code in in_window(events):
        r = fwd[h].get(d, {}).get(code)
        if r is not None:
            out[d].append(r)
    return {d: st.mean(v) for d, v in out.items()}

print()
print("多空對照（同日兩邊都有訊號的日子，買方平均 − 賣方平均）")
for a, b in PAIRS:
    cells = []
    for h in HZ:
        ma, mb = day_means(SIG[a][1], h), day_means(SIG[b][1], h)
        ds = sorted(set(ma) & set(mb))
        if len(ds) < 10:
            cells.append(f"{h}d —")
            continue
        sp = [ma[d] - mb[d] for d in ds]
        half = len(sp) // 2
        cells.append(f"{h}d {st.mean(sp) * 100:+5.2f}% t{nw_t(sp, h - 1):+5.1f} "
                     f"[{st.mean(sp[:half]) * 100:+5.1f}/{st.mean(sp[half:]) * 100:+5.1f}] d{len(ds)}")
    print(f"{a} − {b}".ljust(44) + " | ".join(cells))
