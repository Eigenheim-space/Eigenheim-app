"""eigenheim CLI entrypoint.

Subcommands
-----------
eigenheim serve          Launch the FastAPI engine (uvicorn on 127.0.0.1:8765).
eigenheim mcp serve      Launch the MCP server (stdio transport).
eigenheim version        Print the version string.

The CLI is intentionally thin: subcommands delegate to existing modules and add
no logic of their own. The session-token handshake (EIGENHEIM_TOKEN_FILE) is
honoured automatically because the FastAPI app reads it in its lifespan.

Auth note — MCP scopes
-----------------------
Scopes are enforced per tool call inside mcp_auth.require_scope(), not at server
startup. There is no meaningful --scopes flag to pass at launch time; keys and
their scopes are managed via POST /mcp-keys on the REST surface. The command the
user pastes into their agent config is simply `eigenheim mcp serve`.
"""
from __future__ import annotations

import argparse
import sys


def _cmd_serve(args: argparse.Namespace) -> None:
    """Launch the FastAPI engine via uvicorn."""
    import uvicorn

    uvicorn.run(
        "eigenheim.app:app",
        host=args.host,
        port=args.port,
        log_level=args.log_level,
    )


def _cmd_mcp_serve(_args: argparse.Namespace) -> None:
    """Launch the MCP server on stdio."""
    from eigenheim.mcp_server import mcp

    mcp.run()


def _cmd_version(_args: argparse.Namespace) -> None:
    from eigenheim import __version__

    print(f"eigenheim {__version__}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="eigenheim",
        description="eigenheim deterministic metrics engine",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {_get_version()}",
    )

    sub = parser.add_subparsers(dest="command", metavar="<command>")

    # --- serve ----------------------------------------------------------------
    serve_p = sub.add_parser("serve", help="Launch the FastAPI engine")
    serve_p.add_argument(
        "--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)"
    )
    serve_p.add_argument(
        "--port", type=int, default=8765, help="Bind port (default: 8765)"
    )
    serve_p.add_argument(
        "--log-level",
        default="info",
        choices=["critical", "error", "warning", "info", "debug", "trace"],
        dest="log_level",
        help="Uvicorn log level (default: info)",
    )
    serve_p.set_defaults(func=_cmd_serve)

    # --- mcp ------------------------------------------------------------------
    mcp_p = sub.add_parser("mcp", help="MCP server subcommands")
    mcp_sub = mcp_p.add_subparsers(dest="mcp_command", metavar="<mcp-command>")

    mcp_sub.add_parser(
        "serve",
        help=(
            "Launch the MCP server (stdio). "
            "Authentication is per-call via the EIGENHEIM_MCP_KEY passed as the "
            "key argument to each tool; scopes are enforced at call time, not at "
            "startup. Manage keys via Settings > API keys in the app."
        ),
    ).set_defaults(func=_cmd_mcp_serve)

    # --- version --------------------------------------------------------------
    sub.add_parser("version", help="Print the version").set_defaults(func=_cmd_version)

    return parser


def _get_version() -> str:
    from eigenheim import __version__

    return __version__


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        sys.exit(0)

    if args.command == "mcp":
        if not args.mcp_command:
            # `eigenheim mcp` with no sub-subcommand: show mcp help
            parser.parse_args(["mcp", "--help"])
        args.func(args)
        return

    if not hasattr(args, "func"):
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
