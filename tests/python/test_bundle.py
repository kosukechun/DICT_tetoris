"""Ensure the artifact a beginner uploads is complete and matches the source."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def test_deployment_zip_has_correct_root_and_matches_current_source():
    with zipfile.ZipFile(ROOT / "release/dict-tetoris.zip") as bundle:
        names = set(bundle.namelist())
        required = {"package.json", "package-lock.json", "Procfile", "server/index.js",
                    "public/index.html", "shared/engine.js", ".ebextensions/01-app.config",
                    ".platform/nginx/conf.d/elasticbeanstalk/websocket.conf"}
        assert required <= names
        assert all(not name.startswith(("node_modules/", "data/", ".git/", ".env", ".aws/"))
                   for name in names)
        for name in names:
            assert bundle.read(name) == (ROOT / name).read_bytes(), f"Rebuild the ZIP: {name}"
