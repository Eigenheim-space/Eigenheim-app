/**
 * tasks.tsx — Tasks mode center surface.
 *
 * Wired to:
 *   GET /tasks/by-goal        — By goal view
 *   GET /tasks                — All tasks view (with filters)
 *   POST /task-links          — Link an unlinked task to a metric
 *   DELETE /task-links        — Unlink
 *   GET /trackers             — Connections-health pill + dropdown
 *
 * State lives in one `tasksFilter` Zustand slice — the facets panel in
 * panel.tsx reads the same slice (two-way sync, no useEffect loop).
 *
 * Hard rules (council 2026-06-14):
 *   - No DC runtime imports.
 *   - English-first copy, blunt second person, no SaaS slop.
 *   - LIGHT aesthetic: white, green accent only, no purple, no glassmorphism.
 *   - Flat scrim on drawer (no backdrop-filter blur).
 *   - prefers-reduced-motion respected via globals.css.
 *   - AA contrast, tabular-nums on every numeric.
 *   - Connect flow: 2 cards (Jira + Linear); directory list CUT.
 */

import {
  useState, useMemo, useCallback,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Target, Link2, Link2Off, ChevronRight,
  Loader2, AlertCircle, Plus, X,
  CheckCircle2, Circle, Clock, Minus, ArrowUpDown,
  ExternalLink, Shield,
  ChevronUp, ChevronDown,
} from "lucide-react";
import { useApp } from "./store";
import { api, type TaskRow, type TasksByGoalGroup, type TrackerRow } from "./api";
import { secrets } from "./secrets";
import { Badge, Button, IconButton, Sparkline, EmptyState, ErrorBanner, Tooltip, Segmented, Drawer } from "./ui";
import { ChatAffordance } from "./chat/ChatOverlay";
import { queryKeys, bootstrapQueryFn, trackersQueryFn, tasksQueryFn, tasksByGoalQueryFn, invalidate } from "./queries";
import { relativeTime } from "./lib/time";
import { useTraceForLogic } from "./hooks/useTraceForLogic";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function taskStatusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  const s = status.toLowerCase();
  if (s === "done" || s === "closed" || s === "completed") return "success";
  if (s === "in progress" || s === "in_progress") return "info";
  if (s === "blocked") return "danger";
  if (s === "in review" || s === "in_review") return "warning";
  return "neutral";
}

function sourceBadge(tracker: string) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 12, fontWeight: 500, color: "var(--text-tertiary)",
      background: "var(--gray-100)", borderRadius: "var(--radius-badge)",
      padding: "1px 7px", whiteSpace: "nowrap",
    }}>
      {tracker === "jira" ? "Jira" : "Linear"}
    </span>
  );
}

function assigneeChip(name: string | null | undefined) {
  if (!name) return <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>—</span>;
  const initials = name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
      <span style={{
        width: 22, height: 22, borderRadius: "var(--radius-full)", background: "var(--brand-100)",
        color: "var(--brand-700)", fontSize: 10, fontWeight: 700, display: "inline-flex",
        alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}>{initials}</span>
      {name}
    </span>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  const tone = taskStatusTone(status);
  const icons: Record<string, ReactNode> = {
    success: <CheckCircle2 size={12} />,
    info: <Clock size={12} />,
    danger: <AlertCircle size={12} />,
    warning: <Minus size={12} />,
    neutral: <Circle size={12} />,
  };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 12, fontWeight: 500, whiteSpace: "nowrap",
      background: tone === "success" ? "var(--success-50)" : tone === "info" ? "var(--blue-50)" : tone === "danger" ? "var(--error-50)" : tone === "warning" ? "var(--warning-50)" : "var(--gray-100)",
      color: tone === "success" ? "var(--success-700)" : tone === "info" ? "var(--blue-700)" : tone === "danger" ? "var(--error-700)" : tone === "warning" ? "var(--warning-700)" : "var(--gray-700)",
      borderRadius: "var(--radius-badge)", padding: "1px 7px",
    }}>
      {icons[tone]}{status}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Connections-health pill + dropdown (Increment 2)                   */
/* ------------------------------------------------------------------ */

function ConnectionsHealth({ trackers, onAddTracker }: {
  trackers: TrackerRow[];
  onAddTracker: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasIssue = trackers.some((t) => t.health !== "ok");
  const summaryLabel = trackers.length === 0
    ? "No trackers"
    : `${trackers.length} tracker${trackers.length > 1 ? "s" : ""}`;
  const summaryHealth = hasIssue ? "· 1 issue" : "";
  const dotColor = trackers.length === 0 ? "var(--gray-300)" : hasIssue ? "var(--warning-500)" : "var(--success-500)";
  const healthLabel = hasIssue ? "Has issues" : trackers.length > 0 ? "All trackers connected" : "No trackers connected";

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8, height: 32, padding: "0 9px",
          border: "1px solid var(--border-secondary)", background: "var(--color-white)",
          borderRadius: "var(--radius-md)", cursor: "pointer", boxShadow: "var(--shadow-xs)",
          fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, color: "var(--text-secondary)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--surface-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
      >
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
        <span>{summaryLabel}</span>
        {hasIssue && <span style={{ fontSize: 12, fontWeight: 500, color: "var(--warning-700)" }}>{summaryHealth}</span>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 29 }} />
          <div className="eh-fadein" style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, width: 308,
            background: "var(--color-white)", border: "1px solid var(--border-secondary)",
            borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)", zIndex: 30, overflow: "hidden",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border-tertiary)" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Connections</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: hasIssue ? "var(--warning-700)" : "var(--success-700)" }}>{healthLabel}</span>
            </div>
            {trackers.map((tr) => (
              <div key={tr.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: "1px solid var(--border-tertiary)" }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tr.tracker === "jira" ? "Jira" : "Linear"} · {tr.project_key || tr.workspace}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: tr.health === "ok" ? "var(--success-500)" : tr.health === "error" ? "var(--error-500)" : "var(--warning-500)" }} />
                  <span style={{ color: tr.health === "ok" ? "var(--success-700)" : tr.health === "error" ? "var(--error-700)" : "var(--warning-700)" }}>
                    {tr.health === "ok" ? "Connected" : tr.health === "error" ? "Error" : "Never synced"}
                  </span>
                </span>
                {tr.health === "error" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setOpen(false); onAddTracker(); }}
                    style={{ border: "none", background: "transparent", padding: "4px 7px", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500, color: "var(--brand-700)", cursor: "pointer", borderRadius: "var(--radius-sm)" }}
                  >
                    Reconnect
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => { setOpen(false); onAddTracker(); }}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "11px 14px",
                border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-sans)",
                fontSize: 13, fontWeight: 500, color: "var(--brand-700)", textAlign: "left",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-25)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <Plus size={14} />Add tracker
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connect flow — 2 cards only (directory cut per council)            */
/* ------------------------------------------------------------------ */

type ConnectState = "idle" | "expanded" | "pending" | "connected" | "error";

interface ConnectCardProps {
  name: "Jira" | "Linear";
  description: string;
  state: ConnectState;
  errorMsg?: string;
  onConnect: (creds: { token: string; base_url?: string; project_key?: string }) => void;
}

function ConnectCard({ name, description, state, errorMsg, onConnect }: ConnectCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [projectKey, setProjectKey] = useState("");

  const submit = () => {
    if (!token.trim()) return;
    onConnect({ token: token.trim(), base_url: baseUrl.trim() || undefined, project_key: projectKey.trim() || undefined });
  };

  const showConnectButton = state === "idle" || state === "error";
  const showForm = expanded && showConnectButton;

  return (
    <div style={{
      background: "var(--color-white)", border: `1px solid ${state === "connected" ? "var(--brand-300)" : "var(--border-secondary)"}`,
      borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-xs)", overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{name}</div>
          <div style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 2 }}>{description}</div>
        </div>
        {state === "connected" && <Badge tone="success" dot>Connected</Badge>}
        {state === "pending" && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-tertiary)" }}>
            <Loader2 size={14} style={{ animation: "eh-spin 1s linear infinite" }} />Connecting…
          </span>
        )}
        {showConnectButton && (
          <Button hierarchy="secondary" size="sm" onClick={() => setExpanded((e) => !e)}>
            {expanded ? "Cancel" : "Connect"}
          </Button>
        )}
      </div>

      {showForm && (
        <div className="eh-fadein" style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {name === "Jira" && (
            <>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}>
                  Jira base URL
                </label>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://yourorg.atlassian.net"
                  style={{ width: "100%", boxSizing: "border-box", height: 34, padding: "0 10px", fontSize: 13, fontFamily: "var(--font-mono)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-md)", outline: "none", background: "var(--surface-primary)", color: "var(--text-primary)" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}>
                  Project key <span style={{ color: "var(--text-quaternary)", fontWeight: 400 }}>(optional — leave blank for all projects)</span>
                </label>
                <input
                  type="text"
                  value={projectKey}
                  onChange={(e) => setProjectKey(e.target.value)}
                  placeholder="ENG"
                  style={{ width: "100%", boxSizing: "border-box", height: 34, padding: "0 10px", fontSize: 13, fontFamily: "var(--font-mono)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-md)", outline: "none", background: "var(--surface-primary)", color: "var(--text-primary)" }}
                />
              </div>
            </>
          )}
          {name === "Linear" && (
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}>
                Team key <span style={{ color: "var(--text-quaternary)", fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                type="text"
                value={projectKey}
                onChange={(e) => setProjectKey(e.target.value)}
                placeholder="ENG"
                style={{ width: "100%", boxSizing: "border-box", height: 34, padding: "0 10px", fontSize: 13, fontFamily: "var(--font-mono)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-md)", outline: "none", background: "var(--surface-primary)", color: "var(--text-primary)" }}
              />
            </div>
          )}
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}>
              API token <span style={{ color: "var(--text-quaternary)", fontWeight: 400 }}>— saved to OS keychain, never logged</span>
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={name === "Jira" ? "Atlassian API token" : "lin_api_…"}
              style={{ width: "100%", boxSizing: "border-box", height: 34, padding: "0 10px", fontSize: 13, fontFamily: "var(--font-mono)", border: `1px solid ${state === "error" ? "var(--error-300)" : "var(--border-primary)"}`, borderRadius: "var(--radius-md)", outline: "none", background: "var(--surface-primary)", color: "var(--text-primary)" }}
            />
          </div>
          {state === "error" && errorMsg && (
            <div style={{ display: "flex", gap: 6, fontSize: 12, color: "var(--error-700)", alignItems: "flex-start" }}>
              <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{errorMsg}</span>
            </div>
          )}
          <Button hierarchy="primary" size="sm" disabled={!token.trim()} onClick={submit} style={{ alignSelf: "flex-start" }}>
            Connect
          </Button>
        </div>
      )}
    </div>
  );
}

export function ConnectFlow({ onConnected }: { onConnected: () => void }) {
  const [jiraState, setJiraState] = useState<ConnectState>("idle");
  const [linearState, setLinearState] = useState<ConnectState>("idle");
  const [jiraError, setJiraError] = useState("");
  const [linearError, setLinearError] = useState("");
  const anyConnected = jiraState === "connected" || linearState === "connected";

  const handleConnect = useCallback(async (
    trackerName: "Jira" | "Linear",
    creds: { token: string; base_url?: string; project_key?: string },
  ) => {
    const tracker = trackerName === "Jira" ? "jira" : "linear";
    const setState = tracker === "jira" ? setJiraState : setLinearState;
    const setError = tracker === "jira" ? setJiraError : setLinearError;

    setState("pending");
    setError("");
    try {
      const result = await api.connectTracker({
        tracker,
        token: creds.token,
        base_url: creds.base_url,
        project_key: creds.project_key,
      });
      // Persist the token in the OS keychain so Reconnect and future syncs can retrieve it.
      await secrets.saveSource({
        id: `tracker:${result.id}`,
        kind: "tracker",
        host: tracker,
        projectId: result.project_key || "",
        apiKey: creds.token,
      }).catch(() => {/* keychain unavailable — non-fatal: token entered once */});
      await invalidate.tasks();
      setState("connected");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : "Connection failed");
    }
  }, []);

  return (
    <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "38px 32px 56px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div>
          <div style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.3px" }}>Connect a tracker</div>
          <div style={{ fontSize: 14, lineHeight: "21px", color: "var(--text-tertiary)", marginTop: 6, maxWidth: 520 }}>
            eigenheim reads tasks from your trackers and shows them next to the numbers they move. Connect one or more to open Tasks.
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, padding: "13px 15px", background: "var(--brand-25)", border: "1px solid var(--brand-200)", borderRadius: "var(--radius-xl)" }}>
          <Shield size={16} color="var(--brand-600)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--brand-800)" }}>Read-only, stays local</div>
            <div style={{ fontSize: 13, lineHeight: "19px", color: "var(--brand-700)", marginTop: 2 }}>
              eigenheim reads your tasks; your agent does the writing. Tokens stay in the OS keychain and never leave this machine.
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <ConnectCard
            name="Jira"
            description="Atlassian Cloud — project boards and backlogs"
            state={jiraState}
            errorMsg={jiraError}
            onConnect={(creds) => void handleConnect("Jira", creds)}
          />
          <ConnectCard
            name="Linear"
            description="Linear workspaces and teams"
            state={linearState}
            errorMsg={linearError}
            onConnect={(creds) => void handleConnect("Linear", creds)}
          />
        </div>

        {anyConnected && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 4 }} className="eh-fadein">
            <Button hierarchy="primary" iconTrailing={<ChevronRight size={15} />} onClick={onConnected}>
              Go to tasks
            </Button>
            <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>add more trackers later in Settings</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Task detail drawer                                                   */
/* ------------------------------------------------------------------ */

interface TaskDetailDrawerProps {
  externalId: string;
  tracker: string;
  onClose: () => void;
  allTasks: TaskRow[];
  goalGroups: TasksByGoalGroup[];
  logicOptions: { id: string; name: string }[];
  onLink: (externalId: string, tracker: string, logicId: string) => void;
  onUnlink: (externalId: string, tracker: string, logicId: string) => void;
}

export function TaskDetailDrawer({
  externalId, tracker, onClose, allTasks, goalGroups, logicOptions, onLink, onUnlink,
}: TaskDetailDrawerProps) {
  const task = allTasks.find((t) => t.external_id === externalId && t.tracker === tracker);
  const [linking, setLinking] = useState(false);
  const [pickerVal, setPickerVal] = useState("");

  const linkedLogicId = task?.link?.logic_id ?? null;
  const linkedGroup = linkedLogicId ? goalGroups.find((g) => g.metric.id === linkedLogicId) : null;
  const metric = linkedGroup?.metric ?? null;

  // Trace for the linked metric (hook must be called unconditionally).
  const { reportId: traceReportId, handleTrace } = useTraceForLogic(metric?.id ?? null);

  if (!task) return null;

  const deltaColor = metric?.delta == null ? "var(--text-quaternary)"
    : metric.delta >= 0 ? "var(--success-600)" : "var(--error-600)";
  const deltaText = metric?.delta == null ? null
    : `${metric.delta >= 0 ? "+" : ""}${metric.delta}%`;

  const handleLink = async () => {
    if (!pickerVal) return;
    setLinking(true);
    try { await onLink(externalId, tracker, pickerVal); } finally { setLinking(false); setPickerVal(""); }
  };

  return (
    <Drawer
      width={428}
      onClose={onClose}
      header={
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border-secondary)", flexShrink: 0 }}>
          {sourceBadge(tracker)}
          {task.url && (
            <a
              href={task.url}
              target="_blank"
              rel="noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 500, color: "var(--text-tertiary)", textDecoration: "none" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--brand-700)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--text-tertiary)"; }}
            >
              {task.external_id}<ExternalLink size={12} />
            </a>
          )}
          <span style={{ flex: 1 }} />
          <IconButton label="Close" onClick={onClose}><X size={18} /></IconButton>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingBottom: 16 }}>
        {/* title + meta */}
        <div>
          <div style={{ fontSize: 17, fontWeight: 600, lineHeight: "24px", letterSpacing: "-0.2px" }}>{task.title}</div>
          <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: "8px 12px", alignItems: "center", marginTop: 12 }}>
            <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>Status</span>
            <TaskStatusBadge status={task.status} />
            <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>Assignee</span>
            {assigneeChip(task.assignee)}
            <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>Source</span>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{tracker === "jira" ? "Jira" : "Linear"}</span>
            <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>Updated</span>
            <span className="tnum" style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {relativeTime(task.updated_at).full}
            </span>
          </div>
          {task.description && (
            <p style={{ fontSize: 13, lineHeight: "20px", color: "var(--text-tertiary)", margin: "10px 0 0" }}>
              {task.description}
            </p>
          )}
        </div>

        <div style={{ height: 1, background: "var(--border-tertiary)" }} />

        {/* linked metric */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
            Linked metric
          </div>

          {metric ? (
            <div style={{
              background: "var(--color-white)", border: "1px solid var(--brand-200)",
              borderRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-xs)", padding: 14,
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{metric.name}</span>
                <Badge tone={metric.delta != null && metric.delta >= 0 ? "success" : "warning"}>
                  {metric.delta != null && metric.delta >= 0 ? "Ahead" : "Behind"}
                </Badge>
                <span style={{ flex: 1 }} />
                {traceReportId && (
                  <Button hierarchy="link" size="sm" onClick={handleTrace}>
                    Trace
                  </Button>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="tnum" style={{ fontSize: 23, fontWeight: 600, letterSpacing: "-0.3px" }}>{metric.value ?? "—"}</span>
                {deltaText && <span className="tnum" style={{ fontSize: 13, fontWeight: 600, color: deltaColor }}>{deltaText}</span>}
              </div>
              {metric.spark.length > 1 && <Sparkline data={metric.spark} w={124} h={34} />}
              <button
                onClick={() => linkedLogicId && onUnlink(externalId, tracker, linkedLogicId)}
                style={{ alignSelf: "flex-start", border: "none", background: "transparent", padding: "2px 0", fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500, color: "var(--text-quaternary)", cursor: "pointer" }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--error-600)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-quaternary)"; }}
              >
                Unlink
              </button>
            </div>
          ) : (
            <div style={{ border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-xl)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={{ fontSize: 13, color: "var(--text-tertiary)" }}>Not linked to a metric yet.</span>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={pickerVal}
                  onChange={(e) => setPickerVal(e.target.value)}
                  style={{ flex: 1, height: 34, padding: "0 10px", fontSize: 13, fontFamily: "var(--font-sans)", color: "var(--text-primary)", background: "var(--color-white)", border: "1px solid var(--border-primary)", borderRadius: "var(--radius-md)", outline: "none" }}
                >
                  <option value="">Pick a metric…</option>
                  {logicOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <Button hierarchy="primary" size="sm" iconLeading={<Link2 size={14} />} disabled={!pickerVal || linking} onClick={handleLink}>
                  {linking ? "Linking…" : "Link"}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div style={{ height: 1, background: "var(--border-tertiary)" }} />

        {/* MCP note */}
        <p style={{ fontSize: 12, lineHeight: "18px", color: "var(--text-quaternary)", margin: 0 }}>
          Your agent creates and updates tasks via MCP. eigenheim only reads and links.
        </p>
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */
/* By-goal view                                                         */
/* ------------------------------------------------------------------ */

function GoalGroupCard({ group, onOpenTask, onLinkTask }: {
  group: TasksByGoalGroup;
  onOpenTask: (t: TaskRow) => void;
  onLinkTask: (t: TaskRow) => void;
}) {
  const m = group.metric;
  const { reportId: traceReportId, handleTrace } = useTraceForLogic(m.id);
  const isAhead = m.delta != null && m.delta >= 0;
  const deltaColor = m.delta == null ? "var(--text-quaternary)" : isAhead ? "var(--success-600)" : "var(--error-600)";
  const deltaText = m.delta == null ? null : `${m.delta >= 0 ? "+" : ""}${m.delta}%`;
  // progress-to-target: hidden until the engine returns a real target value.

  return (
    <div style={{ background: "var(--color-white)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-xs)", overflow: "hidden" }}>
      {/* metric header */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 14px 13px", background: "var(--gray-25)", borderBottom: "1px solid var(--border-secondary)", flexWrap: "wrap", position: "relative" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.1px", whiteSpace: "nowrap" }}>{m.name}</span>
            <Badge tone={isAhead ? "success" : "warning"}>{isAhead ? "Ahead" : "Behind"}</Badge>
          </div>
          <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>{group.tasks.length} task{group.tasks.length !== 1 ? "s" : ""}</span>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-end" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
              <span className="tnum" style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.3px" }}>{m.value ?? "—"}</span>
              {deltaText && <span className="tnum" style={{ fontSize: 12, fontWeight: 600, color: deltaColor }}>{deltaText}</span>}
            </div>
            <span style={{ fontSize: 11, color: "var(--text-quaternary)" }}>vs last period</span>
          </div>
          {m.spark.length > 1 && <Sparkline data={m.spark} w={80} h={32} />}
          {traceReportId && (
          <button
            onClick={handleTrace}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--border-primary)",
              background: "var(--color-white)", borderRadius: "var(--radius-md)", padding: "5px 9px",
              fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)",
              cursor: "pointer", boxShadow: "var(--shadow-xs)", flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
          >
            <Target size={12} />Trace
          </button>
          )}
        </div>
        {/* progress-to-target strip: hidden until engine returns a real target */}
      </div>
      {/* task rows */}
      {group.tasks.map((task) => (
        <TaskRow key={`${task.tracker}:${task.external_id}`} task={task} onClick={() => onOpenTask(task)} />
      ))}
    </div>
  );
}

function TaskRow({ task, onClick, onLink }: { task: TaskRow; onClick: () => void; onLink?: () => void }) {
  const { short, full } = relativeTime(task.updated_at);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className="eh-task-row"
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderTop: "1px solid var(--border-tertiary)" }}
    >
      <span style={{ fontSize: 14, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
        {task.title}
      </span>
      <TaskStatusBadge status={task.status} />
      {sourceBadge(task.tracker)}
      {task.assignee && (
        <span style={{ fontSize: 13, color: "var(--text-secondary)", whiteSpace: "nowrap", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis" }}>
          {task.assignee}
        </span>
      )}
      {onLink && (
        <button
          onClick={(e) => { e.stopPropagation(); onLink(); }}
          style={{
            display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--brand-300)",
            background: "var(--brand-25)", borderRadius: "var(--radius-md)", padding: "4px 9px",
            fontFamily: "var(--font-sans)", fontSize: 12, fontWeight: 500, color: "var(--brand-700)",
            cursor: "pointer", flexShrink: 0,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--brand-50)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--brand-25)"; }}
        >
          <Link2 size={12} />Link
        </button>
      )}
      <Tooltip content={full}>
        <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", width: 32, textAlign: "right", flexShrink: 0, whiteSpace: "nowrap" }}>
          {short}
        </span>
      </Tooltip>
      <ChevronRight size={14} className="eh-chev" />
    </div>
  );
}

function UnlinkedGroup({ tasks, onOpenTask }: { tasks: TaskRow[]; onOpenTask: (t: TaskRow) => void }) {
  if (tasks.length === 0) return null;
  return (
    <div style={{ background: "var(--color-white)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-2xl)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", background: "var(--gray-25)", borderBottom: "1px solid var(--border-tertiary)" }}>
        <Link2Off size={15} color="var(--fg-quaternary)" />
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Not linked to a metric · {tasks.length}</div>
          <div style={{ fontSize: 12, color: "var(--text-quaternary)", marginTop: 1 }}>these tasks aren't tied to a number they move yet</div>
        </div>
      </div>
      {tasks.map((task) => (
        <TaskRow
          key={`${task.tracker}:${task.external_id}`}
          task={task}
          onClick={() => onOpenTask(task)}
          onLink={() => onOpenTask(task)}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* All-tasks table (sortable)                                          */
/* ------------------------------------------------------------------ */

type SortKey = "title" | "status" | "updated";

function AllTasksTable({ tasks, onOpenTask }: { tasks: TaskRow[]; onOpenTask: (t: TaskRow) => void }) {
  const tasksFilter = useApp((s) => s.tasksFilter);
  const setTasksFilter = useApp((s) => s.setTasksFilter);
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const logic = bootstrap?.logic ?? [];
  const [sort, setSort] = useState<SortKey>("updated");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSort(key); setDir("asc"); setTasksFilter({ sort: key, sortDir: "asc" }); }
  };

  const sorted = useMemo(() => {
    return [...tasks].sort((a, b) => {
      let cmp = 0;
      if (sort === "title") cmp = a.title.localeCompare(b.title);
      else if (sort === "status") cmp = a.status.localeCompare(b.status);
      else cmp = (a.updated_at ?? "").localeCompare(b.updated_at ?? "");
      return dir === "asc" ? cmp : -cmp;
    });
  }, [tasks, sort, dir]);

  const colLabel = (key: SortKey, label: string, justify: "start" | "end" = "start") => {
    const active = sort === key;
    return (
      <button
        onClick={() => toggleSort(key)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 4, border: "none",
          background: "transparent", padding: 0, fontFamily: "var(--font-sans)",
          fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em",
          color: active ? "var(--text-primary)" : "var(--text-quaternary)", cursor: "pointer",
          justifyContent: justify === "end" ? "flex-end" : "flex-start", whiteSpace: "nowrap",
        }}
      >
        {label}
        {active
          ? (dir === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)
          : <ArrowUpDown size={11} style={{ opacity: 0.4 }} />}
      </button>
    );
  };

  const cols = "minmax(0,1fr) 100px 80px 140px 52px";

  return (
    <div style={{ padding: "18px 24px 48px" }}>
      <div style={{ background: "var(--color-white)", border: "1px solid var(--border-secondary)", borderRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-xs)", overflowX: "auto" }}>
        {/* header */}
        <div style={{ display: "grid", gridTemplateColumns: cols, alignItems: "center", gap: 10, padding: "9px 18px", background: "var(--gray-50)", borderBottom: "1px solid var(--border-secondary)", minWidth: 580 }}>
          {colLabel("title", "Task")}
          {colLabel("status", "Status")}
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-quaternary)" }}>Source</span>
          <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-quaternary)" }}>Metric</span>
          {colLabel("updated", "Updated", "end")}
        </div>
        {/* rows */}
        {sorted.length === 0 ? (
          <div style={{ padding: "32px 18px", textAlign: "center", fontSize: 13, color: "var(--text-tertiary)" }}>
            No tasks match the current filters.
          </div>
        ) : (
          sorted.map((task) => {
            const { short, full } = relativeTime(task.updated_at);
            const linkedLogicId = task.link?.logic_id ?? null;
            const linkedName = linkedLogicId
              ? (logic.find((l) => l.id === linkedLogicId)?.name ?? null)
              : null;
            return (
              <div
                key={`${task.tracker}:${task.external_id}`}
                role="button"
                tabIndex={0}
                onClick={() => onOpenTask(task)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenTask(task); } }}
                className="eh-task-row"
                style={{ display: "grid", gridTemplateColumns: cols, alignItems: "center", gap: 10, padding: "10px 18px", borderTop: "1px solid var(--border-tertiary)", minWidth: 580 }}
              >
                <span style={{ fontSize: 14, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {task.title}
                </span>
                <span style={{ minWidth: 0, overflow: "hidden" }}><TaskStatusBadge status={task.status} /></span>
                <span style={{ minWidth: 0, overflow: "hidden" }}>{sourceBadge(task.tracker)}</span>
                <span style={{ minWidth: 0, overflow: "hidden" }}>
                  {linkedName
                    ? <span style={{ fontSize: 12, color: "var(--brand-700)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{linkedName}</span>
                    : <span style={{ fontSize: 12, color: "var(--text-quaternary)" }}>—</span>}
                </span>
                <Tooltip content={full}>
                  <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", textAlign: "right", whiteSpace: "nowrap" }}>{short}</span>
                </Tooltip>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Filter top bar                                                       */
/* ------------------------------------------------------------------ */

function FilterPill({
  label, value, options, onSelect, onClear,
}: {
  label: string;
  value: string;
  options: string[];
  onSelect: (v: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = !!value;

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6, height: 34, padding: "0 8px 0 10px",
          border: `1px solid ${active ? "var(--brand-300)" : "var(--border-secondary)"}`,
          background: active ? "var(--brand-50)" : "var(--color-white)",
          borderRadius: "var(--radius-md)", cursor: "pointer", fontFamily: "var(--font-sans)",
          fontSize: 13, fontWeight: 500, color: active ? "var(--brand-700)" : "var(--text-secondary)",
          boxShadow: "var(--shadow-xs)", whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--surface-hover)"; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = active ? "var(--brand-50)" : "var(--color-white)"; }}
      >
        <span>{value || label}</span>
        {active ? (
          <span
            onClick={(e) => { e.stopPropagation(); onClear(); setOpen(false); }}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 16, height: 16, borderRadius: "50%", color: "var(--brand-500)" }}
          >
            <X size={11} />
          </span>
        ) : (
          <ChevronDown size={13} />
        )}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9 }} />
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 180,
            background: "var(--color-white)", border: "1px solid var(--border-secondary)",
            borderRadius: "var(--radius-lg)", boxShadow: "var(--shadow-lg)", padding: 4,
            zIndex: 10, display: "flex", flexDirection: "column", gap: 1,
          }} className="eh-fadein">
            {options.map((opt) => (
              <button
                key={opt}
                onClick={() => { onSelect(opt); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
                  padding: "7px 10px", border: "none", background: value === opt ? "var(--brand-50)" : "transparent",
                  borderRadius: "var(--radius-md)", cursor: "pointer", fontFamily: "var(--font-sans)",
                  fontSize: 13, fontWeight: 500, color: "var(--text-secondary)",
                }}
                onMouseEnter={(e) => { if (value !== opt) e.currentTarget.style.background = "var(--gray-50)"; }}
                onMouseLeave={(e) => { if (value !== opt) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ width: 14, display: "inline-flex", flexShrink: 0 }}>
                  {value === opt && <CheckCircle2 size={13} color="var(--brand-600)" />}
                </span>
                {opt}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tasks surface (main export)                                         */
/* ------------------------------------------------------------------ */

export function TasksView() {
  const tasksView = useApp((s) => s.tasksView);
  const setTasksView = useApp((s) => s.setTasksView);
  const tasksFilter = useApp((s) => s.tasksFilter);
  const setTasksFilter = useApp((s) => s.setTasksFilter);
  const resetTasksFilter = useApp((s) => s.resetTasksFilter);
  const openTaskDrawer = useApp((s) => s.openTaskDrawer);
  const closeTaskDrawer = useApp((s) => s.closeTaskDrawer);
  const taskDrawerId = useApp((s) => s.taskDrawerId);
  const taskDrawerTracker = useApp((s) => s.taskDrawerTracker);

  const [showConnect, setShowConnect] = useState(false);

  // Trackers — already fetched in App.tsx; just read the count flag from the store.
  // But we also need the tracker list here for the connect flow.
  const { data: trackers = [], isSuccess: trackersLoaded } = useQuery({
    queryKey: queryKeys.trackers,
    queryFn: trackersQueryFn,
    staleTime: 2 * 60 * 1000,
  });

  const hasTrackers = trackers.length > 0;

  // Bootstrap for logic options
  const { data: bootstrap } = useQuery({ queryKey: queryKeys.engineBootstrap, queryFn: bootstrapQueryFn, staleTime: 2 * 60 * 1000 });
  const logic = bootstrap?.logic ?? [];

  const taskParams = {
    status: tasksFilter.status || undefined,
    tracker: tasksFilter.source || undefined,
    assignee: tasksFilter.assignee || undefined,
    logic_id: tasksFilter.metric || undefined,
  };

  // By-goal data
  const { data: byGoalData, isLoading: bgLoading, isError: bgError } = useQuery({
    queryKey: queryKeys.tasksByGoal,
    queryFn: tasksByGoalQueryFn,
    enabled: hasTrackers,
    staleTime: 2 * 60 * 1000,
  });

  // Flat tasks (respects filter)
  const { data: allTasks = [], isLoading: allLoading, isError: allError, refetch } = useQuery({
    queryKey: queryKeys.tasks(taskParams),
    queryFn: () => tasksQueryFn(taskParams),
    enabled: hasTrackers,
    staleTime: 2 * 60 * 1000,
  });

  const loading = bgLoading || allLoading;
  const error = (bgError || allError) ? "Failed to load tasks" : null;

  // Derive filter options from loaded data
  const statusOptions = useMemo(() => {
    const s = new Set(allTasks.map((t) => t.status));
    return Array.from(s).sort();
  }, [allTasks]);
  const assigneeOptions = useMemo(() => {
    const s = new Set(allTasks.map((t) => t.assignee).filter(Boolean) as string[]);
    return Array.from(s).sort();
  }, [allTasks]);
  const metricOptions = useMemo(() => {
    return logic.map((l) => ({ id: l.id, name: l.name }));
  }, [logic]);

  // Filter tasks for All view
  const filteredTasks = useMemo(() => {
    return allTasks.filter((t) => {
      if (tasksFilter.search && !t.title.toLowerCase().includes(tasksFilter.search.toLowerCase())) return false;
      if (tasksFilter.status && t.status !== tasksFilter.status) return false;
      if (tasksFilter.source && t.tracker !== tasksFilter.source) return false;
      if (tasksFilter.assignee && t.assignee !== tasksFilter.assignee) return false;
      if (tasksFilter.metric && t.link?.logic_id !== tasksFilter.metric) return false;
      return true;
    });
  }, [allTasks, tasksFilter]);

  // Also filter by-goal groups
  const filteredGroups = useMemo(() => {
    if (!byGoalData) return { groups: [], unlinked: [] };
    if (!tasksFilter.search && !tasksFilter.status && !tasksFilter.source && !tasksFilter.assignee && !tasksFilter.metric) {
      return byGoalData;
    }
    const filterTask = (t: TaskRow) => {
      if (tasksFilter.search && !t.title.toLowerCase().includes(tasksFilter.search.toLowerCase())) return false;
      if (tasksFilter.status && t.status !== tasksFilter.status) return false;
      if (tasksFilter.source && t.tracker !== tasksFilter.source) return false;
      if (tasksFilter.assignee && t.assignee !== tasksFilter.assignee) return false;
      if (tasksFilter.metric && t.link?.logic_id !== tasksFilter.metric) return false;
      return true;
    };
    return {
      groups: byGoalData.groups.map((g) => ({ ...g, tasks: g.tasks.filter(filterTask) })).filter((g) => g.tasks.length > 0),
      unlinked: byGoalData.unlinked.filter(filterTask),
    };
  }, [byGoalData, tasksFilter]);

  // All tasks for the drawer lookup (unfiltered)
  const allTasksFlat = useMemo(() => {
    if (!byGoalData) return allTasks;
    const fromGoals = byGoalData.groups.flatMap((g) => g.tasks);
    const seen = new Set(fromGoals.map((t) => `${t.tracker}:${t.external_id}`));
    return [...fromGoals, ...byGoalData.unlinked.filter((t) => !seen.has(`${t.tracker}:${t.external_id}`))];
  }, [byGoalData, allTasks]);

  const handleLink = async (externalId: string, tracker: string, logicId: string) => {
    await api.linkTask(externalId, tracker, logicId);
    await invalidate.tasks();
  };

  const handleUnlink = async (externalId: string, tracker: string, logicId: string) => {
    await api.unlinkTask(externalId, tracker, logicId);
    await invalidate.tasks();
  };

  const anyFilter = !!(tasksFilter.search || tasksFilter.status || tasksFilter.source || tasksFilter.assignee || tasksFilter.metric);
  const totalCount = tasksView === "by-goal"
    ? (filteredGroups.groups.reduce((s, g) => s + g.tasks.length, 0) + filteredGroups.unlinked.length)
    : filteredTasks.length;

  if (!trackersLoaded) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Loader2 size={22} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />
      </div>
    );
  }

  if (showConnect || !hasTrackers) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-secondary)" }}>
        <ConnectFlow onConnected={() => {
          setShowConnect(false);
          // Invalidate trackers query so the gate re-checks
          void invalidate.tasks();
        }} />
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-secondary)", position: "relative" }}>
      {/* top bar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 11, padding: "13px 20px 12px", borderBottom: "1px solid var(--border-secondary)", flexShrink: 0, background: "var(--surface-secondary)", position: "relative", zIndex: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Segmented
            value={tasksView}
            options={[
              { value: "by-goal", label: "By goal" },
              { value: "all", label: "All tasks" },
            ]}
            onChange={(v) => setTasksView(v as "by-goal" | "all")}
          />
          <span style={{ flex: 1 }} />
          <ChatAffordance />
          <ConnectionsHealth trackers={trackers} onAddTracker={() => setShowConnect(true)} />
        </div>

        {/* filter row */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {/* search */}
          <div style={{ position: "relative" }}>
            <input
              value={tasksFilter.search}
              onChange={(e) => setTasksFilter({ search: e.target.value })}
              placeholder="Search tasks"
              aria-label="Search tasks"
              style={{
                width: 200, height: 34, padding: "0 10px", fontSize: 13,
                fontFamily: "var(--font-sans)", color: "var(--text-primary)",
                background: "var(--color-white)", border: "1px solid var(--border-secondary)",
                borderRadius: "var(--radius-md)", outline: "none", boxShadow: "var(--shadow-xs)",
              }}
            />
          </div>

          <FilterPill
            label="Status"
            value={tasksFilter.status}
            options={statusOptions}
            onSelect={(v) => setTasksFilter({ status: v })}
            onClear={() => setTasksFilter({ status: "" })}
          />
          <FilterPill
            label="Source"
            value={tasksFilter.source}
            options={["jira", "linear"]}
            onSelect={(v) => setTasksFilter({ source: v })}
            onClear={() => setTasksFilter({ source: "" })}
          />
          <FilterPill
            label="Assignee"
            value={tasksFilter.assignee}
            options={assigneeOptions}
            onSelect={(v) => setTasksFilter({ assignee: v })}
            onClear={() => setTasksFilter({ assignee: "" })}
          />
          <FilterPill
            label="Metric"
            value={tasksFilter.metric ? (metricOptions.find((o) => o.id === tasksFilter.metric)?.name ?? tasksFilter.metric) : ""}
            options={metricOptions.map((o) => o.name)}
            onSelect={(v) => {
              const found = metricOptions.find((o) => o.name === v);
              setTasksFilter({ metric: found?.id ?? v });
            }}
            onClear={() => setTasksFilter({ metric: "" })}
          />

          <span style={{ flex: 1 }} />
          {anyFilter && (
            <button
              onClick={resetTasksFilter}
              style={{ border: "none", background: "transparent", padding: "0 2px", fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 500, color: "var(--text-tertiary)", cursor: "pointer" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--brand-700)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-tertiary)"; }}
            >
              Reset
            </button>
          )}
          <span className="tnum" style={{ fontSize: 12, color: "var(--text-quaternary)", whiteSpace: "nowrap" }}>
            {totalCount} task{totalCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* body */}
      <div className="eh-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {error && (
          <div style={{ padding: "16px 24px 0" }}>
            <ErrorBanner
              component="Tasks"
              process="loading stopped"
              detail={error}
              action={<Button hierarchy="tertiary" size="sm" onClick={() => void refetch()}>Retry</Button>}
            />
          </div>
        )}

        {loading && !byGoalData && !error && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "64px 24px" }}>
            <Loader2 size={22} color="var(--text-quaternary)" style={{ animation: "eh-spin 1s linear infinite" }} />
          </div>
        )}

        {!loading && !error && tasksView === "by-goal" && byGoalData && (
          filteredGroups.groups.length === 0 && filteredGroups.unlinked.length === 0
            ? <EmptyState line={anyFilter ? "No tasks match the current filters." : "No tasks yet. Sync a tracker to pull tasks."} button={anyFilter ? <Button hierarchy="secondary" size="sm" onClick={resetTasksFilter}>Clear filters</Button> : undefined} />
            : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "18px 24px 48px" }}>
                {filteredGroups.groups.map((group) => (
                  <GoalGroupCard
                    key={group.metric.id}
                    group={group}
                    onOpenTask={(t) => openTaskDrawer(t.external_id, t.tracker)}
                    onLinkTask={(t) => openTaskDrawer(t.external_id, t.tracker)}
                  />
                ))}
                <UnlinkedGroup tasks={filteredGroups.unlinked} onOpenTask={(t) => openTaskDrawer(t.external_id, t.tracker)} />
              </div>
            )
        )}

        {!loading && !error && tasksView === "all" && (
          <AllTasksTable tasks={filteredTasks} onOpenTask={(t) => openTaskDrawer(t.external_id, t.tracker)} />
        )}
      </div>

      {/* task detail drawer */}
      {taskDrawerId && taskDrawerTracker && (
        <TaskDetailDrawer
          externalId={taskDrawerId}
          tracker={taskDrawerTracker}
          onClose={closeTaskDrawer}
          allTasks={allTasksFlat}
          goalGroups={byGoalData?.groups ?? []}
          logicOptions={metricOptions}
          onLink={handleLink}
          onUnlink={handleUnlink}
        />
      )}
    </div>
  );
}
