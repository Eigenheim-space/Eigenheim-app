import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Plus, Play, Pause, Pencil, ChevronDown, ChevronUp } from "lucide-react";
import { useApp } from "./store";
import { api } from "./api";
import { TEMPLATES } from "./data";
import { Badge, StatusBadge, Button, Field, Input, Drawer, EmptyState, ErrorBanner, IconButton, Tooltip } from "./ui";
import { queryKeys, bootstrapQueryFn, invalidate, taskFacetsQueryFn } from "./queries";

const sectionLabel = { fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" as const, color: "var(--text-quaternary)" };

function PanelHeader({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--border-secondary)" }}>{children}</div>;
}

export function EventsTab() {
  const connected = useApp((s) => s.dataSourceConnected);
  const goSettings = useApp((s) => s.goSettings);
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const events = bootstrap?.events ?? [];
  const [q, setQ] = useState("");

  if (!connected) {
    return (
      <EmptyState
        line="Connect a data source to load the event catalog."
        button={
          <Tooltip content="Open Settings → Data sources and paste your API key">
            <Button hierarchy="primary" size="sm" onClick={goSettings}>Open Settings</Button>
          </Tooltip>
        }
      />
    );
  }

  const rows = events.filter((e) => e.name.includes(q) || e.description.toLowerCase().includes(q.toLowerCase()));

  /* Show empty state when a sync has run but returned no events */
  const catalogEmpty = events.length === 0;

  return (
    <div data-coach-anchor="events-tab" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHeader>
        <div style={{ position: "relative", flex: 1 }}>
          <Search size={15} color="var(--fg-quaternary)" style={{ position: "absolute", left: 10, top: 9 }} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events"
            aria-label="Search events"
            style={{ width: "100%", height: 34, padding: "0 10px 0 32px", fontSize: 13, border: "1px solid var(--border-primary)", borderRadius: 8, outline: "none", background: "var(--color-white)" }} />
        </div>
        <Tooltip content="Create an event manually (without a source sync)">
          <Button hierarchy="secondary" size="sm" iconLeading={<Plus size={15} />}>Event</Button>
        </Tooltip>
      </PanelHeader>
      <div className="eh-scroll" style={{ overflowY: "auto", flex: 1 }}>
        {catalogEmpty ? (
          <EmptyState
            line="Event catalog is empty. Run a sync to load events from your source."
            button={
              <Tooltip content="Open the Syncs tab and trigger a sync">
                <Button hierarchy="secondary" size="sm" onClick={goSettings}>Syncs</Button>
              </Tooltip>
            }
          />
        ) : rows.length === 0 ? (
          <div style={{ padding: 20, fontSize: 13, color: "var(--text-tertiary)" }}>No results for "{q}".</div>
        ) : (
          rows.map((e) => (
            // event name is the natural unique key; the live engine payload has no `id`
            <div key={e.name} tabIndex={0} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-tertiary)", cursor: "default" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Tooltip content={`Event source: ${e.source}`}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)" }}>{e.name}</span>
                </Tooltip>
                <StatusBadge kind={e.origin} />
                <span style={{ flex: 1 }} />
                <Tooltip content="Edit event description"><IconButton label="Edit"><Pencil size={14} /></IconButton></Tooltip>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>{e.description}</div>
              <div style={{ fontSize: 11, color: "var(--text-quaternary)", marginTop: 2 }}>{e.source}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function LogicTab() {
  const setLogicDrawer = useApp((s) => s.setLogicDrawer);
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const logic = bootstrap?.logic ?? [];
  const noLogic = logic.length === 0;
  return (
    <div data-coach-anchor="logic-tab" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHeader>
        <Tooltip content="Formulas are validated once; the metric is always computed from them.">
          <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>Formulas</div>
        </Tooltip>
        <Tooltip content="Create a new Logic formula (input → aggregation → expression)">
          <Button hierarchy="secondary" size="sm" iconLeading={<Plus size={15} />} onClick={() => setLogicDrawer(true)}>Logic</Button>
        </Tooltip>
      </PanelHeader>
      <div className="eh-scroll" style={{ overflowY: "auto", flex: 1 }}>
        {noLogic ? (
          <EmptyState
            line="No formulas yet. Create your first Logic to start computing metrics."
            button={
              <Tooltip content="Logic is a formula with event aggregation. Validated once.">
                <Button hierarchy="primary" size="sm" iconLeading={<Plus size={15} />} onClick={() => setLogicDrawer(true)}>
                  Create Logic
                </Button>
              </Tooltip>
            }
          />
        ) : (
          logic.map((l) => (
            <div key={l.id} tabIndex={0} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-tertiary)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Tooltip content={`Expression: ${l.expression}`}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)" }}>{l.name}</span>
                </Tooltip>
                <span className="tnum" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-quaternary)" }}>{l.version}</span>
                {l.badge && <StatusBadge kind={l.badge} />}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 3 }}>{l.usage > 0 ? `in ${l.usage} report${l.usage !== 1 ? "s" : ""}` : "not used"}</div>
            </div>
          ))
        )}
        {!noLogic && (
          <>
            <div style={{ padding: "14px 16px 8px" }}><span style={sectionLabel}>Library</span></div>
            {TEMPLATES.map((t) => (
              <div key={t.id} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-tertiary)", display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Tooltip content={`Expression: ${t.expression}`}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)" }}>{t.name}</div>
                  </Tooltip>
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 3 }}>{t.description}</div>
                </div>
                <Tooltip content="Use this template as a Logic formula and open in the editor">
                  <Button hierarchy="secondary" size="sm">Use</Button>
                </Tooltip>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export function SyncsTab() {
  const setSyncDrawer = useApp((s) => s.setSyncDrawer);
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const syncs = bootstrap?.syncs ?? [];
  /* Find the most recent failed sync to surface an inline error */
  const failedSync = syncs.find((s) => s.lastStatus === "error");
  return (
    <div data-coach-anchor="syncs-tab" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {failedSync && (
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-tertiary)" }}>
          <ErrorBanner
            component="Sync"
            process={`"${failedSync.target}" sync stopped`}
            detail={failedSync.history[0]?.detail ?? "Unknown error"}
            action={
              <Button hierarchy="tertiary" size="sm" onClick={() => setSyncDrawer(failedSync.id)}>
                View history
              </Button>
            }
          />
        </div>
      )}
      <div className="eh-scroll" style={{ overflowY: "auto", flex: 1 }}>
        {syncs.map((s) => (
          <div key={s.id} tabIndex={0} role="button" onClick={() => setSyncDrawer(s.id)} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-tertiary)", cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", flex: 1 }}>{s.target}</span>
              {s.lastStatus === "error" ? <StatusBadge kind="error" /> : <Badge tone="success" dot>ok</Badge>}
              <Tooltip content="Run sync now">
                <IconButton label="Run sync" onClick={(e) => e.stopPropagation()}><Play size={14} /></IconButton>
              </Tooltip>
              <Tooltip content="Pause (until manually resumed)">
                <IconButton label="Pause" onClick={(e) => e.stopPropagation()}><Pause size={14} /></IconButton>
              </Tooltip>
            </div>
            <div className="tnum" style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4 }}>{s.frequency} · next {s.nextRun}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* drawers (rendered at app level) */
export function LogicDrawer() {
  const open = useApp((s) => s.logicDrawer);
  const [name, setName] = useState("");
  const [event, setEvent] = useState("signup");
  const [expr, setExpr] = useState("n");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => useApp.getState().setLogicDrawer(false);
  if (!open) return null;
  const save = async () => {
    setSaving(true); setError(null);
    try {
      await api.createLogic({ name: name || "new_logic", description: "", fmt: "number",
        inputs: [{ alias: "n", kind: "unique", params: { event } }], expression: expr });
      await invalidate.bootstrap();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  };
  return (
    <Drawer title="New Logic" onClose={close}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="active_users" /></Field>
        <Field label="Event" hint="input with unique-user aggregation — available as n">
          <Input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="signup" />
        </Field>
        <Field label="Expression" hint="arithmetic over input n: ratio/sum/min/max" error={error ?? undefined}>
          <textarea value={expr} onChange={(e) => setExpr(e.target.value)} rows={2}
            style={{ width: "100%", padding: 12, fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.5, color: "var(--gray-900)", border: `1px solid ${error ? "var(--error-300)" : "var(--border-primary)"}`, borderRadius: 8, outline: "none", resize: "vertical" }} />
        </Field>
        <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
          <Button hierarchy="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
          <Button hierarchy="tertiary" onClick={close}>Cancel</Button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-quaternary)", lineHeight: 1.5 }}>
          The formula is validated by the engine (safe AST, no eval). An invalid expression returns with an error and position.
        </div>
      </div>
    </Drawer>
  );
}

export function SyncDrawer() {
  const id = useApp((s) => s.syncDrawerId);
  const close = () => useApp.getState().setSyncDrawer(null);
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const sync = (bootstrap?.syncs ?? []).find((s) => s.id === id);
  if (!sync) return null;
  return (
    <Drawer title={sync.target} onClose={close}>
      <div className="tnum" style={{ fontSize: 13, color: "var(--text-tertiary)", marginBottom: 16 }}>{sync.frequency} · next run {sync.nextRun}</div>
      <div style={{ ...sectionLabel, marginBottom: 8 }}>Run history</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sync.history.map((h, i) => (
          h.status === "error" ? (
            <ErrorBanner
              key={i}
              component="Sync"
              process={`"${sync.target}" sync stopped`}
              detail={h.detail}
              severity="error"
            />
          ) : (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--border-tertiary)", borderRadius: 8 }}>
              <span className="tnum" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", flex: 1 }}>{h.at}</span>
              <StatusBadge kind="ok" />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{h.detail}</span>
            </div>
          )
        ))}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* TasksFacetsTab — right panel Tasks tab (gated to Tasks mode)       */
/*                                                                      */
/* Wired to GET /tasks/facets.  Two-way syncs with the `tasksFilter`  */
/* Zustand slice — clicking a row both filters the center view and     */
/* activates the matching top-bar pill.  NO per-section search here   */
/* (deferred to v1.1 per council 2026-06-14).                         */
/* ------------------------------------------------------------------ */

const FACETS_SHOW_DEFAULT = 5;

interface FacetSection {
  title: string;
  rows: { key: string; label: string; count: number; dot?: string }[];
  activeValue: string;
  onSelect: (v: string) => void;
}

function FacetSectionBlock({ title, rows, activeValue, onSelect }: FacetSection) {
  const [expanded, setExpanded] = useState(false);
  const sorted = [...rows].sort((a, b) => {
    // Pin active row first, then count-sort
    if (a.key === activeValue) return -1;
    if (b.key === activeValue) return 1;
    return b.count - a.count;
  });
  const visible = expanded ? sorted : sorted.slice(0, FACETS_SHOW_DEFAULT);
  const maxCount = Math.max(...rows.map((r) => r.count), 1);
  const showToggle = sorted.length > FACETS_SHOW_DEFAULT;

  return (
    <div style={{ borderTop: "1px solid var(--border-tertiary)" }}>
      <div style={{ padding: "12px 14px 5px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-quaternary)" }}>
        {title}
      </div>
      {visible.map((row) => {
        const active = activeValue === row.key;
        const barPct = Math.round((row.count / maxCount) * 100);
        return (
          <button
            key={row.key}
            onClick={() => onSelect(active ? "" : row.key)}
            style={{
              position: "relative", overflow: "hidden", display: "block", width: "100%",
              padding: 0, border: "none",
              background: active ? "var(--brand-50)" : "transparent",
              cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--gray-25)"; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = active ? "var(--brand-50)" : "transparent"; }}
          >
            {/* proportion bar */}
            <span style={{
              position: "absolute", left: 0, top: 3, bottom: 3, width: `${barPct}%`,
              background: active ? "var(--brand-200)" : "var(--gray-200)", opacity: 0.55,
              borderRadius: "0 var(--radius-sm) var(--radius-sm) 0", pointerEvents: "none",
            }} />
            <span style={{ position: "relative", zIndex: 1, display: "flex", alignItems: "center", gap: 10, padding: "7px 14px" }}>
              {row.dot && (
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: row.dot, flexShrink: 0 }} />
              )}
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: active ? "var(--brand-700)" : "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.label}
              </span>
              <span className="tnum" style={{ fontSize: 12, color: active ? "var(--brand-600)" : "var(--text-quaternary)" }}>{row.count}</span>
            </span>
          </button>
        );
      })}
      {showToggle && (
        <button
          onClick={() => setExpanded((e) => !e)}
          style={{
            display: "flex", alignItems: "center", gap: 5, width: "100%", padding: "7px 14px",
            border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-sans)",
            fontSize: 12, fontWeight: 500, color: "var(--brand-700)", textAlign: "left",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-25)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          {expanded ? "Show less" : `Show all (${sorted.length})`}
        </button>
      )}
    </div>
  );
}

export function TasksFacetsTab() {
  const { tasksFilter, setTasksFilter } = useApp();
  const facetParams = {
    tracker: tasksFilter.source || undefined,
    status: tasksFilter.status || undefined,
    assignee: tasksFilter.assignee || undefined,
    linked_metric: tasksFilter.metric || undefined,
  };

  const { data: facets, isLoading } = useQuery({
    queryKey: queryKeys.taskFacets(facetParams),
    queryFn: () => taskFacetsQueryFn(facetParams),
  });

  if (isLoading && !facets) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <span style={{ fontSize: 13, color: "var(--text-quaternary)" }}>Loading…</span>
      </div>
    );
  }

  if (!facets) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 18px", textAlign: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, lineHeight: "19px", color: "var(--text-tertiary)", maxWidth: 200 }}>
            Connect a tracker to see the goal, status, source and assignee breakdown.
          </span>
        </div>
      </div>
    );
  }

  // Build goal rows from facets.goal
  const goalRows = Object.entries(facets.goal)
    .filter(([k]) => k !== "unlinked")
    .map(([key, count]) => ({ key, label: key, count }));
  const unlinkedCount = facets.goal["unlinked"] ?? 0;
  if (unlinkedCount > 0) goalRows.push({ key: "unlinked", label: "Not linked", count: unlinkedCount });

  const statusRows = Object.entries(facets.status).map(([key, count]) => ({ key, label: key, count }));
  const sourceRows = Object.entries(facets.source).map(([key, count]) => ({
    key, label: key === "jira" ? "Jira" : "Linear", count,
  }));
  const assigneeRows = Object.entries(facets.assignee).map(([key, count]) => ({ key, label: key, count }));

  return (
    <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, paddingBottom: 12 }}>
      {goalRows.length > 0 && (
        <FacetSectionBlock
          title="Goals"
          rows={goalRows}

          activeValue={tasksFilter.metric}
          onSelect={(v) => setTasksFilter({ metric: v })}
        />
      )}
      {statusRows.length > 0 && (
        <FacetSectionBlock
          title="Status"
          rows={statusRows}
          activeValue={tasksFilter.status}
          onSelect={(v) => setTasksFilter({ status: v })}
        />
      )}
      {sourceRows.length > 0 && (
        <FacetSectionBlock
          title="Source"
          rows={sourceRows}
          activeValue={tasksFilter.source}
          onSelect={(v) => setTasksFilter({ source: v })}
        />
      )}
      {assigneeRows.length > 0 && (
        <FacetSectionBlock
          title="Assignee"
          rows={assigneeRows}
          activeValue={tasksFilter.assignee}
          onSelect={(v) => setTasksFilter({ assignee: v })}
        />
      )}
    </div>
  );
}
