"""Real HTTP regression tests. Game logic itself runs in the Node test suite."""
import http.cookiejar
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request

import pytest

ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def running_server(tmp_path_factory, mode="test", secret=""):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ, PORT=str(port), NODE_ENV=mode, DYNAMODB_TABLE="", ORIGIN_SECRET=secret,
               DATA_DIR=str(tmp_path_factory.mktemp("game-db")))
    process = subprocess.Popen([shutil.which("node"), "server/index.js"], cwd=ROOT,
                               env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(100):
            if process.poll() is not None:
                pytest.fail(process.stderr.read().decode("utf-8", errors="replace"))
            try:
                urllib.request.urlopen(base + "/health", timeout=1).close()
                break
            except (OSError, urllib.error.URLError):
                time.sleep(0.05)
        else:
            pytest.fail("Node server did not become healthy")
        yield base
    finally:
        process.terminate()
        process.wait(timeout=10)
        process.stderr.close()


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    with running_server(tmp_path_factory) as base:
        yield base


@pytest.fixture(scope="module")
def production_server(tmp_path_factory):
    with running_server(tmp_path_factory, "production", "a" * 32) as base:
        yield base


@pytest.fixture
def client(server):
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def request(route, data=None, origin=None):
        headers = {"Origin": origin or server, "Content-Type": "application/json"}
        req = urllib.request.Request(server + "/api/" + route, headers=headers,
                                     data=None if data is None else json.dumps(data).encode())
        try:
            response = opener.open(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response), response.headers

    return request


def test_name_only_registration_and_automatic_return(client):
    status, body, headers = client("register", {"nickname": "ちゅん丸"})
    assert status == 200
    user = body["user"]
    assert user["nickname"] == "ちゅん丸"
    assert set(user) == {"username", "nickname"}
    assert "HttpOnly" in headers["Set-Cookie"]
    assert "SameSite=Strict" in headers["Set-Cookie"]
    assert client("me")[1]["user"] == user
    assert client("history")[1] == {"matches": []}


def test_rename_preserves_identity(client):
    first = client("register", {"nickname": "最初の名前"})[1]["user"]
    changed = client("register", {"nickname": "新しい名前"})[1]["user"]
    assert changed["username"] == first["username"]
    assert client("me")[1]["user"]["nickname"] == "新しい名前"


def test_production_requires_edge_header_and_sets_secure_cookie(production_server):
    def request(route, data=None, secret=None, origin="https://game.example"):
        headers = {"Host": "game.example", "Origin": origin, "Content-Type": "application/json"}
        if secret is not None:
            headers["X-Origin-Verify"] = secret
        req = urllib.request.Request(production_server + route, headers=headers,
                                     data=None if data is None else json.dumps(data).encode())
        try:
            return urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            return error

    with request("/health") as response:
        assert response.status == 200
    with request("/") as response:
        assert response.status == 403
    with request("/api/register", {"nickname": "edge"}, secret="wrong") as response:
        assert response.status == 403
    with request("/api/register", {"nickname": "edge"}, secret="a" * 32) as response:
        assert response.status == 200
        assert "Secure" in response.headers["Set-Cookie"]
        assert response.headers["Cache-Control"] == "no-store"
        assert json.load(response)["user"]["nickname"] == "edge"
    with request("/api/register", {"nickname": "edge"}, secret="a" * 32,
                 origin="https://other.example") as response:
        assert response.status == 403


def test_same_name_does_not_grant_another_players_identity(client, server):
    first = client("register", {"nickname": "同じ名前"})[1]["user"]
    req = urllib.request.Request(server + "/api/register", method="POST",
                                 data=json.dumps({"nickname": "同じ名前"}).encode(),
                                 headers={"Content-Type": "application/json", "Origin": server})
    with urllib.request.urlopen(req, timeout=5) as response:
        second = json.load(response)["user"]
    assert second["username"] != first["username"]


@pytest.mark.parametrize("nickname", ["", "   ", "長" * 17, 123, None])
def test_invalid_names_are_rejected(client, nickname):
    assert client("register", {"nickname": nickname})[0] == 400


def test_history_requires_browser_session_and_cross_origin_is_rejected(client):
    assert client("history")[0] == 401
    assert client("register", {"nickname": "test"}, origin="https://example.org")[0] == 403


def test_logout_revokes_session(client):
    client("register", {"nickname": "test"})
    assert client("logout", {})[0] == 200
    assert client("me")[1]["user"] is None
    assert client("history")[0] == 401
