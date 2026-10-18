"""Security regressions for browser result filtering and local bridge auth."""

import hashlib
import hmac
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src import bridge
from src.privacy import sanitize_result


class PrivacyTests(unittest.TestCase):
    def test_browser_result_hides_credentials_codes_cards_and_url_tokens(self):
        payload = {
            "url": "https://example.org/reset?token=raw-token-123456",
            "title": "Ваш код 123456",
            "text": "Пароль:\nsampleSecret\nКарта 4111 1111 1111 1111\nОткрыть чат",
            "error": "Код:\nABCD-EFGH",
            "frames": [{"href": "https://example.org/pay?card=4111111111111111"}],
        }
        safe = sanitize_result(payload)
        serialized = json.dumps(safe, ensure_ascii=False)
        for secret in ("raw-token", "123456", "sampleSecret", "4111", "ABCD-EFGH"):
            self.assertNotIn(secret, serialized)
        self.assertEqual(safe["url"], "https://example.org")
        self.assertEqual(safe["frames"][0]["href"], "https://example.org")
        self.assertIn("Открыть чат", safe["text"])

    def test_ordinary_titles_years_and_prices_stay_readable(self):
        safe = sanitize_result({
            "title": "Visual Studio Code — проект 2026",
            "text": "Исходный код на GitHub\nЦена 1 299 ₽\nPin to taskbar",
        })
        self.assertEqual(safe["title"], "Visual Studio Code — проект 2026")
        self.assertEqual(safe["text"], "Исходный код на GitHub\nЦена 1 299 ₽\nPin to taskbar")

    def test_labelled_and_sms_codes_are_still_hidden(self):
        safe = sanitize_result({"text": "Code: 4821\nВведите код из СМС 7731\nНомер 8 900 123 45 67"})
        serialized = json.dumps(safe, ensure_ascii=False)
        for secret in ("4821", "7731", "123 45 67"):
            self.assertNotIn(secret, serialized)


class BridgeAuthenticationTests(unittest.TestCase):
    def test_bridge_rejects_invalid_proof_and_accepts_mutual_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(bridge, "data_dir", return_value=Path(directory)), mock.patch.object(bridge, "PORT", 0):
                server = bridge.BrowserBridge()
                server.start()
                port = server._server.server_address[1]
                try:
                    nonce = "a" * 64
                    with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
                        sock.settimeout(2)
                        stream = sock.makefile("rwb", buffering=0)
                        stream.write(json.dumps({"type": "hello", "nonce": nonce}).encode() + b"\n")
                        challenge = json.loads(stream.readline())
                        self.assertEqual(challenge["type"], "hello_challenge")
                        self.assertNotIn(server._secret, json.dumps(challenge))
                        stream.write(b'{"type":"hello_auth","proof":"incorrect"}\n')
                        self.assertEqual(stream.readline(), b"")
                    self.assertFalse(server.status()["connected"])

                    with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
                        sock.settimeout(2)
                        stream = sock.makefile("rwb", buffering=0)
                        stream.write(json.dumps({"type": "hello", "nonce": nonce}).encode() + b"\n")
                        challenge = json.loads(stream.readline())
                        message = f"browser-control-v2:host:{nonce}:{challenge['nonce']}".encode("ascii")
                        proof = hmac.new(server._secret.encode(), message, hashlib.sha256).hexdigest()
                        stream.write(json.dumps({"type": "hello_auth", "proof": proof}).encode() + b"\n")
                        ack = json.loads(stream.readline())
                        self.assertEqual(ack, {"type": "hello_ack", "ok": True, "protocol": 2})
                        self.assertTrue(server.status()["connected"])
                finally:
                    server.stop()


if __name__ == "__main__":
    unittest.main()
