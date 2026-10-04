"""只補 close/（四價），不重寫 daily/。日期取 daily/{scope} 有、close/ 沒有的那些。

close/ 是 2026-03-16 才開始存的，更早的日子只有排行。backfill.py 也補得到，但它會連
daily/ 一起重寫，build_history.py 補寫的 streak／vh／ma 欄位要整段重算；這支只寫 close/。
可中斷、可續跑（已經有 close/ 檔的日期自動跳過）。

    python -X utf8 scripts/backfill_close.py
"""
import sys, time
from datetime import date
import twse, backfill

for scope in ("twse", "tpex"):
    todo = sorted(set(twse.existing_dates(scope)) - set(twse.existing_close_dates(scope)))
    print(f"=== {scope}：要補 {len(todo)} 天", flush=True)
    _, fetch = backfill.FETCHERS[scope]
    for i, d in enumerate(todo, 1):
        for attempt in range(3):
            try:
                got = fetch(date.fromisoformat(d))
                break
            except RuntimeError as err:
                print(f"  {d} 失敗（{err}），30 秒後重試", flush=True)
                time.sleep(30)
        else:
            sys.exit(f"{scope} {d} 連續失敗三次，停下")
        if got is None:
            print(f"[{scope} {i}/{len(todo)}] {d} 沒有資料", flush=True)
        else:
            date_iso, records = got
            assert date_iso == d, (date_iso, d)
            twse.write_closes(date_iso, scope, records)
            print(f"[{scope} {i}/{len(todo)}] {d} {len(records)} 檔", flush=True)
        time.sleep(4)
print("close 完成", flush=True)
