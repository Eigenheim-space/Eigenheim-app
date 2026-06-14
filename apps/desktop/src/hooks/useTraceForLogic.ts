/**
 * useTraceForLogic.ts — Shared hook for trace resolution.
 *
 * Wraps the `findReportForMetric` cache scan + `openTrace` store call into
 * one place so goals, decisions, hypotheses and tasks do not each inline the
 * same two-line pattern. Returns a stable callback; callers invoke it on user
 * action (click), not during render.
 *
 * No-trace case: `handleTrace` is a no-op (does not open a dialog or alert).
 * The caller is responsible for guarding the button (disabled / hidden) when
 * `reportId` is null if a disabled affordance is required.
 */

import { useCallback } from "react";
import { useApp } from "../store";
import { findReportForMetric } from "../queries";

export interface TraceForLogicResult {
  /** The report id that contains this logic, or null if none is cached. */
  reportId: string | null;
  /**
   * Call on user action. Opens the trace modal if a report is found.
   * Does nothing when `logicId` is null or no cached report contains it.
   */
  handleTrace: () => void;
}

export function useTraceForLogic(
  logicId: string | null | undefined,
): TraceForLogicResult {
  const openTrace = useApp((s) => s.openTrace);

  const handleTrace = useCallback(() => {
    if (!logicId) return;
    const rep = findReportForMetric(logicId);
    if (rep) openTrace(rep.id, logicId);
    // No fallback alert — surfaces must not use window.alert.
  }, [logicId, openTrace]);

  // Compute reportId synchronously (cache read, not reactive).
  // This is safe for event-handler gating (disabled state) — it reads
  // the same cache that handleTrace will read, so they stay in sync.
  const reportId = logicId ? (findReportForMetric(logicId)?.id ?? null) : null;

  return { reportId, handleTrace };
}
