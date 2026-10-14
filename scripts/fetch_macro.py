"""抓總經數字 -> docs/data/macro.json（FRED，免金鑰）。

MK 頁的大盤溫度計要用：他講過「VIX 彈破 30 就加碼」「油價 120～130 以上就退場」
「初領失業金是景氣轉壞的第一個警訊」，回測結果在 BACKTEST.md（backtest_gooaye_market.py）。

    VIXCLS        VIX 恐慌指數（日）
    DCOILBRENTEU  布蘭特原油（日，美元／桶）
    DGS10         美國 10 年期公債殖利率（日，%）
    DTWEXBGS      美元廣義指數（日；DXY 只有六種貨幣，這個是 FRED 自己的貿易加權版本）
    ICSA          初領失業救濟金人數（週）
    CPIAUCSL      CPI（月）→ 這裡存年增率

每一條只留最近 MAX_DAYS 個日曆天；每次整份重抓（FRED 的 CSV 是全歷史，一條幾百 KB 而已），
抓不到的那一條沿用舊檔，不要讓一條掛掉把整份清空。

    python scripts/fetch_macro.py
"""

from __future__ import annotations

from datetime import date, timedelta

import requests

import twse

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id="
OUT = twse.DATA_DIR / "macro.json"
MAX_DAYS = 3 * 366
SERIES = {
    "vix": "VIXCLS",
    "brent": "DCOILBRENTEU",
    "us10y": "DGS10",
    "usd": "DTWEXBGS",
    "icsa": "ICSA",
    "cpi": "CPIAUCSL",
}


def fetch(series_id: str) -> list:
    r = requests.get(URL + series_id, timeout=60, headers=twse.HEADERS)
    r.raise_for_status()
    rows = []
    for line in r.text.splitlines()[1:]:
        d, _, v = line.partition(",")
        if v and v != ".":
            rows.append((d, float(v)))
    if not rows:
        raise RuntimeError(f"{series_id} 是空的")
    return rows


def main() -> int:
    old = twse.read_json(OUT) if OUT.exists() else {}
    cut = (date.today() - timedelta(days=MAX_DAYS)).isoformat()
    out = {}
    for key, sid in SERIES.items():
        try:
            rows = fetch(sid)
        except Exception as err:   # 一條掛掉沿用舊的
            print(f"  ! {sid}：{err}，沿用舊資料")
            if key in old:
                out[key] = old[key]
            continue
        if key == "cpi":           # 存年增率
            vals = dict(rows)
            months = [d for d, _ in rows]
            rows = [(d, round((vals[d] / vals[months[i - 12]] - 1) * 100, 2)) for i, d in enumerate(months) if i >= 12]
        if key == "icsa":          # 四週平均，跟新聞常用的口徑一樣
            rows = [(rows[i][0], round(sum(v for _, v in rows[i - 3:i + 1]) / 4)) for i in range(3, len(rows))]
        rows = [(d, v) for d, v in rows if d >= cut or key == "cpi" and d >= cut[:7]]
        out[key] = {"d": [d for d, _ in rows], "v": [v for _, v in rows]}
        print(f"  {sid}：{len(rows)} 筆，最新 {rows[-1][0]} = {rows[-1][1]}")
    changed = twse.write_if_changed(OUT, out)
    print("已更新" if changed else "沒有變化")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
