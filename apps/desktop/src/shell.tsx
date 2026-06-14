import { useEffect, useRef } from "react";
import { ChartLine, Settings as SettingsIcon, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRight, Activity, FunctionSquare, RefreshCw, Copy, ListChecks, Target as TargetIcon, FlaskConical, BookMarked, Network, ListOrdered, MessageCircle } from "lucide-react";
import { useApp } from "./store";
import { Ket, IconButton, Tooltip, Button, copyText } from "./ui";
import { EventsTab, LogicTab, SyncsTab, TasksFacetsTab } from "./panel";

/* ---------------- Left rail ---------------- */
export function LeftRail() {
  const { railCollapsed, toggleRail, view, goReports, goSettings, goTasks, goGoals, goHypotheses, goDecisions, goGraph, goRice, openChat, chatOpen } = useApp();
  const w = railCollapsed ? 56 : 208;

  const navItem = (active: boolean, icon: React.ReactNode, label: string, onClick: () => void) => {
    const body = (
      <button onClick={onClick} aria-current={active} aria-label={label} style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10, minHeight: 44,
        padding: railCollapsed ? 0 : "0 12px", justifyContent: railCollapsed ? "center" : "flex-start",
        borderRadius: 8, border: "1px solid transparent", cursor: "pointer",
        background: active ? "var(--surface-active)" : "transparent",
        color: active ? "var(--text-primary)" : "var(--text-tertiary)",
        fontSize: 14, fontWeight: 600,
      }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--surface-hover)"; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
        <span style={{ display: "flex" }}>{icon}</span>
        {!railCollapsed && <span style={{ flex: 1, textAlign: "left" }}>{label}</span>}
      </button>
    );
    return railCollapsed ? <Tooltip content={label}>{body}</Tooltip> : body;
  };

  return (
    <div style={{ width: w, flexShrink: 0, borderRight: "1px solid var(--border-secondary)", background: "var(--surface-secondary)", display: "flex", flexDirection: "column", transition: "width 140ms ease" }}>
      {/* Header: logo + (when expanded) the collapse arrow to its right */}
      <div style={{ height: 56, display: "flex", alignItems: "center", gap: 9, padding: railCollapsed ? 0 : "0 8px 0 14px", justifyContent: railCollapsed ? "center" : "flex-start" }}>
        <Ket size={22} />
        {!railCollapsed && <span style={{ fontWeight: 600, fontSize: 16, letterSpacing: "-0.01em", flex: 1 }}>eigenheim</span>}
        {!railCollapsed && (
          <Tooltip content="Collapse rail · ⌘B">
            <IconButton label="Collapse rail" onClick={toggleRail}><PanelLeftClose size={18} /></IconButton>
          </Tooltip>
        )}
      </div>
      <div style={{ padding: railCollapsed ? "6px 10px" : "6px 12px", display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
        {navItem(view === "reports" || view === "report", <ChartLine size={18} />, "Reports", goReports)}
        {navItem(chatOpen, <MessageCircle size={18} />, "Chat", openChat)}
        {navItem(view === "tasks", <ListChecks size={18} />, "Tasks", goTasks)}
        {navItem(view === "goals", <TargetIcon size={18} />, "Goals", goGoals)}
        {navItem(view === "rice", <ListOrdered size={18} />, "Prioritization", goRice)}
        {navItem(view === "hypotheses", <FlaskConical size={18} />, "Hypotheses", goHypotheses)}
        {navItem(view === "decisions", <BookMarked size={18} />, "Decisions", goDecisions)}
        {navItem(view === "graph", <Network size={18} />, "Graph", goGraph)}
      </div>
      <div style={{ padding: railCollapsed ? "6px 10px 10px" : "6px 12px 12px", display: "flex", flexDirection: "column", gap: 4, borderTop: "1px solid var(--border-tertiary)" }}>
        {navItem(view === "settings", <SettingsIcon size={18} />, "Settings", goSettings)}
        {/* Expand arrow lives here only while collapsed (no header room); collapse lives in the header */}
        {railCollapsed && (
          <Tooltip content="Expand rail · ⌘B">
            <IconButton label="Expand rail" onClick={toggleRail} style={{ alignSelf: "center" }}><PanelLeftOpen size={18} /></IconButton>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/* ---------------- Right data panel ---------------- */
const DATA_TABS = [
  { id: "events", label: "Events", icon: Activity },
  { id: "logic", label: "Logic", icon: FunctionSquare },
  { id: "syncs", label: "Syncs", icon: RefreshCw },
] as const;

import { LayoutList } from "lucide-react";

export function RightPanel() {
  const { rightOpen, toggleRight, rightTab, setRightTab, rightWidth, setRightWidth, view } = useApp();
  const dragging = useRef(false);
  const inTasksMode = view === "tasks";

  useEffect(() => {
    const move = (e: MouseEvent) => { if (dragging.current) setRightWidth(window.innerWidth - e.clientX); };
    const up = () => { dragging.current = false; document.body.style.cursor = ""; };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [setRightWidth]);

  // When leaving tasks mode, fall back to events if the tab is tasks
  useEffect(() => {
    if (!inTasksMode && rightTab === "tasks") setRightTab("events");
  }, [inTasksMode, rightTab, setRightTab]);

  if (!rightOpen) {
    return (
      <Tooltip content="Open panel · ⌘⇧B">
        <button onClick={toggleRight} aria-label="Open panel"
          style={{ width: 28, flexShrink: 0, borderLeft: "1px solid var(--border-secondary)", background: "var(--surface-secondary)", color: "var(--fg-tertiary)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <PanelRight size={16} />
        </button>
      </Tooltip>
    );
  }

  const tabs = inTasksMode
    ? [{ id: "tasks" as const, label: "Tasks", icon: LayoutList }, ...DATA_TABS]
    : DATA_TABS;

  return (
    <div style={{ width: rightWidth, flexShrink: 0, position: "relative", borderLeft: "1px solid var(--border-secondary)", background: "var(--color-white)", display: "flex", flexDirection: "column" }}>
      <div onMouseDown={() => { dragging.current = true; document.body.style.cursor = "col-resize"; }}
        title="Drag to resize" aria-hidden
        style={{ position: "absolute", left: -2, top: 0, bottom: 0, width: 4, cursor: "col-resize", zIndex: 2 }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--brand-300)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")} />
      <div style={{ height: 56, display: "flex", alignItems: "center", padding: "0 8px", borderBottom: "1px solid var(--border-secondary)", gap: 4, overflowX: "auto" }}>
        {/* Collapse arrow sits to the LEFT of the tab icons */}
        <Tooltip content="Hide panel · ⌘⇧B"><IconButton label="Hide panel" onClick={toggleRight}><PanelRightClose size={17} /></IconButton></Tooltip>
        <span style={{ width: 1, height: 20, background: "var(--border-secondary)", flexShrink: 0, margin: "0 2px" }} aria-hidden />
        {tabs.map((t) => {
          const on = rightTab === t.id;
          const Icon = t.icon;
          return (
            <Tooltip key={t.id} content={t.label}>
              <button role="tab" aria-selected={on} aria-label={t.label} onClick={() => setRightTab(t.id)}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 32, borderRadius: 7, border: "none", cursor: "pointer", flexShrink: 0, background: on ? "var(--surface-active)" : "transparent", color: on ? "var(--text-primary)" : "var(--text-tertiary)" }}>
                <Icon size={16} />
              </button>
            </Tooltip>
          );
        })}
      </div>
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {rightTab === "tasks" && inTasksMode && <TasksFacetsTab />}
        {rightTab === "events" && <EventsTab />}
        {rightTab === "logic" && <LogicTab />}
        {rightTab === "syncs" && <SyncsTab />}
      </div>
    </div>
  );
}

/* ---------------- Boot / failure system states ---------------- */
function Waveform() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, height: 36 }} aria-hidden>
      {Array.from({ length: 9 }).map((_, i) => (
        <span key={i} style={{ width: 4, height: 28, borderRadius: 2, background: "var(--brand-400)", transformOrigin: "center", animation: `eh-wave 1.1s ease-in-out ${i * 0.09}s infinite` }} />
      ))}
    </div>
  );
}
export function BootState() {
  return (
    <div role="status" aria-label="Engine starting" style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <Waveform />
      <div style={{ fontSize: 15, color: "var(--text-tertiary)" }}>Engine starting…</div>
    </div>
  );
}
export function EngineFailure() {
  const restart = useApp((s) => s.restartEngine);
  const diag = "Engine: start stopped. The sidecar did not respond within 10s (timeout). Restart it below, or quit and reopen eigenheim.";
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div role="alert" style={{ maxWidth: 520, width: "100%", border: "1px solid var(--error-300)", background: "var(--error-50)", borderRadius: 12, padding: 24 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--error-700)" }}>Engine: start stopped</div>
        <div style={{ fontSize: 14, color: "var(--text-secondary)", marginTop: 8, lineHeight: 1.55 }}>
          Sidecar timeout after 10s. Restart below, or quit and reopen eigenheim.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <Button hierarchy="primary" iconLeading={<RefreshCw size={15} />} onClick={restart}>Restart</Button>
          <Button hierarchy="secondary" iconLeading={<Copy size={15} />} onClick={() => copyText(diag)}>Copy diagnostics</Button>
        </div>
      </div>
    </div>
  );
}

