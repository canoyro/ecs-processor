from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import socket
import time
from urllib.parse import parse_qs, urlparse

LOG_FILE = os.environ.get("LOG_FILE", "/mnt/s3-shared/log.json")
PORT = int(os.environ.get("PORT", "9090"))


def _read_entries():
    if not os.path.exists(LOG_FILE):
        return []
    with open(LOG_FILE, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except (json.JSONDecodeError, ValueError):
            return []


def _write_entries(entries):
    os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
    with open(LOG_FILE, "w", encoding="utf-8") as f:
        json.dump(entries, f)


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._send_json(200, {"status": "ok"})
            return

        if parsed.path == "/entries":
            entries = _read_entries()
            self._send_json(200, {
                "hostname": socket.gethostname(),
                "count": len(entries),
                "entries": entries,
            })
            return

        if parsed.path == "/append":
            query = parse_qs(parsed.query)
            message = query.get("message", [f"entry at {int(time.time())}"])[0]
            entries = _read_entries()
            entry = {"timestamp": int(time.time()), "message": message, "host": socket.gethostname()}
            entries.append(entry)
            _write_entries(entries)
            self._send_json(200, {
                "hostname": socket.gethostname(),
                "appended": entry,
                "total": len(entries),
            })
            return

        if parsed.path == "/clear":
            _write_entries([])
            self._send_json(200, {"hostname": socket.gethostname(), "cleared": True})
            return

        self._send_json(200, {
            "service": "internal-data-api",
            "hostname": socket.gethostname(),
            "endpoints": ["/health", "/entries", "/append?message=hello", "/clear"],
        })

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
