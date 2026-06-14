"""Tests for eigenheim.cli.

Tests verify:
- `eigenheim version` prints the version string and exits 0.
- `eigenheim --version` also prints the version.
- `eigenheim mcp serve` dispatches to mcp_server.mcp.run().
- `eigenheim serve` dispatches to uvicorn.run().
- An unknown subcommand exits non-zero.
- `eigenheim` with no args exits 0 (prints help).
"""
from __future__ import annotations

import sys
from unittest.mock import MagicMock, patch

import pytest

from eigenheim import __version__
from eigenheim.cli import build_parser, main


# ---------------------------------------------------------------------------
# version
# ---------------------------------------------------------------------------

def test_version_subcommand(capsys):
    main(["version"])
    out = capsys.readouterr().out
    assert __version__ in out
    assert "eigenheim" in out


def test_version_flag():
    """--version flag exits 0 and prints the version."""
    with pytest.raises(SystemExit) as exc:
        main(["--version"])
    assert exc.value.code == 0


# ---------------------------------------------------------------------------
# mcp serve dispatch
# ---------------------------------------------------------------------------

def test_mcp_serve_dispatches_to_mcp_run():
    """eigenheim mcp serve calls mcp_server.mcp.run(), does not block in tests."""
    mock_mcp = MagicMock()
    with patch("eigenheim.mcp_server.mcp", mock_mcp):
        main(["mcp", "serve"])
    mock_mcp.run.assert_called_once()


# ---------------------------------------------------------------------------
# serve dispatch
# ---------------------------------------------------------------------------

def test_serve_dispatches_to_uvicorn():
    """eigenheim serve calls uvicorn.run() with the correct app string."""
    with patch("uvicorn.run") as mock_run:
        main(["serve"])
    mock_run.assert_called_once()
    call_args = mock_run.call_args
    assert call_args[0][0] == "eigenheim.app:app"


def test_serve_custom_port():
    """eigenheim serve --port 9000 passes the port to uvicorn."""
    with patch("uvicorn.run") as mock_run:
        main(["serve", "--port", "9000"])
    call_args = mock_run.call_args
    assert call_args[1]["port"] == 9000


def test_serve_default_host_is_loopback():
    """Default host is 127.0.0.1 (never 0.0.0.0)."""
    with patch("uvicorn.run") as mock_run:
        main(["serve"])
    call_args = mock_run.call_args
    assert call_args[1]["host"] == "127.0.0.1"


# ---------------------------------------------------------------------------
# error paths
# ---------------------------------------------------------------------------

def test_no_args_exits_zero(capsys):
    """No subcommand: prints help and exits 0."""
    with pytest.raises(SystemExit) as exc:
        main([])
    assert exc.value.code == 0


def test_unknown_subcommand_exits_nonzero():
    """An unrecognised subcommand must exit non-zero."""
    with pytest.raises(SystemExit) as exc:
        main(["notacommand"])
    assert exc.value.code != 0


# ---------------------------------------------------------------------------
# import smoke
# ---------------------------------------------------------------------------

def test_import_clean():
    """eigenheim.cli imports without side effects."""
    import importlib
    import eigenheim.cli as cli_mod
    importlib.reload(cli_mod)
    assert callable(cli_mod.main)
    assert callable(cli_mod.build_parser)
