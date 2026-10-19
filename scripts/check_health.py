"""每日排程的健康檢查：哪幾步失敗了、哪幾頁的資料沒跟上，有問題就推一則 Telegram。

    STEPS='${{ toJSON(steps) }}' python scripts/check_health.py   # 排程最後一步（if: always()）
    python scripts/check_health.py --dry-run                        # 本機：只看資料新鮮度，印出來不發

## 為什麼要有

排程大多數步驟設了 continue-on-error：一個來源掛掉，不該拖垮整天的更新。代價是失敗也是綠燈——
GitHub 的 API 對這種步驟一樣回報 success。2026-10 營收、處置、期貨、策略四頁就這樣停了好幾天
（numpy 沒裝），畫面看起來完全正常。

兩種檢查：

1. **步驟**：`steps.<id>.outcome` 是 continue-on-error 之前的真實結果。只有帶 id 的步驟查得到，所以
   daily.yml 每一步都要有 id；id 對到哪個名稱，從 daily.yml 讀
2. **新鮮度**：各頁資料的日期要等於當天的交易日（index.json 的 latest）。這一條抓得到「步驟沒報錯，
   但資料沒更新」——來源改版、抓回來是空的、腳本自己判斷要略過
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

import twse

WORKFLOW = twse.ROOT / ".github" / "workflows" / "daily.yml"

# (檔案, 取日期的方式, 頁面)。只放每天都該跟著交易日走的；集保（每週）、月營收這類不在這裡
FRESH = [
    ("taiex.json", lambda d: d["d"][-1], "加權指數"),
    ("insti/index.json", lambda d: d["latest"], "法人"),
    ("margin.json", lambda d: d["d"][-1], "融資"),
    ("quotes/index.json", lambda d: d["latest"], "報價"),
    ("sector_flow.json", lambda d: d["days"][-1], "動向"),
    ("entry.json", lambda d: d["last"], "後續"),
    ("rule.json", lambda d: d["date"], "紀律"),
    ("value.json", lambda d: d["asof"], "價值"),
    ("gooaye.json", lambda d: d["d"], "MK"),
    ("strategy.json", lambda d: d["d"], "策略"),
    ("revenue/index.json", lambda d: d["asof"], "營收"),
    ("events/page.json", lambda d: d["asof"], "公告"),
    ("disposal.json", lambda d: d["asof"], "處置"),
    ("futures.json", lambda d: d["d"][-1], "期貨原始資料"),
    ("futpage.json", lambda d: d["asof"], "期貨"),
]


def step_names() -> dict:
    """daily.yml 裡 id → 步驟名稱。"""
    out, name = {}, None
    for line in WORKFLOW.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*- name:\s*(.+)", line)
        if m:
            name = m.group(1).strip()
            continue
        m = re.match(r"\s*(?:- )?id:\s*(\S+)", line)
        if m:
            out[m.group(1)] = name or m.group(1)
            name = None
    return out


def failed_steps(raw: str) -> list:
    if not raw:
        return []
    steps = json.loads(raw)
    names = step_names()
    return [names.get(k, k) for k, v in steps.items() if (v or {}).get("outcome") == "failure"]


def stale_pages() -> tuple:
    idx = twse.read_json(twse.DATA_DIR / "index.json") or {}
    ref = idx.get("latest")
    out = []
    for path, get, label in FRESH:
        p = twse.DATA_DIR / path
        try:
            d = get(twse.read_json(p))
        except Exception as err:                 # 檔案不見、格式變了：也算
            out.append(f"{label}（{path} 讀不到：{type(err).__name__}）")
            continue
        if ref and d and d < ref:
            out.append(f"{label}停在 {d}")
    return ref, out


def main() -> int:
    ap = argparse.ArgumentParser(description="排程健康檢查")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    fails = failed_steps(os.environ.get("STEPS", ""))
    ref, stale = stale_pages()
    if not fails and not stale:
        print(f"排程健康：沒有失敗的步驟，各頁資料都到 {ref}")
        return 0
    lines = [f"<b>⚠️ 排程異常 · {ref or '?'}</b>"]
    if fails:
        lines += ["", f"<b>失敗的步驟 · {len(fails)}</b>"] + [f"• {twse_escape(n)}" for n in fails]
    if stale:
        lines += ["", f"<b>沒跟上 {ref} 的資料 · {len(stale)}</b>"] + [f"• {twse_escape(s)}" for s in stale]
    lines += ["", "<i>失敗的步驟設了「失敗也繼續」，排程本身是綠燈；細節看 Actions 的這一次執行。</i>"]
    text = "\n".join(lines)
    print(text)
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if args.dry_run or not token or not chat:
        print("（不發送）")
        return 0
    from notify_telegram import send
    send(token, chat, text)
    print("已推播")
    return 0


def twse_escape(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
