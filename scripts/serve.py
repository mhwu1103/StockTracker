"""本機開發用的靜態伺服器。

與 `python -m http.server` 的差別只有一個：明確送出 no-store，
讓瀏覽器每次都重新拿檔案。改了 app.js／style.css 卻看到舊畫面的問題就不會發生。

用法：
    python scripts/serve.py           # http://localhost:8765
    python scripts/serve.py 9000      # 指定其他埠號
"""

from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SITE_DIR = Path(__file__).resolve().parent.parent / "docs"


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = partial(NoCacheHandler, directory=str(SITE_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    print(f"網站根目錄：{SITE_DIR}")
    print(f"請開啟 http://localhost:{port}  （Ctrl+C 結束）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
