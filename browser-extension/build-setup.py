"""Build the bounded public extension installer archive (Windows and POSIX)."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAMES = {
    "install-extension.cmd", "install-extension.ps1",
    "browser-extension/install-native-host.ps1", "browser-extension/install-native-host.py",
    "browser-extension/native-host/posix_host.py",
    "browser-extension/manifest.json", "browser-extension/background.js",
    "browser-extension/popup.html", "browser-extension/popup.css", "browser-extension/popup.js",
    "browser-extension/native-host/portable/BrowserControlNativeHost.exe",
    *(f"browser-extension/icons/icon{size}.png" for size in (16, 32, 48, 128)),
}


def main():
    output = ROOT / "ui/web/extension-setup.zip"
    old = zipfile.ZipFile(output) if output.is_file() else None
    temporary = output.with_suffix(".tmp")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
            for name in sorted(NAMES):
                path = ROOT / name
                data = path.read_bytes() if path.is_file() else old.read(name) if old else None
                if data is None:
                    raise FileNotFoundError(name)
                info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                package.writestr(info, data)
        if old:
            old.close()
        temporary.replace(output)
    finally:
        if old:
            old.close()
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
