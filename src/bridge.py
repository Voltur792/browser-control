"""Authenticated loopback bridge between Astra, the native host and extension."""

from __future__ import annotations

import json
import hashlib
import hmac
import logging
import os
import secrets
import socket
import socketserver
import threading
import time
import uuid
from concurrent.futures import Future, TimeoutError
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)
PORT = int(os.environ.get("BROWSER_CONTROL_PORT", "48317"))
MAX_LINE = 1_000_000


def data_dir() -> Path:
    root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(root) / "BrowserControl"


def secret_path() -> Path:
    return data_dir() / "bridge-secret.txt"


def load_or_create_secret() -> str:
    path = secret_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    # A new bridge session invalidates tokens retained by previous local clients.
    value = secrets.token_urlsafe(48)
    path.write_text(value, encoding="utf-8")
    return value


def _proof(secret: str, role: str, client_nonce: str, server_nonce: str) -> str:
    payload = f"browser-control-v2:{role}:{client_nonce}:{server_nonce}".encode("ascii")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def _valid_nonce(value: Any) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value)


class _Client:
    def __init__(self, conn: socket.socket, browser: str, browser_code: str):
        self.conn = conn
        self.browser = browser
        self.browser_code = browser_code
        self.send_lock = threading.Lock()
        self.connected_at = time.time()

    def send(self, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        with self.send_lock:
            self.conn.sendall(raw)


class BrowserBridge:
    """Single-user local TCP endpoint; it binds only to IPv4 loopback."""

    def __init__(self):
        self._lock = threading.RLock()
        self._client: _Client | None = None
        self._pending: dict[str, tuple[Future[dict[str, Any]], dict[str, Any], bool]] = {}
        self._secret = load_or_create_secret()
        self._server: socketserver.ThreadingTCPServer | None = None

    def start(self) -> None:
        bridge = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                self.connection.settimeout(70)
                try:
                    first = self.rfile.readline(MAX_LINE + 1)
                    if not first or len(first) > MAX_LINE:
                        return
                    hello = json.loads(first)
                    if not isinstance(hello, dict):
                        return
                    client_nonce = hello.get("nonce")
                    if hello.get("type") != "hello" or not _valid_nonce(client_nonce):
                        return
                    server_nonce = secrets.token_hex(32)
                    challenge = {
                        "type": "hello_challenge",
                        "nonce": server_nonce,
                        "proof": _proof(bridge._secret, "server", client_nonce, server_nonce),
                    }
                    self.wfile.write(json.dumps(challenge, separators=(",", ":")).encode("ascii") + b"\n")
                    self.wfile.flush()
                    second = self.rfile.readline(MAX_LINE + 1)
                    if not second or len(second) > MAX_LINE:
                        return
                    auth = json.loads(second)
                    if not isinstance(auth, dict):
                        return
                    expected = _proof(bridge._secret, "host", client_nonce, server_nonce)
                    if auth.get("type") != "hello_auth" or not secrets.compare_digest(str(auth.get("proof", "")), expected):
                        return

                    browser = str(hello.get("browser", "Chromium-based browser"))[:80]
                    browser_code = str(hello.get("browser_code", "unknown"))[:24]
                    client = _Client(self.connection, browser, browser_code)
                    with bridge._lock:
                        old = bridge._client
                        bridge._client = client
                    if old is not None and old.conn is not self.connection:
                        try:
                            old.conn.shutdown(socket.SHUT_RDWR)
                            old.conn.close()
                        except OSError:
                            pass
                    self.wfile.write(b'{"type":"hello_ack","ok":true,"protocol":2}\n')
                    self.wfile.flush()
                    bridge._flush_pending()
                    while True:
                        line = self.rfile.readline(MAX_LINE + 1)
                        if not line:
                            break
                        if len(line) > MAX_LINE:
                            break
                        try:
                            message = json.loads(line)
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            continue
                        if not isinstance(message, dict):
                            continue
                        bridge._on_host_message(message, client)
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    pass
                finally:
                    with bridge._lock:
                        if bridge._client is not None and bridge._client.conn is self.connection:
                            bridge._client = None
                            bridge._fail_pending("Расширение отключилось")

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self._server = Server(("127.0.0.1", PORT), Handler)
        threading.Thread(target=self._server.serve_forever, name="browser-control-bridge", daemon=True).start()
        log.info("Browser bridge listening on 127.0.0.1:%s", PORT)

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    def status(self) -> dict[str, Any]:
        with self._lock:
            client = self._client
            if client is None:
                return {"connected": False, "browser": None, "connected_since": None}
            return {
                "connected": True,
                "browser": client.browser,
                "browser_code": client.browser_code,
                "connected_since": int(client.connected_at),
            }

    def _on_host_message(self, message: dict[str, Any], client: _Client) -> None:
        pair = None
        with self._lock:
            if self._client is not client:
                return
            kind = message.get("type")
            if kind == "browser_info":
                client.browser = str(message.get("browser", "unknown"))[:80]
                client.browser_code = str(message.get("browser_code", "unknown"))[:24]
            elif kind == "result":
                request_id = str(message.get("id", ""))
                pair = self._pending.pop(request_id, None)
            elif kind == "ping":
                client.connected_at = time.time()
        if pair is not None and not pair[0].done():
            pair[0].set_result(message)

    def request(self, action: str, payload: dict[str, Any] | None = None, timeout: float = 35) -> dict[str, Any]:
        request_id = uuid.uuid4().hex
        future: Future[dict[str, Any]] = Future()
        message = {
            "type": "command",
            "id": request_id,
            "action": action,
            "deadline_ms": int((time.time() + timeout - 5) * 1000),
            **(payload or {}),
        }
        with self._lock:
            self._pending[request_id] = (future, message, False)
            client = self._client
            if client is None:
                self._flush_pending_locked()
            else:
                try:
                    client.send(message)
                    self._pending[request_id] = (future, message, True)
                except OSError:
                    self._client = None
                    self._pending.pop(request_id, None)
                    raise RuntimeError("Потеряна связь с расширением") from None
        try:
            return future.result(timeout=timeout)
        except TimeoutError:
            with self._lock:
                self._pending.pop(request_id, None)
            raise RuntimeError("Расширение не ответило вовремя") from None

    def _flush_pending(self) -> None:
        with self._lock:
            self._flush_pending_locked()

    def _flush_pending_locked(self) -> None:
        client = self._client
        if client is None:
            return
        for request_id, (future, message, sent) in list(self._pending.items()):
            if future.done():
                self._pending.pop(request_id, None)
                continue
            if sent:
                self._pending.pop(request_id, None)
                future.set_exception(RuntimeError("Связь прервалась после отправки команды; результат неизвестен. Проверьте страницу перед повтором."))
                continue
            try:
                client.send(message)
                self._pending[request_id] = (future, message, True)
            except OSError:
                break

    def _fail_pending(self, reason: str) -> None:
        pending, self._pending = self._pending, {}
        for future, _message, sent in pending.values():
            if not future.done():
                detail = "Связь прервалась после отправки команды; результат неизвестен. Проверьте страницу перед повтором." if sent else reason
                future.set_exception(RuntimeError(detail))
