import importlib.util
import io
import json
from pathlib import Path
import struct
import pytest
from src import plugin, platform_support


def load_host():
    path = Path(__file__).resolve().parents[1] / "browser-extension/native-host/posix_host.py"
    spec = importlib.util.spec_from_file_location("posix_host", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_unicode_native_messages_and_truncated_payload_are_checked():
    host = load_host()
    payload = json.dumps({"text": "Привет, мир 😊"}, ensure_ascii=False).encode()
    assert host.read_frame(io.BytesIO(struct.pack("=I", len(payload)) + payload))["text"] == "Привет, мир 😊"
    with pytest.raises(EOFError):
        host.read_frame(io.BytesIO(struct.pack("=I", len(payload)) + payload[:3]))
    with pytest.raises(ValueError):
        host.read_frame(io.BytesIO(struct.pack("=I", 65*1024*1024)))
    assert host.main(["chrome-extension://untrusted/"]) == 2


def test_posix_host_matches_existing_mutual_authentication():
    from src.bridge import _proof
    host = load_host()
    assert host.proof("test-only", "server", "a"*64, "b"*64) == _proof("test-only", "server", "a"*64, "b"*64)
    assert host.proof("test-only", "host", "a"*64, "b"*64) != host.proof("test-only", "server", "a"*64, "b"*64)


def test_linux_browser_path_uses_installed_binary(tmp_path, monkeypatch):
    import sys, shutil
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(shutil, "which", lambda name: str(tmp_path / "chrome") if name == "google-chrome" else None)
    assert plugin._browser_candidates("chrome") == [tmp_path / "chrome"]


def test_browser_and_host_use_same_posix_data_dir(tmp_path, monkeypatch):
    from src import bridge
    host = load_host()
    monkeypatch.setattr(platform_support.sys, "platform", "linux")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path))
    assert host.data_dir() == platform_support.user_data() / "BrowserControl"


def test_packaged_installer_extracts_posix_host_without_windows_launcher(tmp_path, monkeypatch):
    root = Path(__file__).resolve().parents[1]
    monkeypatch.setattr(plugin.sys, "platform", "linux")
    monkeypatch.setattr(plugin, "EXTENSION_DIR", tmp_path / "missing/browser-extension")
    monkeypatch.setattr(plugin, "data_dir", lambda: tmp_path / "data/BrowserControl")
    archive = root / "ui/web/extension-setup.zip"
    import shutil
    copied = tmp_path / "missing/ui/web/extension-setup.zip"
    copied.parent.mkdir(parents=True)
    shutil.copyfile(archive, copied)
    installer = plugin._setup_installer()
    assert installer.name == "install-native-host.py"
    assert (installer.parent / "native-host/posix_host.py").is_file()
    assert (installer.parent / "manifest.json").is_file()


def test_linux_install_button_registers_host_and_opens_unpack_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(plugin.sys, "platform", "linux")
    source = tmp_path / "source"
    source.mkdir()
    for name in ("manifest.json", "background.js", "popup.html", "popup.css", "popup.js", "install-native-host.py"):
        (source / name).write_text("test fixture", encoding="utf-8")
    (source / "icons").mkdir()
    target = tmp_path / "persistent/browser-extension"
    monkeypatch.setattr(plugin, "INSTALLED_EXTENSION_DIR", target)
    monkeypatch.setattr(plugin, "_setup_installer", lambda: source / "install-native-host.py")
    browser = tmp_path / "google-chrome"
    browser.touch()
    monkeypatch.setattr(plugin, "_browser_candidates", lambda _: [browser])
    executed, launched = [], []
    monkeypatch.setattr(plugin.subprocess, "run", lambda args, **kw: executed.append(args))
    monkeypatch.setattr(plugin.subprocess, "Popen", lambda args, **kw: launched.append(args))
    instance = object.__new__(plugin.BrowserControl)
    instance.settings = {"browser": "chrome"}
    result = instance.ui_install_extension()
    assert result["ok"]
    assert executed == [[plugin.sys.executable, str(source / "install-native-host.py")]]
    assert launched == [[str(browser), "chrome://extensions"], ["xdg-open", str(target)]]
    assert (target / "manifest.json").read_text(encoding="utf-8") == "test fixture"
