"""共用工具：用注意股的累積次數重建處置規則，算出「明天再被注意一次就處置」的候選。

## 規則（從資料反推，scripts/backtest_notice.py 驗證）

某一天被公布注意之後，下列任一條成立，交易所當天收盤後就公布處置（隔天起處置）：

    c1   連續 3 個營業日達第一款
    c18  連續 5 個營業日達第一款至第八款
    n10  最近 10 個營業日內有 6 個營業日達第一款至第八款
    n30  最近 30 個營業日內有 12 個營業日達第一款至第八款

只算**上一次處置公布日之後**的注意——處置公布那天，之前累積的次數全部歸零。不歸零的話，
「30 日內 12 日」這條會多出四百多次沒有發生的處置（多半是本益比過高的第六款常客）。

2021-10 ～ 2026-10 的 2,121 筆處置，這套規則對中 2,119 筆、沒有一次多報；2026-08 處置
改成 5 天、2 分鐘撮合之後，觸發條件沒變。第九款以後（成交量放大、當沖比率……）不算。

## 候選

收盤後（第 i 天），假設明天（i+1）再被注意一次：
- 不管哪一款都會處置 → `any`
- 只有第一款才會（連續 3 日第一款那條差一天）→ `k1`
"""

from __future__ import annotations

import bisect
import glob
import json
import os
from collections import defaultdict

A18 = frozenset(range(1, 9))
RULES = {"c1": "連續 3 日第一款", "c18": "連續 5 日注意", "n10": "10 日內 6 日注意", "n30": "30 日內 12 日注意"}


def trigger(days: dict, i: int, lo: int) -> str | None:
    """days：交易日序號 → 那天被注意的款（set）。只算 lo 之後（不含）的。第 i 天會不會處置？"""
    def has(j, S):
        return j > lo and j in days and days[j] & S

    def run(S):
        k = 0
        while has(i - k, S):
            k += 1
        return k

    if not has(i, A18):
        return None
    if run({1}) >= 3:
        return "c1"
    if run(A18) >= 5:
        return "c18"
    if sum(1 for j in range(i - 9, i + 1) if has(j, A18)) >= 6:
        return "n10"
    if sum(1 for j in range(i - 29, i + 1) if has(j, A18)) >= 12:
        return "n30"
    return None


def need(days: dict, i: int, lo: int) -> tuple[str, str] | None:
    """第 i 天收盤後：明天再被注意一次會不會處置 → (any／k1, 哪一條)；不會就 None"""
    probe = dict(days)
    probe[i + 1] = {2}                  # 第一款以外的任何一款
    r = trigger(probe, i + 1, lo)
    if r:
        return "any", r
    probe[i + 1] = {1}
    r = trigger(probe, i + 1, lo)
    return ("k1", r) if r else None


def load_notice(site: str, di: dict) -> dict:
    """notice/<年>.json → {代號: {交易日序號: set(款)}}，di 是日期 → 序號"""
    out = defaultdict(dict)
    for p in sorted(glob.glob(os.path.join(site, "notice", "*.json"))):
        with open(p, encoding="utf-8") as f:
            for d, code, _name, ks, _dir, _mk in json.load(f):
                if d in di:
                    out[code][di[d]] = set(ks)
    return out


def load_pubs(site: str, di: dict) -> dict:
    """disposal/<年>.json → {代號: 排好的處置公布日序號}"""
    out = defaultdict(set)
    for p in sorted(glob.glob(os.path.join(site, "disposal", "*.json"))):
        with open(p, encoding="utf-8") as f:
            for e in json.load(f):
                if e[0] in di:
                    out[e[1]].add(di[e[0]])
    return {c: sorted(s) for c, s in out.items()}


def last_pub(pubs: list, i: int, inclusive: bool = True) -> int:
    """i（含或不含）以前最後一次處置公布日的序號；沒有就 −1"""
    k = (bisect.bisect_right if inclusive else bisect.bisect_left)(pubs, i)
    return pubs[k - 1] if k else -1
