"""抓上市公司的產業別 → docs/data/industry.json

證交所的公司基本資料裡，產業別是代碼（台積電是 "24"），這裡轉成中文再存，
前端就不必再帶一份對照表。

ETF、特別股不在「公司」基本資料裡，對照不到的代號由讀取端自行歸類
（規則見 docs/app.js 的 industryOf()）。

用法：
    python scripts/fetch_industry.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime

import twse

COMPANY_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L"

INDUSTRY_PATH = twse.DATA_DIR / "industry.json"

# 證交所的產業別代碼對照。含目前資料裡沒出現、但歷史上用過的代碼（07／13／19 等），
# 之後若證交所新增代碼，會落到「其他」並在執行時印出提醒。
INDUSTRY_NAMES = {
    "01": "水泥工業",
    "02": "食品工業",
    "03": "塑膠工業",
    "04": "紡織纖維",
    "05": "電機機械",
    "06": "電器電纜",
    "07": "化學生技醫療",
    "08": "玻璃陶瓷",
    "09": "造紙工業",
    "10": "鋼鐵工業",
    "11": "橡膠工業",
    "12": "汽車工業",
    "13": "電子工業",
    "14": "建材營造",
    "15": "航運業",
    "16": "觀光餐旅",
    "17": "金融保險",
    "18": "貿易百貨",
    "19": "綜合",
    "20": "其他",
    "21": "化學工業",
    "22": "生技醫療業",
    "23": "油電燃氣業",
    "24": "半導體業",
    "25": "電腦及週邊設備業",
    "26": "光電業",
    "27": "通信網路業",
    "28": "電子零組件業",
    "29": "電子通路業",
    "30": "資訊服務業",
    "31": "其他電子業",
    "32": "文化創意業",
    "33": "農業科技業",
    "34": "電子商務",
    "35": "綠能環保",
    "36": "數位雲端",
    "37": "運動休閒",
    "38": "居家生活",
    "80": "管理股票",
    "91": "存託憑證",
}


def main() -> int:
    rows = twse.fetch_json(COMPANY_URL)
    if not rows:
        print("公司基本資料回傳空資料")
        return 1

    mapping = {}
    unknown = {}
    for row in rows:
        code = str(row.get("公司代號", "")).strip()
        if not twse.is_tracked_code(code):
            continue
        raw = str(row.get("產業別", "")).strip()
        name = INDUSTRY_NAMES.get(raw)
        if name is None:
            unknown[raw] = unknown.get(raw, 0) + 1
            name = "其他"
        mapping[code] = name

    if not mapping:
        print("沒有對應到任何代號，欄位格式可能已改變")
        return 1

    payload = {
        "updated": datetime.now(twse.TAIPEI).isoformat(timespec="seconds"),
        "map": dict(sorted(mapping.items())),
    }

    # 內容沒變就不重寫，避免每天產生無謂的 git 差異（updated 也一併沿用舊值）
    if INDUSTRY_PATH.exists():
        old = json.loads(INDUSTRY_PATH.read_text(encoding="utf-8"))
        if old.get("map") == payload["map"]:
            print(f"industry.json：{len(mapping)} 檔，內容未變動，不重寫")
            return 0

    twse.write_json(INDUSTRY_PATH, payload)
    kinds = len(set(mapping.values()))
    print(f"industry.json：{len(mapping)} 檔、{kinds} 個產業")
    if unknown:
        print(f"  ! 未知的產業別代碼（已歸為「其他」）：{unknown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
