"""Run the authoritative match timeout, cheat mode and gravity regressions."""
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def test_match_timeout_cheat_and_gravity_rules():
    result = subprocess.run(
        [shutil.which("node"), "--test", "tests/match_rules.test.js"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
