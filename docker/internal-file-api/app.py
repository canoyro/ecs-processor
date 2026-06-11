from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import socket
import time
from urllib.parse import parse_qs, urlparse

DATA_FILE = os.environ.get("DATA_FILE", "/data/message.txt")
PORT = int(os.environ.get("PORT", "8080"))


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

        if parsed.path == "/read":
            value = ""
            if os.path.exists(DATA_FILE):
                with open(DATA_FILE, "r", encoding="utf-8") as handle:
                    value = handle.read()
            self._send_json(200, {
                "hostname": socket.gethostname(),
                "file": DATA_FILE,
                "value": value,
            })
            return

        if parsed.path == "/write":
            query = parse_qs(parsed.query)
            value = query.get("value", [f"updated at {int(time.time())}"])[0]
            os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
            with open(DATA_FILE, "w", encoding="utf-8") as handle:
                handle.write(value)
            self._send_json(200, {
                "hostname": socket.gethostname(),
                "file": DATA_FILE,
                "value": value,
            })
            return

        self._send_json(200, {
            "service": "internal-file-api",
            "hostname": socket.gethostname(),
            "endpoints": ["/health", "/read", "/write?value=test"],
        })

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
