# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report to **security@eigenheim.space** with:

- A description of the vulnerability and its potential impact.
- Steps to reproduce or a proof-of-concept (attach files or a private Gist).
- The version or commit hash where you observed the issue.

You will receive an acknowledgement within **72 hours**. A status update
follows within **7 days** indicating whether the report is accepted, needs
more information, or is out of scope.

Accepted reports are fixed and disclosed after a patch is available. You will
be credited unless you request otherwise.

## Scope

In scope:
- The eigenheim desktop app (`apps/desktop/`) and engine sidecar (`engine/`).
- The MCP server exposed by the engine.
- The session-token handshake and safeStorage key handling.
- Any mechanism that handles user-supplied data, source credentials, or
  formula definitions.

Out of scope:
- The marketing site (`eigenheim.space`) — report via the same address.
- Vulnerabilities in third-party dependencies already reported upstream.
- Denial-of-service against the local sidecar on a machine the attacker
  already controls (no network exposure by design).
- Issues that require physical access to the user's machine.

## Expectations

eigenheim is a local-first desktop app: there is no multi-tenant server and
no user data leaves the machine except via integrations the user explicitly
connects. The attack surface is the sidecar-to-renderer IPC, source
credentials in safeStorage, and the MCP protocol surface. Reports in those
areas are taken seriously.
