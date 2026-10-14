"""回測 RSI：在台股，RSI 是「反轉」還是「動能」？以及拿它當已成立訊號的濾網有沒有用。

    python scripts/backtest_rsi.py                                  用 docs/data（網站只留兩年）
    GOOAYE_DATA=<解壓後的 docs/data> python scripts/backtest_rsi.py   用長歷史（2021-10 起）

只印表，不寫檔；結論整理在 BACKTEST.md。進出場、超額、t 值與分段都跟 backtest_gooaye_daily.py
同一套（直接 import 它）：訊號日隔天開盤進場、減全體普通股等權平均、Newey-West。

- RSI 用 Wilder 平滑，算在還原後的收盤上；中間缺值就重新起算
- 穿越類的訊號同一檔 20 個交易日內只算第一次，免得同一段行情重複計數
- 多空對照：同一天兩邊都有訊號才相減，剩下的才是方向的功勞
"""

from __future__ import annotations

import statistics as st
from collections import defaultdict

import backtest_gooaye_daily as B
from backtest_gooaye_daily import AC, COMMONS, HZ, N, bench, dates, evaluate, nw_t, print_rows, ret

GAP = 20


def rsi(xs, n=14):
    """Wilder RSI；前 n 個有效值用簡單平均起頭，碰到缺值重來。"""
    out = [None] * len(xs)
    k, up, dn, prev = 0, 0.0, 0.0, None
    for i, v in enumerate(xs):
        if v is None:
            k, up, dn, prev = 0, 0.0, 0.0, None
            continue
        if prev is not None:
            ch = v / prev - 1
            u, d = max(ch, 0.0), max(-ch, 0.0)
            k += 1
            if k <= n:
                up += u / n
                dn += d / n
            else:
                up = (up * (n - 1) + u) / n
                dn = (dn * (n - 1) + d) / n
            if k >= n:
                out[i] = 100.0 if dn == 0 else 100 - 100 / (1 + up / dn)
        prev = v
    return out


R14 = {c: rsi(AC[c], 14) for c in COMMONS + ["0050"]}
R2 = {c: rsi(AC[c], 2) for c in COMMONS}


def crosses(rs, cond, gap=GAP):
    """cond(前一天, 今天) 成立的日子；同一檔 gap 天內只取第一次。"""
    ev = []
    for c in COMMONS:
        r, last = rs[c], -999
        for i in range(1, N):
            a, b = r[i - 1], r[i]
            if a is None or b is None or not cond(a, b):
                continue
            if i - last > gap:
                ev.append((i, c))
            last = i
    return ev


def paired(name, long_ev, short_ev):
    """同一天兩邊都有訊號：多方平均報酬 − 空方平均報酬。"""
    L, S = defaultdict(list), defaultdict(list)
    for i, c in long_ev:
        L[i].append(c)
    for i, c in short_ev:
        S[i].append(c)
    print(f"  {name}")
    for h in HZ:
        dm, seg = [], defaultdict(list)
        for i in sorted(set(L) & set(S)):
            a = [r for c in L[i] if (r := ret(c, i, h)) is not None]
            b = [r for c in S[i] if (r := ret(c, i, h)) is not None]
            if a and b:
                m = st.fmean(a) - st.fmean(b)
                dm.append(m)
                seg["2022" if dates[i].startswith("2022") else ("≤2021" if dates[i] < "2022" else "2023+")].append(m)
        if dm:
            print(f"    {h:>2} 日  {len(dm):>4} 天  多−空 {st.fmean(dm) * 100:+.2f}%（t {nw_t(dm, h - 1):.1f}）  "
                  f"勝率 {st.fmean(x > 0 for x in dm) * 100:.0f}%  "
                  + "  ".join(f"{k} {st.fmean(v) * 100:+.2f}%" for k, v in sorted(seg.items())))


def standalone():
    up70 = crosses(R14, lambda a, b: a < 70 <= b)
    dn30 = crosses(R14, lambda a, b: a > 30 >= b)
    back30 = crosses(R14, lambda a, b: a < 30 <= b)
    back70 = crosses(R14, lambda a, b: a > 70 >= b)
    up50 = crosses(R14, lambda a, b: a < 50 <= b)
    dn50 = crosses(R14, lambda a, b: a > 50 >= b)
    ext_lo = crosses(R14, lambda a, b: a > 20 >= b)
    ext_hi = crosses(R14, lambda a, b: a < 80 <= b)
    evaluate("RSI14 上穿 70（教科書：超買→賣）", up70)
    evaluate("RSI14 跌破 30（教科書：超賣→買）", dn30)
    evaluate("RSI14 從 30 下回升（超賣後回頭）", back30)
    evaluate("RSI14 從 70 上回落（超買後回頭）", back70)
    evaluate("RSI14 上穿 50", up50)
    evaluate("RSI14 跌破 50", dn50)
    evaluate("RSI14 跌破 20（極端超賣）", ext_lo)
    evaluate("RSI14 上穿 80（極端超買）", ext_hi)
    r2lo = crosses(R2, lambda a, b: a > 10 >= b, gap=5)
    r2hi = crosses(R2, lambda a, b: a < 90 <= b, gap=5)
    evaluate("RSI2 跌破 10（短線超賣，Connors）", r2lo)
    evaluate("RSI2 上穿 90（短線超買）", r2hi)
    print_rows("RSI 單獨當訊號（超額＝減全體普通股等權平均）")
    print("\n=== 多空對照（同一天兩邊都有才算） ===")
    paired("上穿 70 − 跌破 30（動能派）", up70, dn30)
    paired("從 30 回升 − 從 70 回落（反轉派的進出場）", back30, back70)
    paired("上穿 50 − 跌破 50", up50, dn50)
    paired("RSI2 跌破 10 − 上穿 90（短線反轉）", r2lo, r2hi)


def split_by_rsi(name, events):
    """把一組已成立的訊號，依進場前一天（訊號日）的 RSI14 切三段。"""
    hi, mid, lo = [], [], []
    for i, c in events:
        r = R14[c][i]
        if r is None:
            continue
        (hi if r >= 70 else mid if r >= 50 else lo).append((i, c))
    evaluate(f"{name}：RSI ≥70", hi)
    evaluate(f"{name}：RSI 50～70", mid)
    evaluate(f"{name}：RSI <50", lo)
    return hi, lo


def filters():
    B.ROWS.clear()
    post = B.h6_pre_announce()
    base = B.h12_base()
    B.ROWS.clear()                              # 原本的列不重印，只看切開之後
    evaluate("H6 營收創高＋YoY>20%（全部）", post)
    h6hi, h6lo = split_by_rsi("H6 營收創高", post)
    evaluate("H12 整理後突破（全部）", base)
    h12hi, h12lo = split_by_rsi("H12 整理後突破", base)
    print_rows("濾網：已成立的訊號，依訊號日 RSI14 切開")
    print("\n=== 濾網的多空對照（同一天兩邊都有才算） ===")
    paired("H6：RSI ≥70 − RSI <50", h6hi, h6lo)
    paired("H12：RSI ≥70 − RSI <50", h12hi, h12lo)


def market():
    r, x = R14["0050"], AC["0050"]
    print("\n=== 大盤：0050 RSI14 的位置與之後的 0050 報酬（還原） ===")
    for lab, cond in (("全部日子", lambda v: True), ("RSI < 30", lambda v: v < 30), ("RSI < 25", lambda v: v < 25),
                      ("RSI 30～70", lambda v: 30 <= v < 70), ("RSI ≥ 70", lambda v: v >= 70),
                      ("RSI ≥ 80", lambda v: v >= 80)):
        for h in (20, 60, 120):
            rs = [q for i in range(N) if r[i] is not None and cond(r[i]) and (q := ret("0050", i, h)) is not None]
            if rs:
                yrs = sorted({dates[i][:4] for i in range(N) if r[i] is not None and cond(r[i])})
                print(f"  {lab:<12} {h:>3} 日  n={len(rs):>4}  平均 {st.fmean(rs) * 100:+.2f}%  "
                      f"上漲比例 {st.fmean(q > 0 for q in rs) * 100:.0f}%" + (f"  年份 {','.join(yrs)}" if lab != "全部日子" and h == 20 else ""))


if __name__ == "__main__":
    print(f"資料：{dates[0]} ~ {dates[-1]}，{N} 個交易日")
    standalone()
    filters()
    market()
