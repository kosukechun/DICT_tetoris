"""Run the authoritative JavaScript engine through a virtual ten-minute duel."""
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def test_virtual_ten_minute_online_battle():
    result = subprocess.run(
        [shutil.which("node"), "--test", "tests/long_battle.test.js"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_rotation_cpu_and_online_scenarios():
    result = subprocess.run(
        [shutil.which("node"), "--test", "tests/rotation_scenarios.test.js"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
