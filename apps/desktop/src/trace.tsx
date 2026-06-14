import { useApp } from "./store";
import { Modal, Snippet } from "./ui";
import { getReportFromCache } from "./queries";

function LineChart({ data, w = 840, h = 220 }: { data: number[]; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const padL = 8, padR = 8, padT = 16, padB = 24;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const x = (i: number) => padL + (i / (data.length - 1)) * (w - padL - padR);
  const y = (v: number) => padT + (1 - (v - min) / span) * (h - padT - padB);
  const line = data.map((d, i) => `${x(i)},${y(d)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const weeks = ["Wk 21", "Wk 22", "Wk 23", "Wk 24", "Wk 25", "Wk 26"];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }} role="img" aria-label="Metric trend by week">
      {grid.map((g, i) => {
        const gy = padT + g * (h - padT - padB);
        return <line key={i} x1={padL} y1={gy} x2={w - padR} y2={gy} stroke="var(--gray-200)" strokeWidth={1} strokeOpacity={0.6} />;
      })}
      <polyline points={line} fill="none" stroke="var(--brand-500)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {data.map((d, i) => <circle key={i} cx={x(i)} cy={y(d)} r={2.5} fill="var(--brand-600)" />)}
      {data.map((_, i) => i % 1 === 0 && i < weeks.length && (
        <text key={i} x={x(i)} y={h - 6} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={11} fill="var(--gray-400)">{weeks[i]}</text>
      ))}
    </svg>
  );
}

const dot = { position: "absolute" as const, left: -23.5, top: 5, width: 8, height: 8, borderRadius: 999, background: "var(--color-white)", border: "2px solid var(--brand-600)", boxSizing: "border-box" as const };

export function TraceModal() {
  const tm = useApp((s) => s.traceMetric);
  const close = useApp((s) => s.closeTrace);
  if (!tm) return null;
  const report = getReportFromCache(tm.reportId);
  const metric = report?.metrics.find((m) => m.id === tm.metricId);
  if (!metric) return null;
  // trace shape: {formula, steps, finalQuery, result} — engine returns {[key:string]:unknown}
  // so cast to the well-known shape from the mock (Metric["trace"]).
  const t = metric.trace as { formula: string; steps: { label: string; value: string; mono?: boolean }[]; finalQuery: string; result: string };
  return (
    <Modal title={<span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>{metric.name}<span className="tnum" style={{ fontSize: 13, fontWeight: 400, color: "var(--text-quaternary)", fontFamily: "var(--font-mono)" }}>= {metric.value}</span></span>} onClose={close} width={920}>
      {/* Top: chart + weekly table */}
      <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-secondary)" }}>
        <LineChart data={metric.series} />
        <div style={{ marginTop: 12, border: "1px solid var(--border-secondary)", borderRadius: 8, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", background: "var(--gray-50)", borderBottom: "1px solid var(--border-secondary)", fontSize: 12, fontWeight: 600, color: "var(--text-tertiary)" }}>
            <div style={{ padding: "8px 14px" }}>Week</div><div style={{ padding: "8px 14px", textAlign: "right" }}>Value</div><div style={{ padding: "8px 14px", textAlign: "right" }}>Δ%</div>
          </div>
          {metric.weeks.map((w, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: i < metric.weeks.length - 1 ? "1px solid var(--border-tertiary)" : "none", fontSize: 13 }}>
              <div className="tnum" style={{ padding: "8px 14px", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)" }}>{w.week}</div>
              <div className="tnum" style={{ padding: "8px 14px", textAlign: "right", fontFamily: "var(--font-mono)" }}>{w.value}</div>
              <div className="tnum" style={{ padding: "8px 14px", textAlign: "right", fontFamily: "var(--font-mono)", color: w.deltaPct == null ? "var(--text-quaternary)" : w.deltaPct >= 0 ? "var(--success-600)" : "var(--error-600)" }}>
                {w.deltaPct == null ? "—" : `${w.deltaPct >= 0 ? "+" : ""}${w.deltaPct}%`}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom: the trace (compiler-style) */}
      <div style={{ padding: "20px 24px" }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-quaternary)", marginBottom: 12 }}>how it was computed</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, lineHeight: 1.5, color: "var(--gray-900)", background: "var(--gray-50)", border: "1px solid var(--border-tertiary)", borderRadius: 8, padding: "14px 16px", overflowX: "auto", whiteSpace: "nowrap" }}>
          <span style={{ color: "var(--text-quaternary)" }}>metric</span> {highlight(t.formula)}
        </div>
        {t.steps.length > 0 && (
          <div style={{ position: "relative", marginTop: 10, paddingLeft: 28 }}>
            <div style={{ position: "absolute", left: 8, top: 14, bottom: 70, width: 1, background: "var(--border-secondary)" }} />
            {/*
             * 1.8 trace reveal: each node fades in sequentially, staggered ~40ms per step.
             * Uses the eh-trace-node keyframe defined in globals.css.
             * Collapses to instant under prefers-reduced-motion via the CSS media query.
             */}
            {t.steps.map((s, i) => (
              <div key={i} style={{
                position: "relative", padding: "12px 0 2px",
                animation: `eh-trace-node 180ms ease-out ${i * 40}ms both`,
              }}>
                <span style={dot} />
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em", color: "var(--text-quaternary)" }}>{s.label}</div>
                <div className="tnum" style={{ marginTop: 3, fontFamily: s.mono ? "var(--font-mono)" : "var(--font-sans)", fontSize: 13, lineHeight: 1.5, color: "var(--text-secondary)" }}>{s.value}</div>
              </div>
            ))}
            <div style={{
              position: "relative", padding: "14px 0 2px",
              animation: `eh-trace-node 180ms ease-out ${t.steps.length * 40}ms both`,
            }}>
              <span style={{ ...dot, top: 18, background: "var(--brand-600)", border: "none" }} />
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em", color: "var(--text-quaternary)" }}>final query</div>
              <div style={{ marginTop: 6 }}><Snippet block value={t.finalQuery} /></div>
            </div>
            <div style={{
              position: "relative", padding: "14px 0 2px",
              animation: `eh-trace-node 180ms ease-out ${(t.steps.length + 1) * 40}ms both`,
            }}>
              <span style={{ ...dot, top: 18, background: "var(--brand-600)", border: "none" }} />
              <div className="tnum" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text-primary)" }}>= {t.result}</div>
              <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-quaternary)" }}>same inputs, same number, every run · 0 tokens</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// tiny syntax highlight for the formula line
function highlight(formula: string) {
  const parts = formula.split(/(\bunique\b|\bmedian\b|→|≤|\/|=)/g);
  return parts.map((p, i) => {
    if (p === "unique" || p === "median") return <span key={i} style={{ color: "var(--brand-700)" }}>{p}</span>;
    if (p === "→" || p === "≤" || p === "/" || p === "=") return <span key={i} style={{ color: "var(--text-quaternary)" }}>{p}</span>;
    return <span key={i}>{p}</span>;
  });
}
