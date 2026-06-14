// Mock domain data for the eigenheim app shell. Deterministic, no network.
// Shapes follow the design briefs (01 shell, 02 reports, 03 onboarding).

export type ReportStatus = "mock" | "collecting" | "live" | "stale" | "error";
export type MetricStatus = string; // "mock" | "live" | "stale" from mock; engine returns broader strings
export type EventOrigin = "synced" | "custom";

export interface TraceStep {
  label: string;
  value: string;
  mono?: boolean;
}
export interface WeekRow {
  week: string; // "Week 21"
  value: string;
  deltaPct?: number | null;
}
export interface Metric {
  id: string;
  name: string;
  value: string | null;
  delta?: number | null; // signed %, null = no previous
  spark: number[];
  status: MetricStatus;
  note?: string;
  series: number[]; // chart line
  weeks: WeekRow[];
  trace: Record<string, unknown>; // engine returns {formula, steps, finalQuery, result}; cast in trace.tsx
}
export interface Report {
  id: string;
  name: string;
  period: string;
  status: ReportStatus;
  lastBuilt: string;
  metrics: Metric[];
  metricCount?: number;
}
export interface EventRow {
  id: string;
  name: string;
  origin: EventOrigin;
  source: string;
  description: string;
}
export interface LogicRow {
  id: string;
  name: string;
  version: string;
  usage: number;
  badge?: "needs-validation" | "draft";
  expression: string;
}
export interface Template {
  id: string;
  name: string;
  description: string;
  expression: string;
}
export interface SyncRow {
  id: string;
  target: string;
  frequency: string;
  nextRun: string;
  lastStatus: "ok" | "error";
  lastRun: string;
  history: { at: string; status: "ok" | "error"; detail: string }[];
}
// McpKey interface removed in 1.2 — replaced by LiveKey in settings.tsx (typed against the live API).

const spark = (a: number[]) => a;

const activationTrace = {
  formula: "activation = unique(signup → first_report ≤ 7d) / unique(signup)",
  steps: [
    { label: "formula", value: "validated 12 Mar 2026 · v3 · sha f7c2…91aa", mono: true },
    { label: "events", value: "signup — 12,418 · first_report — 3,847", mono: true },
    { label: "period", value: "01 May 2026 → 31 May 2026 · UTC", mono: true },
    { label: "source", value: "PostHog export · synced 01 Jun 09:14 · checksum ok", mono: true },
  ] as TraceStep[],
  finalQuery:
    "SELECT count(DISTINCT user_id) FILTER (WHERE first_report - signup <= '7 days')\n     / count(DISTINCT user_id) FROM events_v3 WHERE ts BETWEEN $1 AND $2",
  result: "30.97%",
};

const weeks = (base: number, suffix = ""): WeekRow[] =>
  [21, 22, 23, 24].map((w, i) => {
    const v = base * (1 + i * 0.04 - 0.02);
    const prev = base * (1 + (i - 1) * 0.04 - 0.02);
    return {
      week: `Week ${w}`,
      value: i === 0 ? `${v.toFixed(0)}${suffix}` : `${v.toFixed(0)}${suffix}`,
      deltaPct: i === 0 ? null : +(((v - prev) / prev) * 100).toFixed(1),
    };
  });

export const REPORTS: Report[] = [
  {
    id: "activation",
    name: "Activation",
    period: "30d",
    status: "live",
    lastBuilt: "01 Jun 09:14",
    metrics: [
      {
        id: "act-rate", name: "Activation rate", value: "30.97%", delta: 2.4,
        spark: spark([26, 27, 28, 29, 30, 31, 31]), status: "live",
        series: [28.1, 28.9, 29.4, 30.1, 30.6, 30.97], weeks: weeks(31, "%"),
        trace: activationTrace,
      },
      {
        id: "act-d7", name: "D7 retention", value: "41.2%", delta: -1.1,
        spark: spark([44, 43, 43, 42, 42, 41, 41]), status: "stale",
        note: "formula updated", series: [43.8, 43.1, 42.6, 42.0, 41.5, 41.2],
        weeks: weeks(42, "%"),
        trace: {
          formula: "d7 = unique(active on signup+7d) / unique(signup)",
          steps: [
            { label: "formula", value: "validated 28 May 2026 · v4 · sha 1a9e…b2c0", mono: true },
            { label: "events", value: "signup — 12,418 · active — 5,116", mono: true },
            { label: "period", value: "01 May 2026 → 31 May 2026 · UTC", mono: true },
            { label: "source", value: "PostHog export · synced 01 Jun 09:14 · checksum ok", mono: true },
          ],
          finalQuery: "SELECT count(DISTINCT user_id) FILTER (...) / count(DISTINCT user_id) ...",
          result: "41.2%",
        },
      },
      {
        id: "act-ttv", name: "Time to first report", value: "2.4d", delta: -8.0,
        spark: spark([3.1, 3.0, 2.8, 2.7, 2.5, 2.4]), status: "live",
        series: [3.0, 2.9, 2.7, 2.6, 2.5, 2.4], weeks: weeks(2.4, "d"),
        trace: {
          formula: "ttv = median(first_report.ts - signup.ts)",
          steps: [
            { label: "formula", value: "validated 12 Mar 2026 · v2 · sha 77ad…0f31", mono: true },
            { label: "events", value: "first_report — 3,847", mono: true },
            { label: "period", value: "01 May 2026 → 31 May 2026 · UTC", mono: true },
            { label: "source", value: "PostHog export · synced 01 Jun 09:14 · checksum ok", mono: true },
          ],
          finalQuery: "SELECT median(first_report.ts - signup.ts) FROM ...",
          result: "2.4d",
        },
      },
    ],
  },
  {
    id: "growth",
    name: "Growth",
    period: "7d",
    status: "stale",
    lastBuilt: "30 May 22:00",
    metrics: [
      {
        id: "mau", name: "MAU", value: "48,210", delta: 3.6,
        spark: spark([44, 45, 45, 46, 47, 48, 48]), status: "stale",
        series: [45100, 45800, 46400, 47100, 47700, 48210], weeks: weeks(48000),
        trace: {
          formula: "mau = unique(any_event in trailing 30d)",
          steps: [
            { label: "formula", value: "validated 02 Apr 2026 · v1 · sha 5c10…aa92", mono: true },
            { label: "events", value: "any_event — 1,204,883", mono: true },
            { label: "period", value: "01 May 2026 → 31 May 2026 · UTC", mono: true },
            { label: "source", value: "PostHog export · synced 30 May 22:00 · checksum ok", mono: true },
          ],
          finalQuery: "SELECT count(DISTINCT user_id) FROM events WHERE ts >= now() - interval '30 days'",
          result: "48,210",
        },
      },
    ],
  },
  {
    id: "revenue",
    name: "Revenue",
    period: "30d",
    status: "mock",
    lastBuilt: "",
    metrics: [
      {
        id: "mrr", name: "MRR", value: "$0", delta: null, spark: spark([1, 2, 2, 3, 4, 5]),
        status: "mock", series: [1, 2, 2, 3, 4, 5], weeks: weeks(0, "$"),
        trace: { formula: "mrr = sum(active_subscription.amount)", steps: [], finalQuery: "—", result: "—" },
      },
    ],
  },
  {
    id: "funnel",
    name: "Onboarding funnel",
    period: "7d",
    status: "collecting",
    lastBuilt: "",
    metrics: [],
  },
  {
    id: "quality",
    name: "Data quality",
    period: "30d",
    status: "error",
    lastBuilt: "01 Jun 03:11",
    metrics: [],
  },
];

export const EVENTS: EventRow[] = [
  { id: "e1", name: "signup", origin: "synced", source: "PostHog · prod-eu", description: "User completed signup" },
  { id: "e2", name: "first_report", origin: "synced", source: "PostHog · prod-eu", description: "First report created" },
  { id: "e3", name: "page_view", origin: "synced", source: "PostHog · prod-eu", description: "Page view" },
  { id: "e4", name: "logic_validated", origin: "custom", source: "manual", description: "Formula accepted by user" },
  { id: "e5", name: "report_collected", origin: "synced", source: "PostHog · prod-eu", description: "Report rebuilt" },
  { id: "e6", name: "mcp_query", origin: "custom", source: "manual", description: "Agent queried a metric via MCP" },
  { id: "e7", name: "data_source_added", origin: "synced", source: "PostHog · prod-eu", description: "Data source connected" },
  { id: "e8", name: "subscription_started", origin: "custom", source: "manual", description: "Subscription started" },
];

export const LOGIC: LogicRow[] = [
  { id: "l1", name: "activation", version: "v3", usage: 3, expression: "unique(signup → first_report ≤ 7d) / unique(signup)" },
  { id: "l2", name: "mau", version: "v1", usage: 2, expression: "unique(any_event in trailing 30d)" },
  { id: "l3", name: "d7_retention", version: "v4", usage: 1, badge: "needs-validation", expression: "unique(active on signup+7d) / unique(signup)" },
  { id: "l4", name: "ttv", version: "v2", usage: 1, expression: "median(first_report.ts - signup.ts)" },
  { id: "l5", name: "wau_proposed", version: "v1", usage: 0, badge: "draft", expression: "unique(any_event in trailing 7d)" },
];

export const TEMPLATES: Template[] = [
  { id: "t1", name: "DAU", description: "Unique active users per day", expression: "unique(any_event in day)" },
  { id: "t2", name: "Stickiness", description: "DAU / MAU", expression: "dau / mau" },
  { id: "t3", name: "Conversion", description: "Share completing the step", expression: "unique(step_b) / unique(step_a)" },
];

export const SYNCS: SyncRow[] = [
  { id: "s1", target: "event catalog", frequency: "every 6h", nextRun: "01 Jun 15:00", lastStatus: "ok", lastRun: "01 Jun 09:00",
    history: [{ at: "01 Jun 09:00", status: "ok", detail: "184,320 events · 2.4s" }, { at: "01 Jun 03:00", status: "ok", detail: "184,201 events · 2.3s" }] },
  { id: "s2", target: "Activation", frequency: "every 24h", nextRun: "02 Jun 09:00", lastStatus: "ok", lastRun: "01 Jun 09:14",
    history: [{ at: "01 Jun 09:14", status: "ok", detail: "3 metrics · 184ms" }] },
  { id: "s3", target: "Data quality", frequency: "every 12h", nextRun: "01 Jun 15:11", lastStatus: "error", lastRun: "01 Jun 03:11",
    history: [{ at: "01 Jun 03:11", status: "error", detail: "PostHog adapter: sync stopped. Key rejected (401). Check the key in Settings → Data sources." }] },
];

/** Build the MCP config snippet that the user pastes into their agent config.
 *  The key is embedded so the snippet is copy-paste-ready.
 *  Called with the raw key only once (at reveal time). */
export function buildMcpConfig(rawKey: string): string {
  return `{
  "mcpServers": {
    "eigenheim": {
      "command": "eigenheim",
      "args": ["mcp", "serve"],
      "env": {
        "EIGENHEIM_MCP_KEY": "${rawKey}"
      }
    }
  }
}`;
}
// MCP_KEYS static mock + McpKey interface removed in 1.2 — replaced by live /mcp-keys API.
// SAMPLE_MCP_KEY removed in 1.2 — real keys generated via POST /mcp-keys (reveal-once).
// MCP_CONFIG_PLACEHOLDER removed — McpKeyStep always calls generate before showing the snippet.
