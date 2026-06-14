/**
 * time.ts — Shared timestamp formatting utilities.
 *
 * Two distinct display patterns exist across surfaces:
 *
 *   relativeTime     — compact relative (now / 5m / 3h / 2d) for list rows and
 *                      tooltips (tasks, hypotheses). Returns { short, full }.
 *
 *   relativeTimestamp — verbose relative (< 1h ago / 3h ago / 5d ago) for KR
 *                       drawer live-preview and the Goals top bar (goals surface).
 *                       Returns { short, full }.
 *
 * Both accept null / undefined and return a safe sentinel.
 */

export function relativeTime(
  iso: string | null | undefined,
): { short: string; full: string } {
  if (!iso) return { short: "—", full: "unknown" };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { short: "—", full: iso };
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  const hrs = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  const full = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (mins < 2) return { short: "now", full };
  if (hrs < 1) return { short: `${mins}m`, full };
  if (hrs < 24) return { short: `${hrs}h`, full };
  return { short: `${days}d`, full };
}

export function relativeTimestamp(
  iso: string | null | undefined,
): { short: string; full: string } {
  if (!iso) return { short: "—", full: "unknown" };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { short: "—", full: iso };
  const diffMs = Date.now() - d.getTime();
  const hrs = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  const full = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (hrs < 1) return { short: "< 1h ago", full };
  if (hrs < 24) return { short: `${hrs}h ago`, full };
  return { short: `${days}d ago`, full };
}
