"""診斷用：拿每一檔美股去掃**全市場**台股，看「發現式相關性排行」做不做得起來。

**這一支不在每日排程裡，也不產生任何網站要吃的檔案。** 它存在的理由是讓
ROADMAP 上「不做發現式排行」這個結論可以被重跑、被推翻。

## 它在回答什麼

美股頁的配對來自人工維護的 `us_link.json`。很自然會想：為什麼不讓資料自己找？
把每一檔美股對全市場台股都算一次相關係數，排出來就好了。

問題是**多重檢定**與**共同因子**。這一支把兩者都算給你看。

## 三種算法，結果差很多

    --factors 0   只算原始相關（不扣任何東西）
    --factors 1   兩邊各自扣掉自己市場的大盤（＝美股頁的「超額相關」）
    --factors 2   再扣掉一個科技因子（^SOX）

門檻一律用 Bonferroni 校正過的顯著水準：檢定數是「美股檔數 × 台股檔數」，
二十幾萬組，不校正的話 |r| > 18% 就有幾千組「顯著」，那全是雜訊。

## 2026-09-18 那一天跑出來的（見 ROADMAP）

    --factors 1   通過 2,873 組。**前 20 名全是 COST（好市多）**，對象是生技、
                  食品、電機、航運 —— 全部的非科技台股。原因是扣掉 ^IXIC 之後
                  COST 的殘差本質上是「非科技」，而 ^TWII 有六成是電子，所以扣掉
                  之後每一檔非科技台股的殘差也是「非科技」。兩邊剩下的是同一個
                  潛在因子，不是連動。
    --factors 2   通過 10 組，而且是 Hurco × 建材營造、EMCOR × 金融保險 這種
                  語意上毫無道理的組合。**人工標的 176 組 ★★★ 一組都沒通過**，
                  中位數只剩 +9%。

也就是說：這一頁量得到的連動，絕大部分就是「同一個產業一起動」。扣到只剩公司自己
的部分時，人工標註聲稱的那種關係也跟著消失了 —— 發現式排行沒有東西可以發現。

ETF／ETN 一律排除（規則同 app.js 的 industryOf()：代號以 00 開頭）。不排的話榜首
會是 00876 元大全球半導體 × LRCX 之類 —— 那檔 ETF 本來就持有被檢定的那幾檔美股，
「相關」是套套邏輯。

用法：
    python scripts/scan_us.py                  # 預設 --method sub
    python scripts/scan_us.py --method reg2
    python scripts/scan_us.py --method reg2 --top 30
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from operator import mul
from statistics import NormalDist

import twse
import us


def parse_args():
    ap = argparse.ArgumentParser(description="拿美股掃全市場台股（診斷用）")
    ap.add_argument("--method", default="sub", choices=("raw", "sub", "reg1", "reg2"),
                    help="raw 不扣；sub 減 1×大盤（＝頁面現行的超額相關）；"
                         "reg1 對大盤做迴歸取殘差；reg2 再加一個 ^SOX")
    ap.add_argument("--top", type=int, default=20, help="列出前幾名")
    ap.add_argument("--alpha", type=float, default=0.05, help="校正前的顯著水準")
    return ap.parse_args()


def center(v: list) -> list:
    mu = sum(v) / len(v)
    return [x - mu for x in v]


def unit(v: list):
    n = math.sqrt(sum(x * x for x in v))
    return None if n <= 0 else [x / n for x in v]


def project_out(v: list, basis: list) -> list:
    """把 v 裡與 basis（已正交化的單位向量）相關的成分拿掉，也就是多元迴歸的殘差。"""
    out = list(v)
    for b in basis:
        c = sum(map(mul, out, b))
        out = [x - c * y for x, y in zip(out, b)]
    return out


def orthonormal(vectors: list) -> list:
    """Gram–Schmidt。因子之間本來就高度相關（^SOX 與 ^IXIC），不正交化算不準。"""
    basis = []
    for v in vectors:
        u = unit(project_out(center(v), basis))
        if u:
            basis.append(u)
    return basis


def main() -> int:
    args = parse_args()

    index = json.loads(twse.INDEX_PATH.read_text(encoding="utf-8"))
    kline = index.get("kline") or {}
    floor = min((kline[m]["from"] for m in kline), default="")
    tw_dates = [d for d in index["dates"] if d >= floor]

    market = json.loads(us.MARKET_PATH.read_text(encoding="utf-8"))
    axis = market["d"]
    closes = {s: {d: c for d, c in zip(axis, r["c"]) if c is not None}
              for s, r in market["items"].items()}
    us_names = {s: r["n"] for s, r in market["items"].items()}

    us_axis = sorted(closes.get(us.US_INDEX) or {})
    twii = us.returns(closes.get(us.TW_INDEX) or {}, tw_dates)
    ixic = us.returns(closes[us.US_INDEX], us_axis)
    # 共同軸：美股 D 對上台股 D+1 之後兩邊都有值的那些台股交易日
    common = [d for d, _, _ in us.align(ixic, twii, tw_dates)]

    def on_common(series_by_tw_date: dict):
        row = [series_by_tw_date.get(d) for d in common]
        return None if any(v is None for v in row) else row

    def aligned(series: dict) -> dict:
        """美股的序列對齊到台股日期軸。"""
        return {d: v for d, v, _ in us.align(series, twii, tw_dates)}

    skip = {us.TW_INDEX, us.US_INDEX}
    tw_factors, us_factors = [], []
    if args.method in ("reg1", "reg2"):
        tw_factors.append([twii.get(d) for d in common])
        us_factors.append(on_common(aligned(ixic)))
    if args.method == "reg2":
        sox = us.returns(closes["^SOX"], us_axis)
        tw_factors.append(on_common(aligned(sox)))
        us_factors.append(on_common(aligned(sox)))
        skip.add("^SOX")
    F_tw = orthonormal([f for f in tw_factors if f and all(v is not None for v in f)])
    F_us = orthonormal([f for f in us_factors if f and all(v is not None for v in f)])

    industry = json.loads((twse.DATA_DIR / "industry.json").read_text(encoding="utf-8"))["map"]

    codes = []
    for m in ("twse", "tpex"):
        path = twse.KLINE_DIR / m
        if path.is_dir():
            codes += [d.name for d in path.iterdir() if d.is_dir()]
    # ETF／ETN 與特別股排掉，理由見檔頭
    codes = sorted({c for c in codes if not c.startswith("00") and c.isdigit()})

    def residual(series_by_tw_date: dict, basis: list, market_ret: dict):
        """殘差向量。sub 是**減 1×大盤**，reg 是**對大盤做迴歸**——兩者差很多。

        減 1× 等於把 beta 寫死成 1：beta 不是 1 的股票，殘差裡會留著
        (beta − 1) × 大盤。台股加權有六成是電子，所以非科技股（beta 小）減完之後
        還帶著一大塊「負的大盤」，而美股那邊的非科技股同理 —— 兩邊那一塊會互相
        對上，看起來就像連動。COST 那個假訊號就是這麼來的。
        """
        if args.method == "sub":
            raw = {d: v - market_ret[d] for d, v in series_by_tw_date.items()
                   if d in market_ret}
        else:
            raw = series_by_tw_date
        row = on_common(raw)
        return None if row is None else unit(project_out(center(row), basis))

    ixic_tw = aligned(ixic)          # 美股大盤，對齊到台股日期軸

    tw_vec = {}
    for code in codes:
        v = residual(us.returns(us.tw_closes(code), tw_dates), F_tw, twii)
        if v:
            tw_vec[code] = v

    us_vec = {}
    for sym in sorted(closes):
        if sym in skip:
            continue
        v = residual(aligned(us.returns(closes[sym], us_axis)), F_us, ixic_tw)
        if v:
            us_vec[sym] = v

    n = len(common) - len(F_tw)          # 每扣一個因子就少一個自由度
    tests = len(us_vec) * len(tw_vec)
    if not tests or n <= 4:
        print("資料不足，算不出來")
        return 1
    z = NormalDist().inv_cdf(1 - args.alpha / (2 * tests))
    crit = math.tanh(z / math.sqrt(n - 3))

    what = {"raw": "不扣任何因子（原始相關）",
            "sub": "兩邊各減 1×自己的大盤（＝頁面現行的超額相關）",
            "reg1": "對自己的大盤做迴歸取殘差（beta 讓資料決定）",
            "reg2": "對大盤 + ^SOX 兩個因子做迴歸取殘差"}[args.method]
    print(f"算法：{what}")
    print(f"台股 {len(tw_vec)} 檔（已排除 ETF／ETN／特別股）× 美股 {len(us_vec)} 檔"
          f" = {tests:,} 組檢定，每組 {n} 個對齊日")
    print(f"Bonferroni（α={args.alpha}）：z > {z:.2f}，也就是 |r| ≥ {crit * 100:.1f}%")

    hits = []
    for sym, uv in us_vec.items():
        for code, tv in tw_vec.items():
            r = sum(map(mul, uv, tv))
            if abs(r) >= crit:
                hits.append((r, sym, code))
    expected = args.alpha            # 校正之後，整批的偽陽性期望值就是 α
    print(f"\n通過 {len(hits):,} 組（{len(hits) / tests * 100:.3f}%）"
          f"；全部都是雜訊的話期望值是 {expected} 組")

    if hits:
        by_sym = Counter(s for _, s, _ in hits)
        print(f"命中最多的美股：{by_sym.most_common(5)}")
        print("通過的台股落在哪些產業：")
        for name, count in Counter(industry.get(c, "未分類") for _, _, c in hits).most_common(6):
            print(f"   {name:<14} {count:>5} 組")
        hits.sort(key=lambda t: -abs(t[0]))
        print(f"\n前 {args.top} 名：")
        for r, sym, code in hits[:args.top]:
            print(f"  {sym:<8} {us_names.get(sym, ''):<10} × {code:<6}"
                  f" {industry.get(code, '未分類'):<12} {r * 100:+.0f}%")

    # 人工標 ★★★ 的那些在這個算法下還剩多少 —— 這才是真正要問的問題
    pairs = us.pairs_of(us.load_link(), us.load_themes())
    star3 = [(s, c) for s in pairs for c, _, _, strength in pairs[s] if strength == 3]
    vals = sorted(sum(map(mul, us_vec[s], tw_vec[c]))
                  for s, c in star3 if s in us_vec and c in tw_vec)
    if vals:
        passed = sum(1 for v in vals if abs(v) >= crit)
        print(f"\n人工標 ★★★ 共 {len(star3)} 組，算得出的 {len(vals)} 組，"
              f"通過門檻的 {passed} 組")
        print(f"  它們的相關性：中位 {vals[len(vals) // 2] * 100:+.0f}%、"
              f"最高 {vals[-1] * 100:+.0f}%、最低 {vals[0] * 100:+.0f}%")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
