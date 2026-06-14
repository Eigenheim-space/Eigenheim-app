import {
  useState, useRef, useCallback, useEffect,
  type CSSProperties, type ReactNode,
} from "react";
import { Check, Copy, X, AlertCircle, AlertTriangle, Info } from "lucide-react";

/* ---------------- logomark (|ψ⟩ ket) ---------------- */
export function Ket({ size = 20, color = "var(--brand-600)" }: { size?: number; color?: string }) {
  const s = size / 32;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <rect x={3} y={6} width={4} height={20} rx={2} fill={color} transform={`scale(${s})`} style={{ transformOrigin: "0 0" }} />
      <path d={`M11 7 L20 16 L11 25`} stroke={color} strokeWidth={3.6} strokeLinecap="round" strokeLinejoin="round" fill="none" transform={`scale(${s})`} style={{ transformOrigin: "0 0" }} />
    </svg>
  );
}

/* ---------------- Badge ---------------- */
type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "brand";
const TONE: Record<Tone, { bg: string; fg: string; dot: string }> = {
  neutral: { bg: "var(--gray-100)", fg: "var(--gray-700)", dot: "var(--gray-400)" },
  info: { bg: "var(--blue-50)", fg: "var(--blue-700)", dot: "var(--blue-500)" },
  success: { bg: "var(--success-50)", fg: "var(--success-700)", dot: "var(--success-500)" },
  warning: { bg: "var(--warning-50)", fg: "var(--warning-700)", dot: "var(--warning-500)" },
  danger: { bg: "var(--error-50)", fg: "var(--error-700)", dot: "var(--error-500)" },
  brand: { bg: "var(--brand-50)", fg: "var(--brand-700)", dot: "var(--brand-500)" },
};
export function Badge({ tone = "neutral", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  const c = TONE[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: c.bg, color: c.fg, borderRadius: "var(--radius-badge)", padding: "1px 7px", fontSize: 12, lineHeight: "18px", fontWeight: 500, whiteSpace: "nowrap" }}>
      {dot && <span aria-hidden style={{ width: 6, height: 6, borderRadius: "var(--radius-full)", background: c.dot }} />}
      {children}
    </span>
  );
}
// status badge helper (foundation taxonomy)
const STATUS: Record<string, { tone: Tone; label: string; dot?: boolean }> = {
  mock: { tone: "neutral", label: "mock" },
  synced: { tone: "info", label: "synced", dot: true },
  custom: { tone: "neutral", label: "custom" },
  draft: { tone: "warning", label: "agent draft" },
  "needs-validation": { tone: "warning", label: "needs validation" },
  stale: { tone: "warning", label: "stale", dot: true },
  error: { tone: "danger", label: "error", dot: true },
  live: { tone: "success", label: "live", dot: true },
  collecting: { tone: "warning", label: "collecting", dot: true },
  ok: { tone: "success", label: "ok" },
};
export function StatusBadge({ kind }: { kind: keyof typeof STATUS | string }) {
  const s = STATUS[kind] ?? { tone: "neutral" as Tone, label: kind };
  return <Badge tone={s.tone} dot={s.dot}>{s.label}</Badge>;
}

/* ---------------- Button ---------------- */
type Hier = "primary" | "secondary" | "tertiary" | "link" | "danger";
const BTN: Record<Hier, CSSProperties> = {
  primary: { background: "var(--brand-600)", color: "#fff", border: "1px solid var(--brand-600)" },
  secondary: { background: "var(--color-white)", color: "var(--text-secondary)", border: "1px solid var(--border-primary)", boxShadow: "var(--shadow-xs)" },
  tertiary: { background: "transparent", color: "var(--text-secondary)", border: "1px solid transparent" },
  link: { background: "transparent", color: "var(--brand-700)", border: "none", padding: 0 },
  danger: { background: "var(--error-600)", color: "#fff", border: "1px solid var(--error-600)" },
};
export function Button({
  hierarchy = "secondary", size = "md", iconLeading, iconTrailing, children, style, ...rest
}: {
  hierarchy?: Hier; size?: "sm" | "md" | "lg"; iconLeading?: ReactNode; iconTrailing?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const pad = size === "sm" ? "6px 12px" : size === "lg" ? "10px 18px" : "8px 14px";
  const fs = size === "sm" ? 13 : 14;
  // Minimum touch-target heights: sm → 44px, md → 44px, lg → 44px (link: no min).
  const minH = hierarchy === "link" ? undefined : 44;
  return (
    <button
      {...rest}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
        minHeight: minH,
        padding: hierarchy === "link" ? 0 : pad, fontSize: fs, fontWeight: 600,
        borderRadius: "var(--radius-button)", cursor: rest.disabled ? "not-allowed" : "pointer",
        opacity: rest.disabled ? 0.5 : 1, transition: "background 120ms, border-color 120ms",
        ...BTN[hierarchy], ...style,
      }}
    >
      {iconLeading}
      {children}
      {iconTrailing}
    </button>
  );
}

export function IconButton({ label, active, children, ...rest }: { label: string; active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} aria-label={label} title={label}
      style={{ width: 40, height: 40, display: "inline-flex", alignItems: "center", justifyContent: "center",
        borderRadius: "var(--radius-button)", border: "1px solid transparent", background: active ? "var(--surface-active)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--fg-tertiary)", cursor: "pointer", ...(rest.style || {}) }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--surface-hover)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
      {children}
    </button>
  );
}

/* ---------------- Input / Select ---------------- */
export function Field({ label, hint, error, children }: { label?: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      {label && <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>{label}</div>}
      {children}
      {error ? <div style={{ fontSize: 12, color: "var(--error-600)", marginTop: 6 }}>{error}</div>
        : hint ? <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 6 }}>{hint}</div> : null}
    </label>
  );
}
const inputStyle = (err?: boolean): CSSProperties => ({
  width: "100%", height: 40, padding: "0 12px", fontSize: 14, fontFamily: "var(--font-sans)",
  color: "var(--text-primary)", background: "var(--color-white)",
  border: `1px solid ${err ? "var(--error-300)" : "var(--border-primary)"}`, borderRadius: "var(--radius-input)", outline: "none",
});
export function Input({ error, ...rest }: { error?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} style={{ ...inputStyle(error), ...(rest.style || {}) }} />;
}
export function Select({ options, ...rest }: { options: { value: string; label: string }[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} style={{ ...inputStyle(false), appearance: "auto", ...(rest.style || {}) }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, color: "var(--text-secondary)" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16, accentColor: "var(--brand-600)" }} />
      {label}
    </label>
  );
}

/* ---------------- SegmentedControl ---------------- */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="tablist" style={{ display: "inline-flex", background: "var(--gray-100)", borderRadius: "var(--radius-control)", padding: 2, gap: 2 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} role="tab" aria-selected={on} onClick={() => onChange(o.value)}
            style={{ padding: "5px 12px", fontSize: 13, fontWeight: 600, borderRadius: "var(--radius-tab)", border: "none", cursor: "pointer",
              background: on ? "var(--color-white)" : "transparent", color: on ? "var(--text-primary)" : "var(--text-tertiary)",
              boxShadow: on ? "var(--shadow-xs)" : "none" }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- Snippet (mono + copy) ---------------- */
export function copyText(text: string) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  else fallbackCopy(text);
}
function fallbackCopy(t: string) {
  const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch { /* noop */ } document.body.removeChild(ta);
}
export function Snippet({ value, block }: { value: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCopy = useCallback(() => { copyText(value); setCopied(true); if (t.current) clearTimeout(t.current); t.current = setTimeout(() => setCopied(false), 1600); }, [value]);
  return (
    <div style={{ display: "flex", alignItems: block ? "stretch" : "center", gap: 8, background: "var(--gray-50)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-input)", padding: block ? 0 : "0 4px 0 12px", overflow: "hidden" }}>
      <pre style={{ flex: 1, margin: 0, padding: block ? "14px 16px" : "10px 0", fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.6, color: "var(--gray-900)", overflowX: "auto", whiteSpace: block ? "pre" : "nowrap" }}>{value}</pre>
      <button onClick={onCopy} aria-label="Copy" title="Copy"
        style={{ alignSelf: block ? "flex-start" : "center", margin: block ? 10 : 0, minWidth: 44, minHeight: 36, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, background: "var(--color-white)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-badge)", color: copied ? "var(--brand-700)" : "var(--text-tertiary)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "0 10px" }}>
        {copied ? <Check size={14} color="var(--brand-600)" /> : <Copy size={14} />}{copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/* ---------------- Tooltip (500ms) ---------------- */
export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => { t.current = setTimeout(() => setShow(true), 500); }}
      onMouseLeave={() => { if (t.current) clearTimeout(t.current); setShow(false); }}
      onFocus={() => setShow(true)} onBlur={() => setShow(false)}>
      {children}
      {show && (
        <span role="tooltip" style={{ position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)", background: "var(--gray-900)", color: "#fff", fontSize: 12, lineHeight: "16px", padding: "6px 10px", borderRadius: "var(--radius-tooltip)", whiteSpace: "nowrap", zIndex: 80, pointerEvents: "none", boxShadow: "var(--shadow-lg)" }}>{content}</span>
      )}
    </span>
  );
}

/* ---------------- Overlay / Modal / Drawer ---------------- */
function useEsc(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}
export function Modal({ title, onClose, children, width = 920 }: { title?: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEsc(onClose);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--surface-overlay)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "48px 24px", zIndex: 60, overflow: "auto" }} className="eh-scroll">
      <div onClick={(e) => e.stopPropagation()} className="eh-fadein" style={{ width: "min(100%," + width + "px)", maxWidth: width, background: "var(--color-white)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-modal)", boxShadow: "var(--shadow-2xl)", overflow: "hidden" }}>
        {title && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--border-secondary)" }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
            <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
/**
 * Drawer — right-side slide-in panel with optional sticky header/footer.
 *
 * Slots:
 *   title       — convenience: renders a standard "Title + X" header row.
 *   header      — fully custom header node (overrides `title` slot).
 *   children    — scrollable body content.
 *   footer      — sticky footer slot (save/cancel buttons, delete actions, etc.).
 *   width       — panel width in px (default 460).
 *
 * Behaviour: Escape → close, overlay click → close, stopPropagation on panel.
 * Existing callers using only `title` + `children` continue to work unchanged.
 */
export function Drawer({
  title, header, footer, onClose, children, width = 460,
}: {
  title?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  useEsc(onClose);
  return (
    <div
      onClick={onClose}
      className="eh-task-scrim"
      style={{
        position: "fixed", inset: 0, background: "var(--overlay-scrim)",
        zIndex: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="eh-fadein"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0,
          width, maxWidth: "95vw",
          background: "var(--color-white)",
          borderLeft: "1px solid var(--border-secondary)",
          boxShadow: "var(--shadow-2xl)",
          display: "flex", flexDirection: "column",
          zIndex: 61,
        }}
      >
        {/* Custom header takes priority; fall back to title shorthand */}
        {header ?? (title ? (
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "12px 16px 12px 20px",
            borderBottom: "1px solid var(--border-secondary)", flexShrink: 0,
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, flex: 1 }}>{title}</div>
            <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
          </div>
        ) : null)}

        {/* Scrollable body */}
        <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {children}
        </div>

        {/* Sticky footer */}
        {footer && (
          <div style={{
            flexShrink: 0, borderTop: "1px solid var(--border-secondary)",
            background: "var(--color-white)",
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- Sparkline ---------------- */
export function Sparkline({ data, w = 96, h = 34, color = "var(--brand-500)", muted }: { data: number[]; w?: number; h?: number; color?: string; muted?: boolean }) {
  if (!data.length) return null;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((d, i) => `${(i / (data.length - 1)) * w},${h - 4 - ((d - min) / span) * (h - 8)}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }} aria-hidden="true">
      <polyline points={pts} fill="none" stroke={muted ? "var(--gray-300)" : color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ---------------- EmptyState (physics anchor) ---------------- */
export function EmptyState({ line, button }: { line: string; button?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "64px 24px", textAlign: "center", height: "100%" }}>
      <div style={{ opacity: 0.14, filter: "grayscale(0.4)" }}><Ket size={104} /></div>
      <div style={{ fontSize: 15, color: "var(--text-tertiary)" }}>{line}</div>
      {button}
    </div>
  );
}

/* ---------------- ErrorBanner ---------------- */
/*
 * Design-brief error standard:
 * "[Компонент]: [процесс] остановлен. [Причина]. [Следующее действие]."
 *
 * Props:
 *   component  — "PostHog adapter" / "Sync" / "Logic editor" / etc.
 *   process    — short phrase: "сборка отчёта остановлена" / "ключ отклонён"
 *   detail     — plain-language cause (no technical codes as first line)
 *   code       — optional HTTP status / error code, shown after detail
 *   action     — optional ReactNode with a CTA button or link
 *   severity   — "error" (red, default) | "warning" (amber) | "info" (blue)
 */
type ErrorSeverity = "error" | "warning" | "info";

const ERR_PALETTE: Record<ErrorSeverity, { bg: string; border: string; fg: string; icon: string }> = {
  error:   { bg: "var(--error-50)",   border: "var(--error-300)",   fg: "var(--error-700)",   icon: "var(--error-600)"   },
  warning: { bg: "var(--warning-50)", border: "var(--warning-300)", fg: "var(--warning-700)", icon: "var(--warning-600)" },
  info:    { bg: "var(--blue-50)",    border: "var(--blue-100)",    fg: "var(--blue-700)",    icon: "var(--blue-500)"    },
};

export function ErrorBanner({
  component, process: proc, detail, code, action, severity = "error",
}: {
  component: string;
  process: string;
  detail: string;
  code?: string | number;
  action?: ReactNode;
  severity?: ErrorSeverity;
}) {
  const p = ERR_PALETTE[severity];
  const Icon = severity === "error" ? AlertCircle : severity === "warning" ? AlertTriangle : Info;
  return (
    <div role="alert" style={{ display: "flex", gap: 10, background: p.bg, border: `1px solid ${p.border}`, borderRadius: "var(--radius-md)", padding: "12px 14px" }}>
      <Icon size={16} color={p.icon} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: p.fg, lineHeight: 1.4 }}>
          {component}: {proc}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, lineHeight: 1.5 }}>
          {detail}{code !== undefined ? <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-quaternary)", marginLeft: 4 }}>({code})</span> : null}
        </div>
        {action && <div style={{ marginTop: 10 }}>{action}</div>}
      </div>
    </div>
  );
}

/* ---------------- CoachMark anchor helpers ---------------- */
/*
 * CoachMark positioning uses getBoundingClientRect() against a data-coach-anchor
 * attribute so positions survive window resize (no hardcoded pixel offsets).
 * The hook returns a live {top, left, bottom, right} or null.
 */
export function useCoachAnchor(anchorAttr: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    const measure = () => {
      const el = document.querySelector(`[data-coach-anchor="${anchorAttr}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [anchorAttr]);
  return rect;
}
