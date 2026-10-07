"""실내 이상기후 모니터링 대시보드 로컬 서버.

사용법:
    python3 server.py                 # http://127.0.0.1:8000
    python3 server.py --port 8080 --csv air_log.csv

외부 패키지 없이 Python 3.8+ 표준 라이브러리만 사용합니다.
CSV 파일에 새 행이 추가되면 다음 요청 시 자동으로 반영됩니다.
"""

import argparse
import json
import mimetypes
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import analysis

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
store = None


def _num(qs, name, scale=1.0):
    v = qs.get(name, [None])[0]
    if v in (None, ""):
        return None
    try:
        return float(v) * scale
    except ValueError:
        return None


class Handler(BaseHTTPRequestHandler):
    server_version = "IndoorAD/1.0"

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"):
            return
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        if url.path.startswith("/api/"):
            store.refresh()
            try:
                self._api(url.path[5:], qs)
            except Exception as exc:  # noqa: BLE001 - 대시보드에 오류를 그대로 전달
                self._json({"error": str(exc)}, 500)
            return
        self._static(url.path)

    def _api(self, name, qs):
        # 시간 파라미터는 epoch ms 로 받는다
        start, end = _num(qs, "start", 1e-3), _num(qs, "end", 1e-3)
        with store.lock:
            if name == "config":
                return self._json(analysis.config())
            if name == "current":
                return self._json(analysis.current(store))
            if name == "health":
                return self._json(analysis.health(store))
            if name == "series":
                pts = int(_num(qs, "points") or 700)
                return self._json(analysis.series(store, start, end, max(50, min(pts, 3000))))
            if name == "anomalies":
                return self._json(analysis.anomalies(store, start, end))
            if name == "trend":
                return self._json(analysis.trend(store, int(_num(qs, "window") or 60)))
            if name == "profile":
                return self._json(analysis.profile(store))
        self._json({"error": "unknown endpoint"}, 404)

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.realpath(os.path.join(WEB_DIR, rel))
        if not full.startswith(os.path.realpath(WEB_DIR) + os.sep) or not os.path.isfile(full):
            return self._send(404, b"Not found", "text/plain; charset=utf-8")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        with open(full, "rb") as fp:
            self._send(200, fp.read(), ctype)


def main():
    global store
    ap = argparse.ArgumentParser(description="실내 이상기후 모니터링 대시보드")
    ap.add_argument("--csv", default=os.path.join(ROOT, "air_log.csv"), help="센서 로그 CSV 경로")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    if not os.path.isfile(args.csv):
        sys.exit(f"CSV 파일을 찾을 수 없습니다: {args.csv}")
    store = analysis.DataStore(args.csv)
    print(f"데이터 로딩 중: {args.csv}")
    store.refresh()
    print(f"  {len(store.t):,}행 로드 완료")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"대시보드: http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}")
    print("종료: Ctrl+C")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")


if __name__ == "__main__":
    main()
