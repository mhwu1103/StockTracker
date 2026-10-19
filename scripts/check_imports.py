"""檢查每日排程跑的每一支腳本，import 的模組在「只裝 requirements.txt」的環境裡都找得到。

    python scripts/check_imports.py          # 找不到的列出來並 exit 1

為什麼要有：2026-10 營收、處置、期貨、策略四頁的產生腳本都 import numpy，requirements.txt 卻只有
requests。排程上那四步每天 ModuleNotFoundError，但步驟設了 continue-on-error，整個流程照樣是綠燈，
四頁就一直停在本機產生的那一份——畫面看起來完全正常，所以沒人發現。

做法：從 .github/workflows/daily.yml 撈出每一個 `python scripts/<名稱>.py`，用 ast 讀它們（與它們
import 的同目錄模組）的 import，逐一用 importlib.util.find_spec 找。**不執行**任何腳本——有些一 import
就會去抓資料。只看最上層的 import；寫在函式裡的（選用功能）不算。
"""

from __future__ import annotations

import ast
import importlib.util
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
WORKFLOW = ROOT / ".github" / "workflows" / "daily.yml"


def top_imports(path: Path) -> set:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            out |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            out.add(node.module.split(".")[0])
    return out


def main() -> int:
    sys.path.insert(0, str(SCRIPTS))
    todo = sorted(set(re.findall(r"python scripts/(\w+)\.py", WORKFLOW.read_text(encoding="utf-8"))))
    seen, missing = set(), []
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        for mod in top_imports(SCRIPTS / f"{name}.py"):
            if (SCRIPTS / f"{mod}.py").exists():
                todo.append(mod)             # 同目錄的共用模組：也要看它 import 了什麼
            elif importlib.util.find_spec(mod) is None:
                missing.append(f"{name}.py → {mod}")
    if missing:
        print("排程環境裡找不到這些模組（要加進 requirements.txt）：")
        print("\n".join(f"  {m}" for m in sorted(missing)))
        return 1
    print(f"排程的 {len(seen)} 支腳本（含共用模組），import 都找得到")
    return 0


if __name__ == "__main__":
    sys.exit(main())
