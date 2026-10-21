#!/usr/bin/env python3
"""Native messaging host for Linux/macOS, using the existing authenticated v2 bridge."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import sys
import threading

EXTENSION_ID = "gfnmcopdoaehakblkhonjloehlhfjgod"
HOST_NAME = "com.voltur.browser_control"


def data_dir():
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/BrowserControl"
    root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    if not root.is_absolute():
        root = Path.home() / ".local/share"
    return root / "BrowserControl"


def proof(secret, role, client, server):
    return hmac.new(secret.encode(), f"browser-control-v2:{role}:{client}:{server}".encode("ascii"), hashlib.sha256).hexdigest()


def read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        part = stream.read(size - len(chunks))
        if not part:
            if not chunks:
                return None
            raise EOFError("Truncated native message")
        chunks.extend(part)
    return bytes(chunks)


def read_frame(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size, = struct.unpack("=I", header)
    if not 0 < size <= 64 * 1024 * 1024:
        raise ValueError("Invalid native message size")
    payload = read_exact(stream, size)
    if payload is None:
        raise EOFError("Missing native message")
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError("Expected native message object")
    return value


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] != f"chrome-extension://{EXTENSION_ID}/":
        return 2
    lock = threading.Lock()

    def send(value):
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > 1024 * 1024:
            raise ValueError("Native response too large")
        with lock:
            sys.stdout.buffer.write(struct.pack("=I", len(payload)) + payload)
            sys.stdout.buffer.flush()

    try:
        secret = (data_dir() / "bridge-secret.txt").read_text(encoding="utf-8").strip()
        with socket.create_connection(("127.0.0.1", int(os.environ.get("BROWSER_CONTROL_PORT", "48317"))), timeout=5) as sock:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            reader = sock.makefile("rb")

            def write(value):
                sock.sendall(json.dumps(value, separators=(",", ":")).encode() + b"\n")

            def read():
                line = reader.readline(1_000_001)
                if not line or len(line) > 1_000_000:
                    raise EOFError("Bridge closed or oversized message")
                return json.loads(line)

            client = secrets.token_hex(32)
            write({"type": "hello", "nonce": client})
            challenge = read()
            server = challenge.get("nonce", "")
            if (challenge.get("type") != "hello_challenge" or len(server) != 64
                    or any(c not in "0123456789abcdef" for c in server)
                    or not hmac.compare_digest(challenge.get("proof", ""), proof(secret, "server", client, server))):
                raise ValueError("Bridge authentication failed")
            write({"type": "hello_auth", "proof": proof(secret, "host", client, server)})
            ack = read()
            if ack.get("type") != "hello_ack" or ack.get("ok") is not True or ack.get("protocol") != 2:
                raise ValueError("Bridge acknowledgement failed")
            sock.settimeout(None)
            send({"type": "native_ready", "ok": True})

            def incoming():
                try:
                    while True:
                        message = read()
                        if message.get("type") == "command":
                            send(message)
                except (OSError, ValueError, EOFError):
                    # Closing the bridge must also unblock the browser's input.
                    try:
                        send({"type": "native_error", "error": "Локальная связь с Astra прервана"})
                    finally:
                        os._exit(1)

            threading.Thread(target=incoming, daemon=True).start()
            while (message := read_frame(sys.stdin.buffer)) is not None:
                write(message)
        return 0
    except (OSError, ValueError, EOFError):
        send({"type": "native_error", "error": "Плагин Astra не запущен или локальный мост недоступен"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
