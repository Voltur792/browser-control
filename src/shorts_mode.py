"""Hands-free "watch shorts" mode: short words without the wake word.

"Астра, просмотр шортсов" turns the mode on; from then the plugin listens to the
microphone itself with a small offline Vosk model restricted to a handful of
phrases, so «дальше», «назад», «пауза» work without saying «Астра».
«Закончить просмотр» (or 15 minutes without a command) turns it off.

The recognizer only knows the phrases below plus [unk]; a result counts only
when the whole utterance is exactly one phrase with good confidence, so speech
from the video itself rarely triggers anything.

Model lookup and the Cyrillic-path workaround follow the voice-text-input plugin
(same author): the model is shared from %APPDATA%\\voice-text-input\\models when
present, otherwise downloaded once (~45 MB) to %LOCALAPPDATA%\\BrowserControl\\models.
"""

from __future__ import annotations

import ctypes
import json
import logging
import os
import queue
import shutil
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger(__name__)

PHRASES: dict[str, tuple[str, ...]] = {
    # Every phrase must exist in the small model's vocabulary ("листай" does not).
    "next": ("дальше", "следующее", "следующий", "вперёд"),
    "previous": ("назад", "предыдущее", "предыдущий", "верни"),
    "pause": ("пауза", "стоп"),
    "play": ("продолжи", "играй", "поехали"),
    "mute": ("выключи звук", "без звука"),
    "unmute": ("включи звук",),
    "stop_mode": ("закончить просмотр", "закончи просмотр", "выключи режим"),
}
MIN_CONFIDENCE = 0.6
IDLE_TIMEOUT_SECS = 15 * 60
COMMAND_COOLDOWN_SECS = 0.8
TARGET_SR = 16000
VOSK_MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip"

_PHRASE_TO_COMMAND = {phrase: command for command, phrases in PHRASES.items() for phrase in phrases}


def _normalize(text: str) -> str:
    return " ".join(str(text).split()).casefold().replace("ё", "е")


_NORMALIZED = {_normalize(phrase): command for phrase, command in _PHRASE_TO_COMMAND.items()}


def grammar() -> str:
    return json.dumps([*_PHRASE_TO_COMMAND, "[unk]"], ensure_ascii=False)


def match_command(result_json: str) -> str | None:
    """Map one final Vosk result to a command, or None.

    The whole utterance must be exactly one known phrase ("ну дальше давай"
    arrives as "[unk] дальше [unk]" and is ignored), and the average word
    confidence must be high enough.
    """
    try:
        result = json.loads(result_json)
    except (TypeError, json.JSONDecodeError):
        return None
    command = _NORMALIZED.get(_normalize(result.get("text") or ""))
    if command is None:
        return None
    words = result.get("result")
    if isinstance(words, list) and words:
        confidences = [float(word.get("conf", 0)) for word in words if isinstance(word, dict)]
        if confidences and sum(confidences) / len(confidences) < MIN_CONFIDENCE:
            return None
    return command


# --- model discovery -------------------------------------------------------

def _looks_like_model(path: Path) -> bool:
    return (path / "conf" / "model.conf").is_file() and (path / "am").is_dir() and (path / "graph").is_dir()


def model_dirs() -> list[Path]:
    dirs = []
    if os.environ.get("LOCALAPPDATA"):
        dirs.append(Path(os.environ["LOCALAPPDATA"]) / "BrowserControl" / "models")
    if os.environ.get("APPDATA"):
        dirs.append(Path(os.environ["APPDATA"]) / "voice-text-input" / "models")
    if os.name != "nt":
        from .platform_support import user_data
        dirs += [user_data() / "BrowserControl/models", user_data() / "voice-text-input/models"]
    return dirs


def find_model() -> Path | None:
    for directory in model_dirs():
        if directory.is_dir():
            for candidate in sorted(directory.glob("vosk-model*ru*")):
                if _looks_like_model(candidate):
                    return candidate
    return None


def ascii_model_path(model: Path) -> Path:
    """Kaldi opens model files through the ANSI codepage, so a Cyrillic profile
    path fails to load; the 8.3 short form of the same folder is pure ASCII."""
    if os.name != "nt" or str(model).isascii():
        return model
    try:
        buffer = ctypes.create_unicode_buffer(4096)
        length = ctypes.windll.kernel32.GetShortPathNameW(str(model), buffer, len(buffer))
        if 0 < length < len(buffer) and buffer.value.isascii():
            return Path(buffer.value)
    except Exception:
        pass
    programdata = os.environ.get("ProgramData")
    if programdata and programdata.isascii():
        target = Path(programdata) / "BrowserControl" / "models" / "vosk-model-small-ru"
        if not _looks_like_model(target):
            shutil.rmtree(target, ignore_errors=True)
            shutil.copytree(model, target)
        return target
    return model


def download_model(progress: Callable[[str], None]) -> Path:
    dest = model_dirs()[0]
    dest.mkdir(parents=True, exist_ok=True)
    archive = dest / "_vosk-model.zip"
    unpack = dest / "_vosk-unpack"
    try:
        request = urllib.request.Request(VOSK_MODEL_URL, headers={"User-Agent": "browser-control/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response, open(archive, "wb") as out:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            while chunk := response.read(262144):
                out.write(chunk)
                done += len(chunk)
                if total:
                    progress(f"Скачиваю модель распознавания: {done * 100 // total}%")
        shutil.rmtree(unpack, ignore_errors=True)
        with zipfile.ZipFile(archive) as package:
            package.extractall(unpack)
        found = [path for path in unpack.glob("vosk-model*ru*") if _looks_like_model(path)]
        if not found:
            raise RuntimeError("архив модели распознавания повреждён")
        final = dest / found[0].name
        shutil.rmtree(final, ignore_errors=True)
        found[0].rename(final)
        return final
    finally:
        archive.unlink(missing_ok=True)
        shutil.rmtree(unpack, ignore_errors=True)


# --- the mode itself -------------------------------------------------------

def _beep(frequency: int) -> None:
    def run() -> None:
        try:
            import winsound
            winsound.Beep(frequency, 140)
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()


class ShortsMode:
    """Owns the listening thread. `on_command(command)` runs in that thread."""

    def __init__(self, on_command: Callable[[str], None]):
        self._on_command = on_command
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._state = "off"
        self._detail = ""
        self._started_at: float | None = None
        self._last_command: str | None = None
        self._last_activity = 0.0

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "active": self._state in {"loading", "listening"},
                "state": self._state,
                "detail": self._detail,
                "since": int(self._started_at) if self._started_at else None,
                "last_command": self._last_command,
                "phrases": {command: list(phrases) for command, phrases in PHRASES.items()},
            }

    def _set(self, state: str, detail: str = "") -> None:
        with self._lock:
            self._state = state
            self._detail = detail

    def start(self) -> bool:
        """Start listening; False when it was already on."""
        with self._lock:
            if self._thread and self._thread.is_alive():
                return False
            self._stop.clear()
            self._state = "loading"
            self._detail = "Запускаю распознавание…"
            self._started_at = time.time()
            self._last_activity = time.monotonic()
            self._last_command = None
            self._thread = threading.Thread(target=self._run, name="browser-shorts-mode", daemon=True)
            self._thread.start()
        return True

    def stop(self, reason: str = "") -> bool:
        with self._lock:
            running = bool(self._thread and self._thread.is_alive())
            self._stop.set()
        if running:
            _beep(440)
        self._set("off", reason)
        return running

    def _run(self) -> None:
        try:
            import numpy as np
            import sounddevice as sd
            import vosk
        except ImportError as exc:
            self._set("error", f"Не установлены компоненты распознавания ({exc.name}). Перезапустите Astra, чтобы она доустановила зависимости плагина.")
            return
        try:
            model_path = find_model() or download_model(lambda text: self._set("loading", text))
            vosk.SetLogLevel(-1)
            model = vosk.Model(str(ascii_model_path(model_path)))
        except Exception as exc:
            log.exception("shorts mode: model failed")
            self._set("error", f"Не удалось загрузить модель распознавания: {exc}")
            return
        if self._stop.is_set():
            return
        recognizer = vosk.KaldiRecognizer(model, TARGET_SR, grammar())
        recognizer.SetWords(True)
        blocks: queue.Queue[bytes] = queue.Queue(maxsize=200)

        try:
            info = sd.query_devices(kind="input")
            rate = int(info.get("default_samplerate") or 48000)
        except Exception as exc:
            self._set("error", f"Микрофон недоступен: {exc}")
            return

        def callback(indata, frames, time_info, status):  # noqa: ANN001
            mono = np.asarray(indata[:, 0] if indata.ndim > 1 else indata)
            if rate != TARGET_SR and mono.size:
                count = int(round(mono.size * TARGET_SR / rate))
                mono = np.interp(np.linspace(0, mono.size - 1, count), np.arange(mono.size), mono).astype(np.int16)
            try:
                blocks.put_nowait(mono.tobytes())
            except queue.Full:
                pass

        try:
            with sd.InputStream(samplerate=rate, channels=1, dtype="int16", blocksize=max(1, rate // 10), callback=callback):
                self._set("listening", "Слушаю короткие команды")
                _beep(880)
                last_fired = 0.0
                while not self._stop.is_set():
                    if time.monotonic() - self._last_activity > IDLE_TIMEOUT_SECS:
                        self._stop.set()
                        _beep(440)
                        self._set("off", "Режим выключен: 15 минут без команд")
                        return
                    try:
                        block = blocks.get(timeout=0.3)
                    except queue.Empty:
                        continue
                    if not recognizer.AcceptWaveform(block):
                        continue
                    command = match_command(recognizer.Result())
                    if command is None:
                        continue
                    # The cooldown stops one long "дааальше" from firing twice; turning the
                    # mode off must never be swallowed by it.
                    if command != "stop_mode" and time.monotonic() - last_fired < COMMAND_COOLDOWN_SECS:
                        continue
                    last_fired = time.monotonic()
                    self._last_activity = last_fired
                    with self._lock:
                        self._last_command = command
                    if command == "stop_mode":
                        self._stop.set()
                        _beep(440)
                        self._set("off", "Режим выключен командой «закончить просмотр»")
                        return
                    try:
                        self._on_command(command)
                    except Exception as exc:  # the browser may be busy or disconnected
                        log.warning("shorts mode: %s failed: %s", command, exc)
                        self._set("listening", f"Последняя команда не выполнена: {exc}")
        except Exception as exc:
            log.exception("shorts mode: microphone failed")
            self._set("error", f"Микрофон недоступен: {exc}")
        finally:
            if self._stop.is_set() and self._state in {"loading", "listening"}:
                self._set("off")
