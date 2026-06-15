/**
 * chat/context.ts
 *
 * Shared context builder and answer-segment parser for all chat surfaces
 * (overlay and, later, full-page chat).
 *
 * buildContextBlock reads from the Zustand store via getState() — intentionally
 * NOT a hook so it can be called from event handlers and outside React render.
 * parseAnswerSegments is pure: it takes the already-resolved metrics as input.
 */

import { useApp } from "../store";
import { getReportFromCache } from "../queries";

// ─── Metric chip data type ────────────────────────────────────────────────────

export interface MetricChip {
  name: string;
  value: string;
  metricId: string;
  reportId: string;
  verified: boolean;
}

// ─── Context builder ──────────────────────────────────────────────────────────

/**
 * Build the system-prompt context block from the currently open report.
 * Reads live state via getState() (not a hook — safe to call outside render).
 */
export function buildContextBlock(): string {
  const s = useApp.getState();
  const reportId = s.openReportId;
  if (!reportId) return "";
  const report = getReportFromCache(reportId);
  if (!report) return "";
  const lines: string[] = [
    `Report: ${report.name} (period: ${report.period}, status: ${report.status})`,
    `Metrics:`,
  ];
  for (const m of report.metrics) {
    lines.push(
      `  - ${m.name}: ${m.value ?? "—"} (delta: ${m.delta != null ? `${m.delta > 0 ? "+" : ""}${m.delta}%` : "n/a"}, status: ${m.status})`
    );
  }
  lines.push(
    `\nNote: these numbers are deterministically computed by eigenheim from validated formulas. Cite them exactly. Do not invent numbers.`
  );
  return lines.join("\n");
}

// ─── Answer segment parser ────────────────────────────────────────────────────

/**
 * Match metric citations in assistant text.
 * Returns an array of {text, chip?} segments for inline rendering.
 */
export function parseAnswerSegments(
  text: string,
  metrics: { id: string; name: string; value: string | null }[],
  reportId: string
): Array<{ text: string; chip?: MetricChip }> {
  if (!metrics.length) return [{ text }];

  const segments: Array<{ text: string; chip?: MetricChip }> = [];
  let remaining = text;

  // For each metric, check if the name appears in the text and wrap it in a chip.
  // Simple string search — not regex to avoid false positives.
  const matched = new Set<string>();

  for (const m of metrics) {
    const pattern = m.name;
    const idx = remaining.toLowerCase().indexOf(pattern.toLowerCase());
    if (idx === -1 || matched.has(m.id)) continue;
    matched.add(m.id);

    if (idx > 0) segments.push({ text: remaining.slice(0, idx) });
    segments.push({
      text: pattern,
      chip: {
        name: m.name,
        value: m.value ?? "—",
        metricId: m.id,
        reportId,
        verified: true,
      },
    });
    remaining = remaining.slice(idx + pattern.length);
  }

  if (remaining) segments.push({ text: remaining });
  return segments;
}
