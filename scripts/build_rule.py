"""紀律頁的資料：全市場每一檔的出場線，加上加權指數 -> docs/data/rule.json。

紀律頁（rule.html）要回答的是「今天照規則該做什麼」，它用到的判斷全都是
「收盤價在某一條均線的哪一邊」：

    大盤溫控    加權指數跌破 10／20／60 日線 -> 現金至少三成／五成／只留超長線
    短線        個股跌破 10 日線就出場；進場是「剛站上 10 日線的第一、二天」
    中線        站上月線（20 日）進、跌破月線出
    長線        跌破月線小買、跌破季線（60 日）多買、跌破年線（240 日）大買

所以這一份只放「每一檔今天在每一條線的哪一邊、連續幾天」與那幾條線的值，
判斷留給前端 —— 規則本身寫在一個地方（rule.js），這裡不重複一份。

## 為什麼不直接用 daily/ 的 ma／mav

daily/ 只有成交值前 300 名。紀律頁的持股是使用者自己輸入的，而短線掃描要看的
正是「還沒進榜、剛開始轉強」的那些 —— 所以要全市場，只能從 close/ 算。

## 年線的收盤價從哪來

close/ 只從 2026-03-16 開始存，不夠 240 天。更早的那一段用 daily/all/ 補：
那裡只有前 300 名，但長線策略的標的本來就是最大的權值股（台積電、聯發科那一級），
它們每天都在榜上，序列是連續的。不在榜上的那幾天就是缺口 —— 缺口一律讓序列
從頭算起，寧可算不出年線也不拿斷掉的序列硬湊（與 build_history.py 同一套規則）。

## 「連續幾天」與資料不足

連續站上／跌破的天數帶正負號。序列是從資料起點或缺口後才開始的那一段，
在還沒走滿 `TRUST_DAYS` 天之前一律回 null：「有資料的那 3 天都站上」不等於
「剛站上 3 天」，後者才是短線要的訊號（與 build_history.py 的 MA_TRUST_DAYS 同義）。

## 外資連買

短線的進場條件之一。直接讀 build_institutions.py 算好的 insti/streak/，
只在它與收盤價是同一天時才帶進來；日期對不上就整欄留空，前端會說出來。

用法：
    python scripts/build_rule.py
"""

from __future__ import annotations

import sys
from collections import deque

import structure
import twse

RULE_PATH = twse.DATA_DIR / "rule.json"
TAIEX_PATH = twse.DATA_DIR / "taiex.json"
STREAK_DIR = twse.DATA_DIR / "insti" / "streak"

MARKETS = ("twse", "tpex")

# 要算的均線，順序即檔案裡 ma／s 兩組欄位的順序。5 日線只用來判斷多頭排列，不出值。
WINDOWS = (5, 10, 20, 60, 240)
OUT_WINDOWS = (10, 20, 60, 240)
STREAK_WINDOWS = (10, 20, 60)

# 連續天數最多算到這裡，超過就停在這裡（前端顯示成 60+）
STREAK_MAX = 60

# 序列是截斷的（資料起點、缺口）時，要連續這麼多天才信得過「連續幾天」
TRUST_DAYS = 11

# 每一檔存的欄位，順序即 index。前端 rule.js 的 S_* 常數必須一致。
#   name   簡稱
#   close  收盤
#   chg    漲跌 %（沒有昨收為 null）
#   ma10 ma20 ma60 ma240   均線值（湊不滿為 null）
#   s10 s20 s60            連續站上（正）／跌破（負）幾天，資料不足為 null
#   bull   1 = 均線多頭排列（5 > 10 > 20 > 60 日線），0 = 不是，null = 算不出來
#   fo     外資連續買（正）賣（負）超天數，只有 3 天以上才有，其餘 null
FIELDS = ("name", "close", "chg", "ma10", "ma20", "ma60", "ma240",
          "s10", "s20", "s60", "bull", "fo")


def load_closes(date_iso: str, market: str):
    """close/ 的當日收盤價 {代號: 收}；沒有這個檔就回 None。"""
    path = twse.close_path(date_iso, market)
    if not path.exists():
        return None
    return twse.read_json(path)["c"]


def load_ranked(date_iso: str):
    """daily/all/ 的當日前 300 名：({代號: 收}, {代號: 簡稱})。"""
    raw = twse.read_json(twse.daily_path(date_iso, "all"))
    closes, names = {}, {}
    for s in raw.get("stocks") or []:
        if s.get("close") is not None:
            closes[s["code"]] = s["close"]
            names[s["code"]] = s.get("name")
    return closes, names


def calendar():
    """由舊到新的 [(日期, {代號: 收})]、全部看過的簡稱、close/ 的第一天。

    close/ 開始之後只用 close/（兩個市場都要有，缺一邊就整天略過 —— 那一天另一邊的
    股票全都會被當成缺口）；之前的日子用 daily/all/ 的前 300 名。
    """
    close_dates = sorted(set(twse.existing_close_dates("twse"))
                         & set(twse.existing_close_dates("tpex")))
    if not close_dates:
        return [], {}, None
    first = close_dates[0]

    days, names = [], {}
    for date_iso in twse.existing_dates("all"):
        if date_iso >= first:
            break
        closes, seen = load_ranked(date_iso)
        names.update(seen)
        days.append((date_iso, closes))

    for date_iso in close_dates:
        merged = {}
        for market in MARKETS:
            merged.update(load_closes(date_iso, market) or {})
        days.append((date_iso, merged))
    return days, names, first


def step_run(run, side):
    """連續同側天數：run 是 (側, 天數, 是否截斷) 或 None（昨天算不出來）。"""
    if run is None:
        return (side, 1, True)
    if run[0] == side:
        return (side, min(run[1] + 1, STREAK_MAX), run[2])
    return (side, 1, False)


def run_value(run):
    if run is None:
        return None
    return None if run[2] and run[1] < TRUST_DAYS else run[0] * run[1]


def gaps(days: list, trading: list) -> set:
    """哪幾天的前一個交易日沒有檔案（排程漏跑、回補沒補到）。

    交易日曆取加權指數那一份：它是證交所按月給的，不會漏（但只從它的第一天開始有，
    更早的那一段只能相信檔案順序）。照檔案順序往前接的話，
    漏掉的那一天會被跳過，均線就少算了一天而沒有人看得出來。
    """
    slot = {d: i for i, d in enumerate(trading)}
    out = set()
    for (prev, _), (date_iso, _) in zip(days, days[1:]):
        at = slot.get(date_iso)
        if at and slot.get(prev) != at - 1:      # at == 0 是日曆的起點，前面本來就沒有
            out.add(date_iso)
    return out


def track(days: list, broken: set) -> dict:
    """逐日推進每一檔，回傳最後一天的 {代號: (收, 昨收, 各均線, 各連續天數)}。

    只有最後一天有交易的才會出現在結果裡。broken 裡的日子整個市場從頭算。
    """
    state = {}       # code -> {"seq", "closes", "runs"}
    last = {}
    for seq, (date_iso, closes) in enumerate(days):
        if date_iso in broken:
            state.clear()
        last = {}
        for code, close in closes.items():
            st = state.get(code)
            if st is None or st["seq"] != seq - 1:
                # 第一次出現，或昨天不在（停牌、掉出前 300 名）：從頭算
                st = {"seq": seq, "closes": deque(maxlen=max(WINDOWS)),
                      "runs": {w: None for w in STREAK_WINDOWS}}
                state[code] = st
            prev = st["closes"][-1] if st["closes"] else None
            st["seq"] = seq
            st["closes"].append(close)

            ma = {}
            total = 0.0
            for n, price in enumerate(reversed(st["closes"]), start=1):
                total += price
                if n in WINDOWS:
                    ma[n] = total / n
            for w in STREAK_WINDOWS:
                st["runs"][w] = (step_run(st["runs"][w], 1 if close > ma[w] else -1)
                                 if w in ma else None)
            last[code] = (close, prev, ma, {w: run_value(st["runs"][w]) for w in STREAK_WINDOWS})
    return last


def foreign_streak(date_iso: str) -> dict:
    """同一天的外資連續買賣超天數 {代號: 天數}；那天的檔案不存在就回空的。"""
    path = STREAK_DIR / f"{date_iso}.json"
    if not path.exists():
        return {}
    raw = twse.read_json(path)
    i_days = raw["fields"].index("days")
    return {code: row[i_days]
            for stocks in (raw.get("stocks") or {}).values()
            for code, row in stocks.items()}


def main() -> int:
    days, ranked_names, close_first = calendar()
    if not days:
        print("docs/data/close/ 沒有任何收盤價，請先執行 fetch_daily.py 或 backfill.py")
        return 1
    date_iso = days[-1][0]

    taiex = twse.read_json(TAIEX_PATH) if TAIEX_PATH.exists() else None
    broken = gaps(days, taiex["d"]) if taiex else set()

    _, names = structure.load_industry()
    fo = foreign_streak(date_iso)
    rows = {}
    for code, (close, prev, ma, runs) in sorted(track(days, broken).items()):
        stack = [ma.get(w) for w in (5, 10, 20, 60)]
        bull = None if None in stack else int(all(a > b for a, b in zip(stack, stack[1:])))
        name = structure.name_of(code, names)
        if name == code:
            name = ranked_names.get(code) or code
        rows[code] = [
            name, twse.trim(close),
            None if not prev else round((close / prev - 1) * 100, 2),
            *(None if w not in ma else round(ma[w], 2) for w in OUT_WINDOWS),
            *(runs[w] for w in STREAK_WINDOWS),
            bull, fo.get(code),
        ]

    payload = {
        "date": date_iso,
        "v": 1,
        "fields": list(FIELDS),
        # 年線的序列從哪一天開始湊（daily/all 的第一天），與全市場收盤從哪一天開始有
        "first": days[0][0],
        "closeFirst": close_first,
        "trust": TRUST_DAYS,
        "foDate": date_iso if fo else None,
        "taiex": taiex,
        "stocks": rows,
    }
    changed = twse.write_if_changed(RULE_PATH, payload)

    n240 = sum(1 for r in rows.values() if r[FIELDS.index("ma240")] is not None)
    print(f"rule.json：{date_iso}，{len(rows)} 檔（年線算得出 {n240} 檔），"
          f"外資連買 {len(fo)} 檔，{'已更新' if changed else '無變化'}")
    if not taiex:
        print("  ! 沒有 taiex.json，大盤溫控會是空的 —— 請先執行 fetch_taiex.py")
    elif taiex["d"][-1] != date_iso:
        print(f"  ! 加權指數停在 {taiex['d'][-1]}，與收盤價的 {date_iso} 對不上")
    if broken:
        print(f"  ! 這幾天的前一個交易日沒有檔案，序列在那裡從頭算：{'、'.join(sorted(broken))}")
    if not fo:
        print(f"  ! insti/streak/{date_iso}.json 不存在，外資連買那一欄整欄留空")
    return 0


if __name__ == "__main__":
    sys.exit(main())
