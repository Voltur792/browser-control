#!/usr/bin/env python3
"""Per-user registration, no root, registry or system Python packages required."""
import argparse
import importlib.util
import json
from pathlib import Path
import shlex
import shutil
import sys


def destinations(platform, home, config):
    if platform == "darwin":
        root = home / "Library/Application Support"
        profiles = [root / p for p in ("Google/Chrome", "Chromium", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Vivaldi", "com.operasoftware.Opera", "Yandex/YandexBrowser")]
    else:
        profiles = [config / p for p in ("google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser", "vivaldi", "opera", "yandex-browser")]
    return [p / "NativeMessagingHosts" for p in profiles]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remove", action="store_true")
    options = parser.parse_args()
    if sys.platform not in ("linux", "darwin"):
        parser.error("В Windows используйте install-native-host.ps1")
    source = Path(__file__).resolve().parent / "native-host/posix_host.py"
    spec = importlib.util.spec_from_file_location("native_posix", source)
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    target = host.data_dir() / "native"
    import os
    config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    if not config.is_absolute():
        config = Path.home() / ".config"
    directories = destinations(sys.platform, Path.home(), config)
    for directory in directories:
        manifest = directory / f"{host.HOST_NAME}.json"
        if options.remove:
            if manifest.exists():
                value = json.loads(manifest.read_text(encoding="utf-8"))
                if value.get("path") == str(target / "browser-control-host"):
                    manifest.unlink()
            continue
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source, target / "host.py")
        launcher = target / "browser-control-host"
        launcher.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(target / "host.py")) + ' "$@"\n', encoding="utf-8")
        launcher.chmod(0o700)
        directory.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps({"name": host.HOST_NAME, "description": "Astra Browser Control local bridge", "path": str(launcher),
                                       "type": "stdio", "allowed_origins": [f"chrome-extension://{host.EXTENSION_ID}/"]}, indent=2), encoding="utf-8")
    print("Регистрация удалена." if options.remove else "Мост зарегистрирован. Перезапустите браузер и проверьте соединение во вкладке Astra.")


if __name__ == "__main__":
    main()
