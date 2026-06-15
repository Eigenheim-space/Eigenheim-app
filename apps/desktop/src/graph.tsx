/**
 * graph.tsx — Graph Explorer center mode.
 *
 * Renders the graphify knowledge graph built over the user's own product corpus.
 * Confidence tiers (EXTRACTED / INFERRED / AMBIGUOUS) are a first-class visual
 * language: carried by line style + opacity, never color alone.
 *
 * LIGHT tokens only. Canvas: white surface. Selection: brand green #099250 (+ halo).
 * No dark canvas, no neon nodes, no force-physics shimmy on load,
 * no LLM calls from the renderer.
 *
 * Layout: Canvas + right detail panel (Node / Cluster / Surprising tabs).
 * List view is the keyboard-accessible AA alternative.
 *
 * Engine calls: POST /graph/build, GET /graph/{run_id}/json — all Bearer-guarded.
 * This file fires no LLM.
 */

import {
  useState, useCallback, useRef, useMemo, useEffect,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Network, RefreshCw, GitBranch, AlertCircle, Loader2,
  Info, Search, ChevronDown, Plus, Minus, Maximize2, Play, X,
  Filter,
} from "lucide-react";
import { useApp } from "./store";
import { graphApi, type GraphData, type GraphNode, type GraphEdge } from "./api";
import { queryKeys, graphJsonQueryFn } from "./queries";
import { Button } from "./ui";

// ── Types ─────────────────────────────────────────────────────────────────────

type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
type DetailTab = "node" | "cluster" | "surprising";
type ViewMode = "canvas" | "list";

// ── Constants ─────────────────────────────────────────────────────────────────

// Canvas 2D API cannot resolve CSS custom properties — keep as literal hex.
// All DOM usages use `var(--brand-600)` instead.
const BRAND_GREEN_CANVAS = "#099250";

// Cluster palette — 8 AA-safe categorical hues, muted, no purple/pink.
// Colors match the mock: Activation = blue, Retention = orange, Billing = teal, Reporting = indigo
const CLUSTER_SWATCHES = [
  "#2e90fa",  // blue (Activation)
  "#f04438",  // red-orange (Retention)
  "#15b8a6",  // teal (Billing)
  "#6172f3",  // indigo (Reporting)
  "#f59e0b",  // amber
  "#17b26a",  // green
  "#f97316",  // orange
  "#667085",  // slate (last resort, non-purple per stop-criteria)
];

// Hull fill colors (very translucent, muted)
const CLUSTER_HULL_FILLS = [
  "#dbeafe88",  // blue-100 translucent
  "#fde8d888",  // orange/peach translucent (matches mock's salmon for Retention)
  "#ccfbf188",  // teal-100 translucent
  "#e0e7ff88",  // indigo-100 translucent
  "#fef3c788",  // amber-100 translucent
  "#d1fae588",  // green-100 translucent
  "#fff7ed88",  // orange-50 translucent
  "#f2f4f788",  // slate-100 translucent
];

// Named communities for the Cluster tab (mock shows "Activation", "Retention", "Billing", "Reporting")
// In a real build, community labels come from the engine. We use the community index as a key.

// ── Confidence helpers ─────────────────────────────────────────────────────────

/** SVG line sample for confidence — mirrors the mock exactly (30×8 SVG). */
function ConfidenceLineSample({ conf, width = 30 }: { conf: Confidence; width?: number }) {
  const baseStroke = "var(--gray-900)";
  if (conf === "EXTRACTED") {
    return (
      <svg width={width} height={8} style={{ flexShrink: 0 }} aria-hidden>
        <line x1="1" y1="4" x2={width - 1} y2="4"
          stroke={baseStroke} strokeWidth="1.6" strokeOpacity="0.72" />
      </svg>
    );
  }
  if (conf === "INFERRED") {
    return (
      <svg width={width} height={8} style={{ flexShrink: 0 }} aria-hidden>
        <line x1="1" y1="4" x2={width - 1} y2="4"
          stroke={baseStroke} strokeWidth="1.6" strokeDasharray="5 4" strokeOpacity="0.52" />
      </svg>
    );
  }
  // AMBIGUOUS — dotted 1px
  return (
    <svg width={width} height={8} style={{ flexShrink: 0 }} aria-hidden>
      <line x1="1" y1="4" x2={width - 1} y2="4"
        stroke={baseStroke} strokeWidth="1.2" strokeDasharray="1.5 4"
        strokeLinecap="round" strokeOpacity="0.4" />
    </svg>
  );
}

/** Compact confidence chip: SVG line sample + mono label, used in edge rows. */
function ConfidenceChip({ conf }: { conf: Confidence }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      flexShrink: 0, width: 108,
    }}>
      <ConfidenceLineSample conf={conf} width={22} />
      <span style={{
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        fontWeight: 600,
        color: "var(--text-tertiary)",
        letterSpacing: "0.2px",
        whiteSpace: "nowrap",
      }}>
        {conf}
      </span>
    </span>
  );
}

// ── Persistent confidence legend ───────────────────────────────────────────────

function ConfidenceLegend() {
  const tiers: Confidence[] = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];
  return (
    <div
      style={{
        position: "absolute", top: 14, left: 14, zIndex: 10,
        background: "var(--surface-primary)",
        border: "1px solid var(--border-secondary)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-xs)",
        padding: "11px 13px",
        display: "flex", flexDirection: "column", gap: 8,
        pointerEvents: "none",
        minWidth: 168,
      }}
      aria-label="Confidence legend"
    >
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: "0.6px",
        color: "var(--text-quaternary)", textTransform: "uppercase",
      }}>
        Confidence
      </span>
      {tiers.map((t) => (
        <div key={t} style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <ConfidenceLineSample conf={t} width={30} />
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11, fontWeight: 600,
            color: "var(--text-secondary)",
          }}>
            {t}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Zoom controls (bottom-right of canvas) ────────────────────────────────────

function ZoomControls({ onZoomIn, onZoomOut, onFit }: {
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFit?: () => void;
}) {
  const btnStyle: React.CSSProperties = {
    width: 40, height: 40,
    display: "flex", alignItems: "center", justifyContent: "center",
    background: "var(--surface-primary)",
    border: "1px solid var(--border-primary)",
    borderRadius: "var(--radius-md)",
    boxShadow: "var(--shadow-xs)",
    cursor: "pointer",
    color: "var(--fg-secondary)",
  };
  return (
    <div style={{
      position: "absolute", bottom: 14, right: 14, zIndex: 10,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <button aria-label="Zoom in" onClick={onZoomIn} style={btnStyle}>
        <Plus size={18} strokeWidth={2} />
      </button>
      <button aria-label="Zoom out" onClick={onZoomOut} style={btnStyle}>
        <Minus size={18} strokeWidth={2} />
      </button>
      <button aria-label="Fit to view" onClick={onFit} style={{ ...btnStyle, marginTop: 4 }}>
        <Maximize2 size={16} strokeWidth={2} />
      </button>
    </div>
  );
}

// ── Gated build flow ──────────────────────────────────────────────────────────

function BuildFlow({ onBuilt }: { onBuilt: (runId: string) => void }) {
  const [path, setPath] = useState("");
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBuild = useCallback(async (infer: boolean) => {
    if (!path.trim()) {
      setError("Enter a directory path to build the graph from.");
      return;
    }
    setBuilding(true);
    setError(null);
    try {
      const result = await graphApi.build(path.trim(), infer);
      onBuilt(result.run_id);
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      // Detect the "graphify not installed" case and surface it directly.
      if (raw.toLowerCase().includes("graphify is not installed") || raw.toLowerCase().includes("not installed")) {
        setError(
          "Graph: build stopped. graphify is not installed on this machine. " +
          "Install it with: uv tool install graphify"
        );
      } else {
        setError(`Graph: build stopped. ${raw}. Check the path and try again.`);
      }
    } finally {
      setBuilding(false);
    }
  }, [path, onBuilt]);

  return (
    <div style={{
      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 40, overflowY: "auto",
    }}>
      <div style={{ maxWidth: 700, width: "100%", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
        {/* Icon */}
        <div style={{
          width: 52, height: 52,
          borderRadius: "var(--radius-xl)",
          background: "var(--brand-50)",
          border: "1px solid var(--brand-100)",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "var(--brand-600)",
        }}>
          <Network size={26} strokeWidth={2} />
        </div>

        <h2 style={{ margin: "18px 0 8px", fontSize: 22, fontWeight: 600, letterSpacing: "-0.4px", color: "var(--text-primary)" }}>
          Build a graph from your specs and metrics
        </h2>
        <p style={{ margin: "0 0 24px", fontSize: 14, lineHeight: "21px", color: "var(--text-tertiary)", maxWidth: 560, textWrap: "pretty" as React.CSSProperties["textWrap"] }}>
          graphify reads this project's corpus — specs, PRDs and the metric definitions eigenheim already holds — and maps the connections between them.
          Nothing leaves this machine unless you choose to analyse with AI.
        </p>

        {/* Path input */}
        <div style={{ width: "100%", marginBottom: 20, textAlign: "left" }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 6 }}>
            Directory path
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/specs"
              disabled={building}
              style={{
                flex: 1, boxSizing: "border-box",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-input)",
                padding: "8px 12px", fontSize: 13,
                fontFamily: "var(--font-mono)",
                color: "var(--text-primary)",
                background: "var(--surface-primary)",
                outline: "none",
                boxShadow: "var(--shadow-xs)",
              }}
            />
            {typeof window !== "undefined" && window.eigenheim?.chooseDirectory && (
              <button
                type="button"
                disabled={building}
                onClick={async () => {
                  const chosen = await window.eigenheim!.chooseDirectory!();
                  if (chosen) setPath(chosen);
                }}
                style={{
                  padding: "8px 14px", fontSize: 13, fontWeight: 500,
                  border: "1px solid var(--border-primary)",
                  borderRadius: "var(--radius-input)",
                  background: "var(--surface-primary)",
                  color: "var(--text-secondary)",
                  cursor: building ? "not-allowed" : "pointer",
                  whiteSpace: "nowrap",
                  boxShadow: "var(--shadow-xs)",
                }}
                onMouseEnter={(e) => { if (!building) e.currentTarget.style.background = "var(--gray-50)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--surface-primary)"; }}
              >
                Browse…
              </button>
            )}
          </div>
        </div>

        {error && (
          <div style={{
            width: "100%", textAlign: "left",
            background: "var(--error-50)", border: "1px solid var(--error-100)",
            borderRadius: "var(--radius-md)", padding: "10px 14px", marginBottom: 16,
            display: "flex", gap: 8, alignItems: "flex-start",
          }}>
            <AlertCircle size={16} color="var(--error-600)" style={{ flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 13, color: "var(--error-700)" }}>{error}</span>
          </div>
        )}

        {/* Two-column build option cards */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, width: "100%", textAlign: "left" }}>
          {/* Local only (recommended) */}
          <div style={{
            border: "1.5px solid var(--brand-300)",
            background: "var(--brand-25)",
            borderRadius: "var(--radius-2xl)",
            padding: 20,
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 38, height: 38,
                borderRadius: "var(--radius-md)",
                background: "var(--brand-600)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff",
              }}>
                <GitBranch size={19} strokeWidth={2} />
              </div>
              <span style={{
                fontSize: 11, fontWeight: 600, color: "var(--brand-700)",
                background: "var(--brand-100)", borderRadius: "var(--radius-full)",
                padding: "2px 9px",
              }}>
                Recommended
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Build (local only)</span>
              <span style={{ fontSize: 13, lineHeight: "19px", color: "var(--text-tertiary)", textWrap: "pretty" as React.CSSProperties["textWrap"] }}>
                Extracts edges stated verbatim in your text. Zero egress — nothing leaves this machine.
              </span>
            </div>
            <Button
              hierarchy="primary"
              disabled={building}
              onClick={() => handleBuild(false)}
              style={{ alignSelf: "flex-start" }}
            >
              {building
                ? <Loader2 size={15} style={{ animation: "eh-spin 0.8s linear infinite" }} />
                : <Play size={15} fill="currentColor" strokeWidth={0} />
              }
              Build graph
            </Button>
          </div>

          {/* Analyse with AI */}
          <div style={{
            border: "1px solid var(--border-secondary)",
            background: "var(--surface-primary)",
            borderRadius: "var(--radius-2xl)",
            padding: 20,
            display: "flex", flexDirection: "column", gap: 12,
          }}>
            <div style={{
              width: 38, height: 38,
              borderRadius: "var(--radius-md)",
              background: "var(--gray-100)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "var(--fg-secondary)",
            }}>
              <Network size={19} strokeWidth={2} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Analyse with AI</span>
              <span style={{ fontSize: 13, lineHeight: "19px", color: "var(--text-tertiary)", textWrap: "pretty" as React.CSSProperties["textWrap"] }}>
                Adds inferred connections that text alone can't prove.
              </span>
            </div>
            {/* Egress warning */}
            <div style={{
              display: "flex", gap: 8, padding: "10px 12px",
              background: "var(--warning-50)", border: "1px solid var(--warning-300)",
              borderRadius: "var(--radius-md)",
            }}>
              <AlertCircle size={15} color="var(--warning-600)" style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: 12, lineHeight: "17px", color: "var(--warning-700)", textWrap: "pretty" as React.CSSProperties["textWrap"] }}>
                eigenheim sends document text to your configured LLM to infer connections. This is the only step that leaves your machine.
              </span>
            </div>
            <Button
              hierarchy="secondary"
              disabled={building}
              onClick={() => handleBuild(true)}
              style={{ alignSelf: "flex-start" }}
            >
              Analyse with AI
            </Button>
          </div>
        </div>

        <span style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 18 }}>
          The Graph rail item unlocks once a graph.json exists for this project.
        </span>
      </div>
    </div>
  );
}

// ── Confidence filter state ────────────────────────────────────────────────────

interface ConfFilter { EXTRACTED: boolean; INFERRED: boolean; AMBIGUOUS: boolean }

// ── List view (AA accessible alternative) ─────────────────────────────────────

function ListView({ data, selectedId, onSelect }: {
  data: GraphData;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="eh-scroll" style={{ overflowY: "auto", height: "100%" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ position: "sticky", top: 0, zIndex: 5 }}>
            {["Node", "Type", "Connected to", "Relation", "Confidence"].map((h) => (
              <th key={h} style={{
                textAlign: "left", padding: "8px 12px",
                fontWeight: 500, fontSize: 12, color: "var(--text-secondary)",
                borderBottom: "1px solid var(--border-secondary)",
                background: "var(--surface-secondary)",
                whiteSpace: "nowrap",
              }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.edges.map((e, i) => {
            const srcNode = data.nodes.find((n) => n.id === e.source);
            const tgtNode = data.nodes.find((n) => n.id === e.target);
            const isSelected = selectedId === e.source || selectedId === e.target;
            return (
              <tr
                key={i}
                onClick={() => onSelect(e.source)}
                tabIndex={0}
                onKeyDown={(ev) => ev.key === "Enter" && onSelect(e.source)}
                style={{
                  cursor: "pointer",
                  background: isSelected ? "var(--brand-50)" : undefined,
                  borderBottom: "1px solid var(--border-tertiary)",
                }}
              >
                <td style={{ padding: "7px 12px", color: "var(--text-primary)", fontWeight: isSelected ? 500 : undefined }}>
                  {srcNode?.label ?? e.source}
                </td>
                <td style={{ padding: "7px 12px", color: "var(--text-secondary)" }}>
                  {srcNode?.type ?? "—"}
                </td>
                <td style={{ padding: "7px 12px", color: "var(--text-primary)" }}>
                  {tgtNode?.label ?? e.target}
                </td>
                <td style={{ padding: "7px 12px", color: "var(--text-secondary)" }}>
                  {e.relation}
                </td>
                <td style={{ padding: "7px 12px" }}>
                  <ConfidenceChip conf={e.confidence as Confidence} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function NodeDetail({ node, data, onOpenTrace }: {
  node: GraphNode;
  data: GraphData;
  onOpenTrace?: () => void;
}) {
  const incidentEdges = data.edges.filter(
    (e) => e.source === node.id || e.target === node.id
  );
  const top5 = incidentEdges.slice(0, 5);
  const isMetric = node.type === "metric" || node.value != null;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Label + type badge */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.2px", color: "var(--text-primary)" }}>
            {node.label}
          </span>
          {node.type && (
            <span style={{
              fontSize: 11, fontWeight: 600,
              color: isMetric ? "var(--brand-700)" : "var(--text-secondary)",
              background: isMetric ? "var(--brand-50)" : "var(--gray-100)",
              border: isMetric ? "1px solid var(--brand-200)" : "1px solid var(--border-secondary)",
              borderRadius: "var(--radius-full)", padding: "2px 9px",
            }}>
              {node.type}
            </span>
          )}
        </div>
      </div>

      {/* Source file path */}
      {node.source_file && (
        <div style={{
          display: "flex", alignItems: "center", gap: 7,
          padding: "8px 10px",
          background: "var(--gray-50)", border: "1px solid var(--border-secondary)",
          borderRadius: "var(--radius-md)",
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-quaternary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />
          </svg>
          <span
            title={node.source_file}
            onClick={() => navigator.clipboard.writeText(node.source_file!)}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12, color: "var(--text-secondary)",
              overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", flex: 1,
              direction: "rtl", textAlign: "left", unicodeBidi: "plaintext",
              cursor: "pointer",
            }}
          >
            {node.source_file.length > 48
              ? "…" + node.source_file.slice(-48)
              : node.source_file}
          </span>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fg-quaternary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </div>
      )}

      {/* Metric card — only when type === "metric" or value present */}
      {isMetric && node.value != null && (
        <div style={{
          border: "1px solid var(--border-secondary)",
          borderRadius: "var(--radius-2xl)",
          boxShadow: "var(--shadow-xs)",
          padding: 14,
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{
              fontSize: 27, fontWeight: 600, letterSpacing: "-0.5px",
              fontVariantNumeric: "tabular-nums", color: "var(--text-primary)",
            }}>
              {node.value.toLocaleString()}
            </span>
          </div>
          <div style={{ borderTop: "1px solid var(--border-tertiary)", paddingTop: 10 }}>
            {node.trace_ref ? (
              <button
                onClick={onOpenTrace}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  fontSize: 13, fontWeight: 600, color: "var(--brand-700)",
                  background: "none", border: "none", cursor: "pointer", padding: 0,
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 2v20l2-1.5L8 22l2-1.5L12 22l2-1.5L16 22l2-1.5L20 22V2l-2 1.5L16 2l-2 1.5L12 2l-2 1.5L8 2 6 3.5 4 2z" />
                  <path d="M8 7h8" /><path d="M8 11h8" />
                </svg>
                view trace
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
                </svg>
              </button>
            ) : (
              <span style={{ fontSize: 11, color: "var(--text-quaternary)", fontFamily: "var(--font-mono)" }}>
                no trace ref
              </span>
            )}
          </div>
        </div>
      )}

      {isMetric && node.value != null && incidentEdges.length > 0 && (
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: "18px", color: "var(--text-tertiary)", textWrap: "pretty" as React.CSSProperties["textWrap"] }}>
          This metric is referenced by{" "}
          <strong style={{ fontWeight: 600, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
            {incidentEdges.length} document{incidentEdges.length !== 1 ? "s" : ""}
          </strong>{" "}
          below.
        </p>
      )}

      {/* Top connections */}
      {top5.length > 0 && (
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
              {isMetric ? "Incident links" : "Top connections"}
            </span>
            {!isMetric && (
              <span style={{ fontSize: 11, color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums" }}>
                {top5.length} of {incidentEdges.length}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {top5.map((e, i) => {
              const otherId = e.source === node.id ? e.target : e.source;
              const other = data.nodes.find((n) => n.id === otherId);
              return (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 11,
                  padding: "9px 0",
                  borderTop: "1px solid var(--border-tertiary)",
                }}>
                  <ConfidenceChip conf={e.confidence as Confidence} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                    <span style={{
                      fontSize: 13, fontWeight: 500, color: "var(--text-primary)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {other?.label ?? otherId}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-quaternary)" }}>
                      {e.relation}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {top5.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--text-tertiary)", padding: "8px 0" }}>
          No connections found for this node.
        </div>
      )}
    </div>
  );
}

function ClusterDetail({ data }: { data: GraphData }) {
  const clusters = useMemo(() => {
    const map = new Map<number, GraphNode[]>();
    data.nodes.forEach((n) => {
      const c = n.community ?? 0;
      if (!map.has(c)) map.set(c, []);
      map.get(c)!.push(n);
    });
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [data]);

  // Community display names — use numeric fallback if no name from engine
  const communityNames = ["Activation", "Retention", "Billing", "Reporting", "Growth", "Platform", "Analytics", "Core"];

  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{
        fontSize: 12, fontWeight: 500, color: "var(--text-tertiary)",
        fontVariantNumeric: "tabular-nums", marginBottom: 6,
      }}>
        {clusters.length} communities · {data.nodes.length} nodes
      </span>
      {clusters.map(([cid, nodes], ci) => {
        const swatch = CLUSTER_SWATCHES[ci % CLUSTER_SWATCHES.length];
        const label = communityNames[ci] ?? `Cluster ${cid}`;
        return (
          <div
            key={cid}
            style={{
              display: "flex", alignItems: "center", gap: 11,
              padding: "11px 10px", margin: "0 -10px",
              borderRadius: "var(--radius-md)", cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{
              width: 12, height: 12, borderRadius: 4,
              background: swatch, flexShrink: 0,
            }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: swatch }}>{label}</span>
              <span style={{ fontSize: 11.5, color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums" }}>
                {nodes.length} nodes
              </span>
            </div>
            <Filter size={15} color="var(--fg-quaternary)" style={{ flexShrink: 0 }} />
          </div>
        );
      })}
      <div style={{
        marginTop: 10, padding: "11px 12px",
        background: "var(--gray-25)", border: "1px solid var(--border-tertiary)",
        borderRadius: "var(--radius-md)",
        fontSize: 11.5, lineHeight: "17px", color: "var(--text-tertiary)",
        textWrap: "pretty" as React.CSSProperties["textWrap"],
      }}>
        Click a cluster hull on the canvas to filter to it, with a "show all" reset.
      </div>
    </div>
  );
}

interface SurprisingEdge {
  src: GraphNode;
  tgt: GraphNode;
  edge: GraphEdge;
}

function SurprisingDetail({ data, onSelect }: {
  data: GraphData;
  onSelect: (id: string) => void;
}) {
  const surprising: SurprisingEdge[] = useMemo(() => {
    const nodeMap = new Map(data.nodes.map((n) => [n.id, n]));
    return data.edges
      .filter((e) => e.confidence !== "EXTRACTED")
      .map((e) => ({ src: nodeMap.get(e.source)!, tgt: nodeMap.get(e.target)!, edge: e }))
      .filter((x) => x.src && x.tgt && x.src.community !== x.tgt.community)
      .slice(0, 8);
  }, [data]);

  if (surprising.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
        No surprising cross-community connections detected.
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      {surprising.map((s, i) => (
        <div
          key={i}
          onClick={() => onSelect(s.src.id)}
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && onSelect(s.src.id)}
          style={{
            border: "1px solid var(--border-secondary)",
            borderRadius: "var(--radius-md)",
            padding: "10px 12px",
            cursor: "pointer",
            display: "flex", flexDirection: "column", gap: 4,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-secondary)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
              {s.src.label}
            </span>
            <ConfidenceChip conf={s.edge.confidence as Confidence} />
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {s.edge.relation} → {s.tgt.label}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-quaternary)" }}>
            {s.src.label} and {s.tgt.label} are in different clusters
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailPanel({
  data,
  selectedId,
  tab,
  setTab,
  onSelect,
}: {
  data: GraphData;
  selectedId: string | null;
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  onSelect: (id: string) => void;
}) {
  const selectedNode = selectedId ? data.nodes.find((n) => n.id === selectedId) : null;

  const tabs: { key: DetailTab; label: string }[] = [
    { key: "node", label: "Node" },
    { key: "cluster", label: "Cluster" },
    { key: "surprising", label: "Surprising" },
  ];

  return (
    <div style={{
      width: 300, flexShrink: 0,
      borderLeft: "1px solid var(--border-secondary)",
      background: "var(--surface-primary)",
      display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* Tabs — 44px height, active: border-bottom brand-600, margin-bottom trick */}
      <div style={{
        display: "flex", padding: "0 12px",
        borderBottom: "1px solid var(--border-secondary)",
        flexShrink: 0,
      }}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              onClick={() => setTab(t.key)}
              aria-selected={active}
              style={{
                height: 44, padding: "0 10px",
                display: "flex", alignItems: "center",
                background: "none", border: "none", cursor: "pointer",
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                color: active ? "var(--text-primary)" : "var(--text-tertiary)",
                borderBottom: active ? "2px solid var(--brand-600)" : "2px solid transparent",
                marginBottom: -1,
                flexShrink: 0,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="eh-scroll" style={{ overflowY: "auto", flex: 1 }}>
        {tab === "node" && selectedNode
          ? <NodeDetail node={selectedNode} data={data} />
          : tab === "node"
          ? <div style={{ padding: "24px 16px", color: "var(--text-tertiary)", fontSize: 13 }}>
              Select a node on the canvas to see details.
            </div>
          : null
        }
        {tab === "cluster" && <ClusterDetail data={data} />}
        {tab === "surprising" && <SurprisingDetail data={data} onSelect={onSelect} />}
      </div>
    </div>
  );
}

// ── Canvas view (react-force-graph-2d) ────────────────────────────────────────

function CanvasView({
  data,
  selectedId,
  confFilter,
  onSelect,
  zoomRef,
}: {
  data: GraphData;
  selectedId: string | null;
  confFilter: ConfFilter;
  onSelect: (id: string | null) => void;
  zoomRef?: React.MutableRefObject<{ zoomIn: () => void; zoomOut: () => void; fit: () => void } | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<{ zoom: (k: number, ms: number) => void; zoomToFit: (ms: number) => void } | null>(null);
  const [ForceGraph, setForceGraph] = useState<React.ComponentType<unknown> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  // Expose zoom controls to parent via ref
  useEffect(() => {
    if (!zoomRef) return;
    zoomRef.current = {
      zoomIn: () => fgRef.current?.zoom(1.3, 400),
      zoomOut: () => fgRef.current?.zoom(0.77, 400),
      fit: () => fgRef.current?.zoomToFit(400),
    };
  }, [zoomRef]);

  // Lazy-load react-force-graph-2d
  useEffect(() => {
    import("react-force-graph-2d").then((mod) => {
      setForceGraph(() => (mod.default ?? mod) as React.ComponentType<unknown>);
    }).catch((e) => {
      setLoadError(String(e));
    });
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      setDims({ w: rect.width, h: rect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  const filteredEdges = useMemo(
    () => data.edges.filter((e) => confFilter[e.confidence as Confidence]),
    [data.edges, confFilter]
  );

  const nodeMap = useMemo(
    () => new Map(data.nodes.map((n) => [n.id, n])),
    [data.nodes]
  );

  // Build community → index mapping for consistent color assignment
  const communityIndex = useMemo(() => {
    const seen = new Map<number | null, number>();
    let idx = 0;
    data.nodes.forEach((n) => {
      const c = n.community ?? 0;
      if (!seen.has(c)) seen.set(c, idx++);
    });
    return seen;
  }, [data.nodes]);

  const graphData = useMemo(() => ({
    nodes: data.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      community: n.community ?? 0,
      isMetric: n.type === "metric" || n.value != null,
      type: n.type,
    })),
    links: filteredEdges.map((e) => ({
      source: e.source,
      target: e.target,
      confidence: e.confidence,
      relation: e.relation,
    })),
  }), [data.nodes, filteredEdges]);

  const linkColor = useCallback((link: { confidence?: unknown }) => {
    const conf = String(link.confidence ?? "AMBIGUOUS");
    if (conf === "EXTRACTED") return `rgba(17,24,39,0.70)`;
    if (conf === "INFERRED")  return `rgba(17,24,39,0.52)`;
    return `rgba(17,24,39,0.40)`;
  }, []);

  const linkWidth = useCallback((link: { confidence?: unknown }) => {
    const conf = String(link.confidence ?? "AMBIGUOUS");
    return conf === "AMBIGUOUS" ? 1.2 : 1.6;
  }, []);

  // Dashed/dotted lines via canvas painter for INFERRED/AMBIGUOUS
  const linkCanvasObjectMode = useCallback((link: { confidence?: unknown }) => {
    const conf = String(link.confidence ?? "EXTRACTED");
    return conf === "EXTRACTED" ? "replace" : "after";
  }, []);

  const linkCanvasObject = useCallback((
    link: { confidence?: unknown; source?: { x?: number; y?: number }; target?: { x?: number; y?: number } },
    ctx: CanvasRenderingContext2D
  ) => {
    const conf = String(link.confidence ?? "AMBIGUOUS");
    if (conf === "EXTRACTED") return;
    const src = link.source as { x?: number; y?: number } | undefined;
    const tgt = link.target as { x?: number; y?: number } | undefined;
    if (!src?.x || !src?.y || !tgt?.x || !tgt?.y) return;
    ctx.save();
    ctx.beginPath();
    if (conf === "INFERRED") ctx.setLineDash([5, 4]);
    else ctx.setLineDash([1.5, 4]);
    ctx.strokeStyle = linkColor(link);
    ctx.lineWidth = linkWidth(link);
    ctx.lineCap = "round";
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.stroke();
    ctx.restore();
  }, [linkColor, linkWidth]);

  if (loadError) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center", color: "var(--text-secondary)", fontSize: 13 }}>
          <AlertCircle size={24} color="var(--error-500)" style={{ marginBottom: 8 }} />
          <div>Canvas unavailable. Use List view as the accessible alternative.</div>
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
            {loadError}
          </div>
        </div>
      </div>
    );
  }

  if (!ForceGraph) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2 size={20} color="var(--fg-quaternary)" style={{ animation: "eh-spin 0.8s linear infinite" }} />
      </div>
    );
  }

  const FG = ForceGraph as React.ComponentType<{
    ref?: React.Ref<unknown>;
    graphData: typeof graphData;
    width: number; height: number;
    backgroundColor: string;
    nodeLabel: string;
    nodeRelSize: number;
    linkColor: (l: { confidence?: unknown }) => string;
    linkWidth: (l: { confidence?: unknown }) => number;
    linkCanvasObjectMode: (l: { confidence?: unknown }) => string;
    linkCanvasObject: (l: { confidence?: unknown; source?: unknown; target?: unknown }, ctx: CanvasRenderingContext2D) => void;
    onNodeClick: (n: { id?: unknown }) => void;
    cooldownTicks: number;
    d3VelocityDecay: number;
    nodeCanvasObject: (n: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => void;
    nodeCanvasObjectMode: () => string;
  }>;

  const nodeCanvasObject = (
    node: { id?: unknown; label?: unknown; x?: number; y?: number; community?: unknown; isMetric?: boolean; type?: unknown },
    ctx: CanvasRenderingContext2D,
    globalScale: number
  ) => {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const isSelected = String(node.id) === selectedId;
    const eigenNode = nodeMap.get(String(node.id ?? ""));
    const ci = communityIndex.get(eigenNode?.community ?? 0) ?? 0;

    // Radius: metric nodes slightly larger, god nodes (high degree) could be larger
    const degree = filteredEdges.filter((e) => e.source === String(node.id) || e.target === String(node.id)).length;
    const r = degree > 8 ? 7 : degree > 4 ? 5.5 : 4;

    // Halo ring around selected node (brand-200)
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(x, y, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(9,146,80,0.25)"; // brand-200 analog
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Node fill: selected = brand green, others = cluster hull color (solid version)
    const hullFill = CLUSTER_HULL_FILLS[ci % CLUSTER_HULL_FILLS.length];
    const fillColor = isSelected ? BRAND_GREEN_CANVAS : (hullFill ? hullFill.replace("88", "ff") : "#e5e7eb");

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = isSelected ? BRAND_GREEN_CANVAS : "#d0d5dd";
    ctx.lineWidth = isSelected ? 0 : 1;
    ctx.stroke();

    // Metric center dot
    if (node.isMetric || node.type === "metric") {
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "#fff" : BRAND_GREEN_CANVAS;
      ctx.fill();
    }

    // Labels — always show for large nodes, show at high zoom for small nodes
    const label = String(node.label ?? node.id ?? "").slice(0, 22);
    const fontSize = Math.max(11 / globalScale, 8);
    if (globalScale > 0.6 || degree > 6) {
      ctx.font = `${degree > 6 ? 600 : 400} ${fontSize}px Inter, sans-serif`;
      ctx.fillStyle = isSelected ? BRAND_GREEN_CANVAS : "var(--gray-700)";
      ctx.textAlign = "center";
      ctx.fillText(label, x, y + r + fontSize * 1.1);
    }
  };

  return (
    <div ref={containerRef} style={{ flex: 1, position: "relative", overflow: "hidden" }}>
      <FG
        ref={fgRef as React.Ref<unknown>}
        graphData={graphData}
        width={dims.w}
        height={dims.h}
        backgroundColor="#ffffff"
        nodeLabel="label"
        nodeRelSize={5}
        linkColor={linkColor}
        linkWidth={linkWidth}
        linkCanvasObjectMode={linkCanvasObjectMode}
        linkCanvasObject={linkCanvasObject as (l: { confidence?: unknown; source?: unknown; target?: unknown }, ctx: CanvasRenderingContext2D) => void}
        onNodeClick={(n: { id?: unknown }) => onSelect(n.id ? String(n.id) : null)}
        cooldownTicks={prefersReducedMotion ? 0 : 80}
        d3VelocityDecay={prefersReducedMotion ? 1 : 0.4}
        nodeCanvasObject={nodeCanvasObject as (n: unknown, ctx: CanvasRenderingContext2D, gs: number) => void}
        nodeCanvasObjectMode={() => "replace"}
      />
    </div>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function Toolbar({
  viewMode,
  setViewMode,
  confFilter,
  setConfFilter,
  search,
  setSearch,
  data,
  isStale,
  onRebuild,
}: {
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  confFilter: ConfFilter;
  setConfFilter: React.Dispatch<React.SetStateAction<ConfFilter>>;
  search: string;
  setSearch: (v: string) => void;
  data: GraphData;
  isStale: boolean;
  onRebuild: () => void;
}) {
  const builtAt = useMemo(() => {
    if (!data.built_at) return null;
    const d = new Date(data.built_at);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? `Built today, ${timeStr}` : `Built ${d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}`;
  }, [data.built_at]);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "11px 20px",
      borderBottom: "1px solid var(--border-secondary)",
      flexShrink: 0, flexWrap: "wrap",
    }}>
      {/* Canvas / List segmented control */}
      <div style={{
        display: "flex", padding: 3,
        background: "var(--gray-100)",
        borderRadius: "var(--radius-control)",
        gap: 2,
      }} role="group" aria-label="View mode">
        {(["canvas", "list"] as ViewMode[]).map((m) => {
          const active = viewMode === m;
          return (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              aria-pressed={active}
              style={{
                padding: "5px 14px",
                fontSize: 13, fontWeight: active ? 600 : 500,
                color: active ? "var(--text-primary)" : "var(--text-tertiary)",
                background: active ? "var(--surface-primary)" : "transparent",
                border: "none", borderRadius: 6,
                boxShadow: active ? "var(--shadow-xs)" : "none",
                cursor: "pointer",
              }}
            >
              {m === "canvas" ? "Canvas" : "List"}
            </button>
          );
        })}
      </div>

      {/* Stale badge (inline, before search) */}
      {isStale && (
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          fontSize: 11, fontWeight: 600,
          color: "var(--warning-700)",
          background: "var(--warning-50)",
          border: "1px solid var(--warning-300)",
          borderRadius: "var(--radius-full)",
          padding: "3px 10px",
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warning-500)" }} />
          stale
        </span>
      )}

      {/* Search field */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        height: 36, padding: "0 11px", minWidth: 190,
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-input)",
        boxShadow: "var(--shadow-xs)",
        background: "var(--surface-primary)",
      }}>
        <Search size={15} color="var(--fg-quaternary)" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a node"
          style={{
            border: "none", outline: "none", background: "transparent",
            fontSize: 13, color: "var(--text-primary)", width: "100%",
          }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-quaternary)", padding: 0, display: "flex" }}>
            <X size={13} />
          </button>
        )}
      </div>

      {/* All types filter */}
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        height: 36, padding: "0 11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-input)",
        boxShadow: "var(--shadow-xs)",
        fontSize: 13, fontWeight: 500, color: "var(--text-secondary)",
        cursor: "pointer",
        background: "var(--surface-primary)",
        userSelect: "none",
      }}>
        All types <ChevronDown size={14} color="var(--fg-quaternary)" />
      </div>

      {/* Confidence filter */}
      <div style={{
        display: "flex", alignItems: "center", gap: 7,
        height: 36, padding: "0 11px",
        border: "1px solid var(--border-primary)",
        borderRadius: "var(--radius-input)",
        boxShadow: "var(--shadow-xs)",
        fontSize: 13, fontWeight: 500, color: "var(--text-secondary)",
        cursor: "pointer",
        background: "var(--surface-primary)",
        userSelect: "none",
      }}>
        {Object.values(confFilter).every(Boolean)
          ? "Confidence: all"
          : `Confidence: ${(["EXTRACTED", "INFERRED", "AMBIGUOUS"] as Confidence[]).filter((k) => confFilter[k]).join(", ") || "none"}`
        }
        <ChevronDown size={14} color="var(--fg-quaternary)" />
      </div>

      <span style={{ flex: 1 }} />

      {/* Build meta line */}
      <span style={{
        fontSize: 12, color: "var(--text-quaternary)",
        fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
      }}>
        {builtAt} · {data.nodes.length} nodes · {data.edges.length} links
      </span>

      {/* Rebuild button */}
      <Button
        hierarchy="secondary"
        size="sm"
        onClick={onRebuild}
        title="Build a new graph from a different path"
      >
        <RefreshCw size={13} /> Rebuild
      </Button>
    </div>
  );
}

// ── Main GraphView ────────────────────────────────────────────────────────────

export function GraphView() {
  const graphRunId = useApp((s) => s.graphRunId);
  const setGraphRunId = useApp((s) => s.setGraphRunId);
  const graphSelectedNodeId = useApp((s) => s.graphSelectedNodeId);
  const setGraphSelectedNodeId = useApp((s) => s.setGraphSelectedNodeId);
  const graphDetailTab = useApp((s) => s.graphDetailTab);
  const setGraphDetailTab = useApp((s) => s.setGraphDetailTab);
  const graphViewMode = useApp((s) => s.graphViewMode);
  const setGraphViewMode = useApp((s) => s.setGraphViewMode);

  const [search, setSearch] = useState("");
  const [confFilter, setConfFilter] = useState<ConfFilter>({
    EXTRACTED: true, INFERRED: true, AMBIGUOUS: true,
  });

  const zoomRef = useRef<{ zoomIn: () => void; zoomOut: () => void; fit: () => void } | null>(null);

  // Graph data via react-query — only fetches when a runId is available.
  const { data, isLoading: loading, isError, error: queryError } = useQuery({
    queryKey: graphRunId ? queryKeys.graphJson(graphRunId) : ["graph", null],
    queryFn: () => graphJsonQueryFn(graphRunId!),
    enabled: !!graphRunId,
    staleTime: 5 * 60 * 1000, // graph data rarely changes between navigations
  });
  const error = isError
    ? `Graph: load stopped. ${queryError instanceof Error ? queryError.message : String(queryError)}. Try rebuilding.`
    : null;

  const handleBuilt = useCallback((runId: string) => {
    setGraphRunId(runId);
  }, [setGraphRunId]);

  const handleRebuild = useCallback(() => {
    setGraphRunId(null);
  }, [setGraphRunId]);

  // Filter nodes by search
  const filteredData = useMemo((): GraphData | null => {
    if (!data) return null;
    if (!search.trim()) return data;
    const q = search.toLowerCase();
    const matchIds = new Set(data.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id));
    return {
      ...data,
      nodes: data.nodes.filter((n) => matchIds.has(n.id)),
      edges: data.edges.filter((e) => matchIds.has(e.source) && matchIds.has(e.target)),
    };
  }, [data, search]);

  // Stale detection — if built_at exists and we detect source changed.
  // For now the engine sets this; we just check if built_at is more than 7 days ago
  // as a demo heuristic. In production the engine sends a `stale` field.
  const isStale = useMemo(() => {
    if (!data?.built_at) return false;
    const builtMs = new Date(data.built_at).getTime();
    return Date.now() - builtMs > 7 * 24 * 3600 * 1000;
  }, [data?.built_at]);

  // ── No run yet ──
  if (!graphRunId && !loading) {
    return <BuildFlow onBuilt={handleBuilt} />;
  }

  // ── Loading ──
  if (loading && !data) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2 size={24} color="var(--fg-quaternary)" style={{ animation: "eh-spin 0.8s linear infinite" }} />
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
        <div style={{
          maxWidth: 440,
          border: "1px solid var(--error-300)",
          background: "var(--error-50)",
          borderRadius: "var(--radius-lg)",
          padding: 24,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <AlertCircle size={18} color="var(--error-600)" />
            <span style={{ fontSize: 15, fontWeight: 600, color: "var(--error-700)" }}>Graph: load failed</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--error-600)", lineHeight: 1.55 }}>{error}</div>
          <Button hierarchy="secondary" size="sm" style={{ marginTop: 16 }} onClick={handleRebuild}>
            <RefreshCw size={14} /> Build again
          </Button>
        </div>
      </div>
    );
  }

  if (!data || !filteredData) return null;

  // Empty result state
  if (data.nodes.length > 0 && data.edges.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <div style={{
            width: 56, height: 56,
            borderRadius: "var(--radius-2xl)",
            background: "var(--gray-50)", border: "1px solid var(--border-secondary)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--fg-quaternary)", margin: "0 auto 18px",
          }}>
            <Network size={26} />
          </div>
          <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 600 }}>Graph built. No connections found yet</h2>
          <p style={{ margin: "0 0 20px", fontSize: 14, lineHeight: "21px", color: "var(--text-tertiary)", textWrap: "pretty" as React.CSSProperties["textWrap"] }}>
            graphify mapped your nodes but found no links. Add more specs or link metrics to the documents that define them.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <Button hierarchy="secondary" onClick={handleRebuild}>Re-run</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Identity honesty header — non-dismissible, body copy style */}
      <div style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: "9px 20px",
        background: "var(--gray-50)",
        borderBottom: "1px solid var(--border-secondary)",
        flexShrink: 0,
      }}>
        <Info size={15} color="var(--fg-quaternary)" style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 12.5, lineHeight: "18px", color: "var(--text-tertiary)" }}>
          <strong style={{ fontWeight: 600, color: "var(--text-secondary)" }}>A thinking aid.</strong>{" "}
          These connections are suggested, not verified — check the tag on each link.
        </span>
      </div>

      {/* Stale banner (full-width, below header) */}
      {isStale && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "9px 20px",
          background: "var(--warning-50)", borderBottom: "1px solid var(--warning-300)",
          flexShrink: 0,
        }}>
          <AlertCircle size={15} color="var(--warning-600)" style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, color: "var(--warning-700)" }}>
            <strong style={{ fontWeight: 600 }}>
              Graph: built {new Date(data.built_at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}.
            </strong>{" "}
            Source changed since. Re-run to update.
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={handleRebuild}
            style={{
              fontSize: 13, fontWeight: 600, color: "var(--warning-700)",
              background: "none", border: "none", cursor: "pointer", padding: 0,
              fontFamily: "var(--font-sans)",
            }}
          >
            Re-run
          </button>
        </div>
      )}

      {/* Toolbar */}
      <Toolbar
        viewMode={graphViewMode}
        setViewMode={setGraphViewMode}
        confFilter={confFilter}
        setConfFilter={setConfFilter}
        search={search}
        setSearch={setSearch}
        data={data}
        isStale={isStale}
        onRebuild={handleRebuild}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
          {graphViewMode === "canvas" ? (
            <>
              <ConfidenceLegend />
              <CanvasView
                data={filteredData}
                selectedId={graphSelectedNodeId}
                confFilter={confFilter}
                onSelect={setGraphSelectedNodeId}
                zoomRef={zoomRef}
              />
              <ZoomControls
                onZoomIn={() => zoomRef.current?.zoomIn()}
                onZoomOut={() => zoomRef.current?.zoomOut()}
                onFit={() => zoomRef.current?.fit()}
              />
            </>
          ) : (
            <ListView
              data={filteredData}
              selectedId={graphSelectedNodeId}
              onSelect={setGraphSelectedNodeId}
            />
          )}
        </div>

        <DetailPanel
          data={data}
          selectedId={graphSelectedNodeId}
          tab={graphDetailTab}
          setTab={setGraphDetailTab}
          onSelect={setGraphSelectedNodeId}
        />
      </div>
    </div>
  );
}
