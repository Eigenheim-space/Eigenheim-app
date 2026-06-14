"""Data-source adapters: ingest events into the `events` table from a CSV export
or a PostHog project. Generic, never wired to a specific project. The HTTP fetch
is injectable so the adapter is tested against a fixture, with no live call."""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import urllib.request
from typing import Callable

# A fetch takes (url, headers, body_bytes) and returns the response text.
Fetch = Callable[[str, dict, bytes], str]


class AdapterError(RuntimeError):
    pass


def _replace_events(conn: sqlite3.Connection, rows: list[tuple[str, str, str]]) -> int:
    # Guard: never wipe existing data when the source returned nothing.
    # An empty result means the fetch failed or the source is empty; in either
    # case, keeping the last good data beats returning a blank slate.
    if not rows:
        raise AdapterError("источник не вернул ни одного события")
    conn.execute("DELETE FROM events")
    conn.executemany("INSERT INTO events(user_id, name, ts) VALUES (?,?,?)", rows)
    conn.commit()
    return len(rows)


def ingest_csv(conn: sqlite3.Connection, text: str) -> int:
    """CSV columns: user_id, event (or name), timestamp (or ts)."""
    reader = csv.DictReader(io.StringIO(text))
    rows: list[tuple[str, str, str]] = []
    for r in reader:
        uid = r.get("user_id") or r.get("distinct_id") or r.get("person_id")
        name = r.get("event") or r.get("name")
        ts = r.get("timestamp") or r.get("ts")
        if not (uid and name and ts):
            continue
        rows.append((str(uid), str(name), str(ts)[:19].replace("T", " ")))
    return _replace_events(conn, rows)


def _default_fetch(url: str, headers: dict, body: bytes) -> str:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 (trusted user-supplied host)
        return resp.read().decode("utf-8")


def _host_url(host: str) -> str:
    if host == "eu":
        return "https://eu.posthog.com"
    if host in ("us", "cloud"):
        return "https://us.posthog.com"
    return host.rstrip("/")  # self-hosted full URL


def posthog_query(host: str, project_id: str, api_key: str, hogql: str, fetch: Fetch | None = None) -> list[list]:
    fetch = fetch or _default_fetch
    url = f"{_host_url(host)}/api/projects/{project_id}/query/"
    body = json.dumps({"query": {"kind": "HogQLQuery", "query": hogql}}).encode()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    try:
        text = fetch(url, headers, body)
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        if e.code == 401:
            raise AdapterError("PostHog adapter: проверка остановлена. Ключ отклонён сервером (401). Проверь ключ в Settings → Data sources.") from e
        raise AdapterError(f"PostHog adapter: запрос отклонён ({e.code}). Проверь project id и хост.") from e
    except Exception as e:  # noqa: BLE001
        # Do not echo the raw exception: it may contain the caller-supplied host or
        # connection internals.  Log a safe, controlled message instead.
        raise AdapterError("PostHog adapter: connection to host failed. Check the host setting in Settings → Data sources.") from e
    data = json.loads(text)
    return data.get("results", [])


def posthog_test(host: str, project_id: str, api_key: str, fetch: Fetch | None = None) -> dict:
    rows = posthog_query(host, project_id, api_key, "SELECT count() FROM events LIMIT 1", fetch=fetch)
    total = rows[0][0] if rows and rows[0] else 0
    return {"ok": True, "events_visible": total}


def posthog_sync(conn: sqlite3.Connection, host: str, project_id: str, api_key: str, days: int = 30,
                 fetch: Fetch | None = None) -> int:
    hogql = (
        "SELECT person_id, event, toString(timestamp) FROM events "
        f"WHERE timestamp > now() - INTERVAL {int(days)} DAY ORDER BY timestamp LIMIT 200000"
    )
    results = posthog_query(host, project_id, api_key, hogql, fetch=fetch)
    rows = [(str(r[0]), str(r[1]), str(r[2])[:19].replace("T", " ")) for r in results if len(r) >= 3]
    return _replace_events(conn, rows)
