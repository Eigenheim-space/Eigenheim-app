"""Task-tracker adapters: read-only pulls from Jira and Linear.

Architecture mirrors adapters.py exactly:
  - A `TaskAdapter` Protocol defines the interface every tracker implements.
  - Each adapter takes an injectable `Fetch` callable so tests run against
    fixtures, never live credentials.
  - A failed pull raises `TaskAdapterError` and NEVER clears the task cache.
  - Raw API tokens arrive at call time (from Electron safeStorage); they are
    passed directly to the HTTP layer and are NEVER persisted in SQLite.

Token posture (T5):
  The caller (app.py sync endpoint) receives the raw token from the renderer,
  which retrieved it from safeStorage.  The token is passed into
  `adapter.fetch_tasks(token)` and `adapter.test_connection(token)`.
  It does not appear in any log statement, is not stored in the DB, and is not
  returned in any response payload.

eigenheim is READ-ONLY toward trackers.  Neither adapter exposes a write path.

Normalised task dict shape (returned by fetch_tasks):
    {
        "external_id": str,    # Jira issue key ("ENG-42") or Linear issue id
        "title":       str,
        "status":      str,    # status name from the tracker
        "assignee":    str,    # display name or empty string
        "url":         str,    # canonical web URL
        "updated_at":  str,    # ISO-8601 UTC, trimmed to seconds
        "raw_json":    dict,   # original payload from the tracker API
    }
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Protocol


# A fetch callable mirrors adapters.Fetch: (url, headers, body_bytes) -> response_text.
# body_bytes may be b"" for GET requests.
Fetch = Callable[[str, dict, bytes], str]


class TaskAdapterError(RuntimeError):
    """Raised on any pull failure (auth, network, parse, empty result).
    The caller must NOT clear the task cache when this is raised."""


# ---- Protocol ---------------------------------------------------------------

class TaskAdapter(Protocol):
    """Read-only interface every tracker adapter must satisfy."""

    def test_connection(self, token: str, fetch: Fetch | None = None) -> dict:
        """Verify the token and return a dict with keys:
            ok (bool), workspace (str), project_key (str).
        Raises TaskAdapterError on failure."""
        ...

    def fetch_tasks(self, token: str, fetch: Fetch | None = None) -> list[dict]:
        """Pull tasks from the tracker and return a list of normalised task dicts.
        Raises TaskAdapterError on failure or empty result.
        MUST NOT return an empty list (stale-gate: callers check for non-empty)."""
        ...


# ---- Default HTTP fetch -----------------------------------------------------

def _default_fetch(url: str, headers: dict, body: bytes) -> str:
    method = "POST" if body else "GET"
    req = urllib.request.Request(url, data=body or None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310
            return resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise e  # re-raise for adapter-specific handling
    except Exception as e:
        raise TaskAdapterError(f"network error: {e}") from e


# ---- Jira adapter -----------------------------------------------------------

class JiraAdapter:
    """Read tasks from a Jira Cloud project using the Jira REST API v3.

    Scope required on the Jira API token: read:jira-work (classic) or
    read:issue:jira (granular).  eigenheim never requests write scopes.

    Parameters:
        base_url:    Jira Cloud base URL, e.g. "https://myorg.atlassian.net"
        project_key: Jira project key, e.g. "ENG"
        jql_extra:   optional extra JQL appended to the project filter
        max_results: maximum issues per fetch (capped at 100 by Jira)
    """

    def __init__(
        self,
        base_url: str,
        project_key: str,
        jql_extra: str = "",
        max_results: int = 100,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.project_key = project_key
        self.jql_extra = jql_extra
        self.max_results = min(max_results, 100)

    # -- internal helpers -----------------------------------------------------

    def _headers(self, token: str) -> dict:
        # Jira Cloud API tokens are used as the password in HTTP Basic Auth:
        #   Authorization: Basic base64("email:api_token")
        # The caller passes token as "email:api_token" (colon-separated).
        # The raw token is NOT logged anywhere.
        encoded = base64.b64encode(token.encode()).decode()
        return {
            "Authorization": f"Basic {encoded}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _get(self, path: str, token: str, params: dict, fetch: Fetch | None) -> dict:
        fetch = fetch or _default_fetch
        qs = urllib.parse.urlencode(params)
        url = f"{self.base_url}{path}?{qs}"
        try:
            text = fetch(url, self._headers(token), b"")
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise TaskAdapterError(
                    "Jira: проверка остановлена. Токен отклонён (401). "
                    "Обнови подключение: Settings → Integrations."
                ) from e
            if e.code == 403:
                raise TaskAdapterError(
                    "Jira: доступ запрещён (403). Проверь права токена: нужен read:jira-work."
                ) from e
            raise TaskAdapterError(
                f"Jira: запрос отклонён ({e.code}). Проверь base_url и project key."
            ) from e
        except TaskAdapterError:
            raise
        except Exception as e:
            raise TaskAdapterError(f"Jira: нет связи с сервером. {e}") from e
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise TaskAdapterError(f"Jira: ответ не является JSON. {e}") from e

    @staticmethod
    def _normalise(issue: dict) -> dict:
        fields = issue.get("fields", {})
        assignee_info = fields.get("assignee") or {}
        return {
            "external_id": issue.get("key", ""),
            "title":       fields.get("summary", ""),
            "status":      (fields.get("status") or {}).get("name", ""),
            "assignee":    assignee_info.get("displayName", ""),
            "url":         issue.get("self", "").split("/rest/")[0]
                           + "/browse/" + issue.get("key", ""),
            "updated_at":  (fields.get("updated") or "")[:19].replace("T", " "),
            "raw_json":    issue,
        }

    # -- protocol implementation ----------------------------------------------

    def test_connection(self, token: str, fetch: Fetch | None = None) -> dict:
        data = self._get("/rest/api/3/myself", token, {}, fetch)
        display = data.get("displayName", "") or data.get("emailAddress", "")
        # Probe the project to confirm access.
        proj = self._get(
            f"/rest/api/3/project/{self.project_key}", token, {}, fetch
        )
        workspace = f"{proj.get('name', self.project_key)} / {self.project_key}"
        return {"ok": True, "workspace": workspace, "project_key": self.project_key}

    def fetch_tasks(self, token: str, fetch: Fetch | None = None) -> list[dict]:
        jql = f"project = {self.project_key}"
        if self.jql_extra:
            jql += f" AND {self.jql_extra}"
        jql += " ORDER BY updated DESC"
        data = self._get(
            "/rest/api/3/search",
            token,
            {
                "jql": jql,
                "maxResults": self.max_results,
                "fields": "summary,status,assignee,updated",
            },
            fetch,
        )
        issues = data.get("issues", [])
        if not issues:
            raise TaskAdapterError(
                f"Jira: проект {self.project_key!r} не вернул задач. "
                "Проверь project key, JQL-фильтр и права токена."
            )
        return [self._normalise(i) for i in issues]


# ---- Linear adapter ---------------------------------------------------------

class LinearAdapter:
    """Read tasks from Linear using the Linear GraphQL API.

    Scope required on the Linear API key: read (the default personal API key
    has full read access; eigenheim never requests write scopes).

    Parameters:
        team_key: Linear team key (e.g. "ENG") to filter issues, or empty for all.
        max_results: maximum issues per fetch (Linear allows up to 250).
    """

    _API_URL = "https://api.linear.app/graphql"

    def __init__(self, team_key: str = "", max_results: int = 100) -> None:
        self.team_key = team_key
        self.max_results = min(max_results, 250)

    # -- internal helpers -----------------------------------------------------

    def _headers(self, token: str) -> dict:
        # Linear API tokens are Bearer tokens.
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    def _gql(self, query: str, variables: dict, token: str, fetch: Fetch | None) -> dict:
        fetch = fetch or _default_fetch
        body = json.dumps({"query": query, "variables": variables}).encode()
        try:
            text = fetch(self._API_URL, self._headers(token), body)
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise TaskAdapterError(
                    "Linear: проверка остановлена. Токен отклонён (401). "
                    "Обнови подключение: Settings → Integrations."
                ) from e
            raise TaskAdapterError(
                f"Linear: запрос отклонён ({e.code})."
            ) from e
        except TaskAdapterError:
            raise
        except Exception as e:
            raise TaskAdapterError(f"Linear: нет связи с сервером. {e}") from e
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise TaskAdapterError(f"Linear: ответ не является JSON. {e}") from e
        if "errors" in data:
            msgs = "; ".join(e.get("message", str(e)) for e in data["errors"])
            raise TaskAdapterError(f"Linear: GraphQL ошибка: {msgs}")
        return data.get("data", {})

    @staticmethod
    def _normalise(node: dict) -> dict:
        state = node.get("state") or {}
        assignee = node.get("assignee") or {}
        return {
            "external_id": node.get("id", ""),
            "title":       node.get("title", ""),
            "status":      state.get("name", ""),
            "assignee":    assignee.get("displayName", ""),
            "url":         node.get("url", ""),
            "updated_at":  (node.get("updatedAt") or "")[:19].replace("T", " "),
            "raw_json":    node,
        }

    # -- protocol implementation ----------------------------------------------

    def test_connection(self, token: str, fetch: Fetch | None = None) -> dict:
        q = "query { viewer { id displayName organization { name } } }"
        data = self._gql(q, {}, token, fetch)
        viewer = data.get("viewer") or {}
        org = viewer.get("organization") or {}
        workspace = org.get("name", "Linear")
        if self.team_key:
            workspace = f"{workspace} / {self.team_key}"
        return {"ok": True, "workspace": workspace, "project_key": self.team_key}

    def fetch_tasks(self, token: str, fetch: Fetch | None = None) -> list[dict]:
        if self.team_key:
            q = """
            query($teamKey: String!, $first: Int!) {
                issues(
                    filter: { team: { key: { eq: $teamKey } } }
                    first: $first
                    orderBy: updatedAt
                ) {
                    nodes {
                        id title url updatedAt
                        state  { name }
                        assignee { displayName }
                    }
                }
            }
            """
            variables = {"teamKey": self.team_key, "first": self.max_results}
        else:
            q = """
            query($first: Int!) {
                issues(first: $first, orderBy: updatedAt) {
                    nodes {
                        id title url updatedAt
                        state  { name }
                        assignee { displayName }
                    }
                }
            }
            """
            variables = {"first": self.max_results}
        data = self._gql(q, variables, token, fetch)
        nodes = (data.get("issues") or {}).get("nodes", [])
        if not nodes:
            raise TaskAdapterError(
                "Linear: запрос не вернул задач. "
                "Проверь team key, фильтр и права токена."
            )
        return [self._normalise(n) for n in nodes]
