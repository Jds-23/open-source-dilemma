#!/usr/bin/env python3
"""Minimal NEAR AI Cloud mock for the wasmtime fixture run (local only, no secrets).

POST /v1/chat/completions -> {"id", "choices":[{"message":{"content": <C|D>}}]}
GET  /v1/signature/<id>   -> {"text": "<model>:<sha256(req)>:<sha256(resp)>", "signature": <128 hex>}
Reply: "D" if the YOUR_STRATEGY section says "defect" (case-insensitive), else "C".
Usage: mock_nearai.py <port>
"""
import hashlib, json, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

SEEN = {}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return body

    def _body(self):
        if self.headers.get("Content-Length"):
            return self.rfile.read(int(self.headers["Content-Length"]))
        # wasi-http sends chunked transfer-encoding when no Content-Length is set
        out = b""
        while True:
            n = int(self.rfile.readline().strip().split(b";")[0], 16)
            if n == 0:
                self.rfile.readline()
                return out
            out += self.rfile.read(n)
            self.rfile.readline()

    def do_POST(self):
        req = self._body()
        v = json.loads(req)
        user = v["messages"][1]["content"]
        own = re.search(r"<YOUR_STRATEGY>\n(.*)\n</YOUR_STRATEGY>", user, re.S).group(1)
        move = "D" if "defect" in own.lower() and "cooperate unless" not in own.lower() else "C"
        cid = hashlib.sha256(req).hexdigest()[:32]
        body = json.dumps({"id": cid, "choices": [{"message": {"role": "assistant", "content": move}}]}).encode()
        SEEN[cid] = (v["model"], hashlib.sha256(req).hexdigest(), hashlib.sha256(body).hexdigest())
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        cid = self.path.split("/signature/")[1].split("?")[0]
        m, rq, rs = SEEN[cid]
        self._send(200, {"text": f"{m}:{rq}:{rs}", "signature": hashlib.sha512(cid.encode()).hexdigest(), "signing_algo": "ed25519"})

HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
