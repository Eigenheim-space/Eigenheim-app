"""Stage C: the session-token handshake. Electron hands the engine a per-launch
token via a 0600 file; the engine reads it once, unlinks it, and then rejects any
request without the matching Bearer."""
import os
import tempfile

import pytest
from fastapi import HTTPException

from eigenheim import app as appmod


@pytest.fixture
def restore_auth():
    saved_token = appmod._auth_state["token"]
    saved_env = {k: os.environ.get(k) for k in ("EIGENHEIM_TOKEN", "EIGENHEIM_TOKEN_FILE")}
    yield
    appmod._auth_state["token"] = saved_token
    for k, v in saved_env.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def test_token_file_is_read_then_unlinked(restore_auth):
    fd, path = tempfile.mkstemp()
    os.write(fd, b"  deadbeefcafe  \n")  # leading/trailing space is stripped
    os.close(fd)
    os.environ["EIGENHEIM_TOKEN_FILE"] = path
    os.environ.pop("EIGENHEIM_TOKEN", None)
    appmod._auth_state["token"] = None

    appmod._resolve_session_token()

    assert appmod._auth_state["token"] == "deadbeefcafe"
    assert not os.path.exists(path), "the token file must be unlinked after reading"


def test_auth_enforced_once_token_set(restore_auth):
    appmod._auth_state["token"] = "secret123"
    # no header / wrong header -> 401
    with pytest.raises(HTTPException) as e1:
        appmod._auth(None)
    assert e1.value.status_code == 401
    with pytest.raises(HTTPException):
        appmod._auth("Bearer nope")
    # correct header -> passes (returns None)
    assert appmod._auth("Bearer secret123") is None


def test_open_when_no_token(restore_auth):
    appmod._auth_state["token"] = None
    # standalone-browser dev: no token configured => engine is open
    assert appmod._auth(None) is None


def test_missing_token_file_is_a_noop(restore_auth):
    os.environ["EIGENHEIM_TOKEN_FILE"] = "/nonexistent/eigenheim/session.token"
    os.environ.pop("EIGENHEIM_TOKEN", None)
    appmod._auth_state["token"] = "preexisting"
    appmod._resolve_session_token()  # must not raise, must not clobber
    assert appmod._auth_state["token"] == "preexisting"
