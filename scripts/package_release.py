"""Create the exact ZIP that users upload in the AWS console; no AWS access."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "release" / "dict-tetoris.zip"


def source_files():
    files = [ROOT / name for name in ("package.json", "package-lock.json", "Procfile")]
    for directory in ("public", "server", "shared", ".platform", ".ebextensions"):
        files.extend(p for p in (ROOT / directory).rglob("*") if p.is_file())
    return sorted(files)


def build():
    OUTPUT.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as bundle:
        for file in source_files():
            info = zipfile.ZipInfo(file.relative_to(ROOT).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, file.read_bytes())
    print(f"Created {OUTPUT.name} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build()
