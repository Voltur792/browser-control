"""Defense-in-depth filtering for browser results before they reach Astra tools."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit


# Bare words such as "code" or "код" are deliberately absent: they hid ordinary
# titles like "Visual Studio Code" or "Исходный код". A code is caught by its
# label ("Код: …", "Ваш код …") or by an explicit phrase instead.
_SENSITIVE = re.compile(
    r"парол|одноразов|(?:ваш|your|sms|смс)\s*(?:код|code)|^\s*(?:код|code|pin|пин)\s*[:：#№]|"
    r"код\s*(?:подтвержден|доступа|безопасност|из\s*смс)|пин.?код|pin.?code|\bpin\s*[:：]|номер\s*карт|"
    r"срок\s*действия|секретн|токен|password|passcode|verification\s*code|confirmation\s*code|"
    r"security\s*code|auth(?:entication)?\s*code|one.?time.?code|\botp\b|\bcvv\b|\bcvc\b|"
    r"api.?key|secret|access.?token|card\s*number|expiry",
    re.IGNORECASE,
)
_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_LONG_KEY = re.compile(r"\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b")
_DIGITS = re.compile(r"(?:\d[ -]?){3,19}")
# Years, prices and counters stay readable; codes, card and phone numbers do not.
_MIN_HIDDEN_DIGITS = 6


def public_site(value: str) -> str:
    try:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            return "[адрес скрыт]"
        host = parts.hostname
        port = f":{parts.port}" if parts.port else ""
        return f"{parts.scheme}://{host}{port}"
    except ValueError:
        return "[адрес скрыт]"


def redact_text(value: str, *, drop_sensitive_lines: bool = True) -> str:
    hidden_next = 0
    lines: list[str] = []
    for line in value[:20_000].splitlines():
        if hidden_next and line.strip():
            hidden_next -= 1
            lines.append("[конфиденциальная строка скрыта]")
            continue
        if drop_sensitive_lines and _SENSITIVE.search(line):
            hidden_next = 2
            lines.append("[конфиденциальная строка скрыта]")
            continue
        line = _URL.sub(lambda match: public_site(match.group()), line)
        line = _EMAIL.sub("[адрес почты скрыт]", line)
        line = _LONG_KEY.sub("[ключ скрыт]", line)
        line = _DIGITS.sub(lambda match: "[число скрыто]" if len(re.sub(r"\D", "", match.group())) >= _MIN_HIDDEN_DIGITS else match.group(), line)
        lines.append(line)
    return "\n".join(lines)


def sanitize_result(value: Any, key: str = "") -> Any:
    if isinstance(value, str):
        if key in {"url", "href"}:
            return public_site(value)
        return redact_text(value)
    if isinstance(value, list):
        return [sanitize_result(item) for item in value]
    if isinstance(value, dict):
        return {name: sanitize_result(item, name) for name, item in value.items()}
    return value
