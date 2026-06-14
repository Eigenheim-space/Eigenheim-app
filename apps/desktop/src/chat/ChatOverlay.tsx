/**
 * chat/ChatOverlay.tsx
 *
 * Cmd+K overlay: centered command-bar floating above any view.
 * LIGHT aesthetic: white surface, --radius-2xl, 1px border, soft shadow.
 * Flat scrim rgba(0,0,0,0.35) — NO backdrop blur.
 * prefers-reduced-motion: no scale/fade animation, instant appear/disappear.
 *
 * Architecture: all model calls live here (renderer-side). The engine is never
 * contacted for LLM inference. Context is read from the store (report cache)
 * and passed to the active adapter's .chat() method.
 *
 * Cloud (option A) is off by default. The persistent egress badge (danger slot,
 * red) is shown whenever cloud is the active provider. It cannot be dismissed.
 */

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { X, ExternalLink, MessageCircle, ChevronDown, Check, AlertTriangle } from "lucide-react";
import { useApp } from "../store";
import { getReportFromCache } from "../queries";
import { Badge, Button, ErrorBanner, IconButton } from "../ui";
import {
  OpenRouterAdapter,
  OllamaAdapter,
  AgentAdapter,
  type ChatMessage,
  type ProviderKind,
} from "./providers";
import { chatSecrets } from "./chatSecrets";

// ─── Context builder: reads the active report from the store ─────────────────

function buildContextBlock(): string {
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
    lines.push(`  - ${m.name}: ${m.value ?? "—"} (delta: ${m.delta != null ? `${m.delta > 0 ? "+" : ""}${m.delta}%` : "n/a"}, status: ${m.status})`);
  }
  lines.push(`\nNote: these numbers are deterministically computed by eigenheim from validated formulas. Cite them exactly. Do not invent numbers.`);
  return lines.join("\n");
}

// ─── Metric chip: inline verified/inferred badge on numeric citations ─────────

interface MetricChip {
  name: string;
  value: string;
  metricId: string;
  reportId: string;
  verified: boolean;
}

/**
 * Match metric citations in assistant text.
 * Returns an array of {text, chip?} segments for inline rendering.
 */
function parseAnswerSegments(
  text: string,
  metrics: { id: string; name: string; value: string | null }[],
  reportId: string
): Array<{ text: string; chip?: MetricChip }> {
  if (!metrics.length) return [{ text }];

  const segments: Array<{ text: string; chip?: MetricChip }> = [];
  let remaining = text;

  // For each metric, check if the name or value appears in the text
  // and wrap it in a chip. Simple string search — not regex to avoid false positives.
  const matched = new Set<string>();

  for (const m of metrics) {
    const pattern = m.name;
    const idx = remaining.toLowerCase().indexOf(pattern.toLowerCase());
    if (idx === -1 || matched.has(m.id)) continue;
    matched.add(m.id);

    if (idx > 0) segments.push({ text: remaining.slice(0, idx) });
    segments.push({
      text: pattern,
      chip: { name: m.name, value: m.value ?? "—", metricId: m.id, reportId, verified: true },
    });
    remaining = remaining.slice(idx + pattern.length);
  }

  if (remaining) segments.push({ text: remaining });
  return segments;
}

// ─── Provider switcher dropdown ───────────────────────────────────────────────

interface ProviderSwitcherProps {
  onClose: () => void;
  onSetup: () => void;
}

function ProviderSwitcher({ onClose, onSetup }: ProviderSwitcherProps) {
  const {
    chatProvider, setChatProvider, chatHasCloudKey,
    chatEgressConfirmedThisSession, setChatEgressConfirmed,
    chatOllamaModel, chatOpenRouterModel,
  } = useApp();

  const [pendingCloud, setPendingCloud] = useState(false);

  const switchTo = (kind: ProviderKind) => {
    if (kind === "openrouter") {
      if (!chatHasCloudKey) { onClose(); onSetup(); return; }
      if (!chatEgressConfirmedThisSession) { setPendingCloud(true); return; }
    }
    setChatProvider(kind);
    onClose();
  };

  const confirmCloud = () => {
    setChatEgressConfirmed(true);
    setChatProvider("openrouter");
    onClose();
  };

  const options: { kind: ProviderKind; title: string; sub: string; configured: boolean; modelLabel: string }[] = [
    {
      kind: "ollama",
      title: "Local model",
      sub: "Ollama · fully local",
      configured: true,
      modelLabel: chatOllamaModel,
    },
    {
      kind: "openrouter",
      title: "Cloud API",
      sub: chatHasCloudKey ? "OpenRouter" : "Not configured",
      configured: chatHasCloudKey,
      modelLabel: chatOpenRouterModel,
    },
    {
      kind: "agent",
      title: "External agent",
      sub: "MCP · local to your agent",
      configured: true,
      modelLabel: "MCP",
    },
  ];

  return (
    <div
      role="menu"
      style={{
        position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 20,
        background: "var(--color-white)", border: "1px solid var(--border-secondary)",
        borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-lg)",
        minWidth: 280, overflow: "hidden",
      }}
    >
      {pendingCloud ? (
        <div style={{ padding: "14px 16px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--error-700)", marginBottom: 6 }}>
            Data leaves your machine
          </div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 14 }}>
            Your messages and the report metric values go to OpenRouter.
            Your formulas and source keys stay local.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button hierarchy="danger" size="sm" onClick={confirmCloud}>Send to cloud</Button>
            <Button hierarchy="secondary" size="sm" onClick={() => setPendingCloud(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        options.map((o) => {
          const active = chatProvider === o.kind;
          return (
            <button
              key={o.kind}
              role="menuitem"
              onClick={() => switchTo(o.kind)}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "10px 14px", textAlign: "left", border: "none",
                background: active ? "var(--surface-active)" : "transparent",
                cursor: "pointer", borderBottom: "1px solid var(--border-tertiary)",
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--surface-hover)"; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = active ? "var(--surface-active)" : "transparent"; }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{o.title}</div>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 1 }}>
                  {o.configured ? o.modelLabel : o.sub}
                </div>
              </div>
              {active && <Check size={15} color="var(--brand-600)" />}
              {!o.configured && (
                <span style={{ fontSize: 12, color: "var(--blue-600)", fontWeight: 500 }}>Set up</span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

// ─── Metric chip inline component ────────────────────────────────────────────

function MetricChipEl({ chip }: { chip: MetricChip }) {
  const openTrace = useApp((s) => s.openTrace);
  const bg = chip.verified ? "var(--blue-50)" : "var(--warning-50)";
  const tone = chip.verified ? "info" : "warning";
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        background: bg, borderRadius: "var(--radius-sm)", padding: "1px 7px",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span style={{ fontWeight: 600 }}>{chip.name}</span>
      <span className="tnum">{chip.value}</span>
      <Badge tone={tone} dot={chip.verified}>{chip.verified ? "synced" : "inferred"}</Badge>
      <button
        onClick={() => openTrace(chip.reportId, chip.metricId)}
        aria-label={`Open trace for ${chip.name}`}
        title="Open trace"
        style={{ display: "inline-flex", border: "none", background: "transparent", cursor: "pointer", padding: 0, color: "var(--blue-600)" }}
      >
        <ExternalLink size={11} />
      </button>
    </span>
  );
}

// ─── Answer renderer: text with inline metric chips ───────────────────────────

function AnswerText({ content, reportId }: { content: string; reportId: string | null }) {
  const report = reportId ? getReportFromCache(reportId) : null;
  const metrics = report?.metrics ?? [];
  const segs = parseAnswerSegments(content, metrics, reportId ?? "");
  return (
    <span style={{ lineHeight: 1.6 }}>
      {segs.map((seg, i) =>
        seg.chip ? <MetricChipEl key={i} chip={seg.chip} /> : <span key={i}>{seg.text}</span>
      )}
    </span>
  );
}

// ─── Suggestion chips ─────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "What drove activation last week?",
  "Compare the metric trend over time.",
  "What's the biggest gap in this report?",
];

// ─── Main overlay ─────────────────────────────────────────────────────────────

export function ChatOverlay() {
  const {
    chatOpen, closeChat,
    chatProvider, chatOllamaEndpoint, chatOllamaModel, chatOpenRouterModel,
    chatMessages, appendChatMessage, updateLastAssistantChunk, clearChatMessages,
    chatStreaming, setChatStreaming, chatError, setChatError,
    openReportId, goSettings, setSettingsSection,
  } = useApp();

  const [input, setInput] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const responseRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Close switcher on click-outside
  useEffect(() => {
    if (!switcherOpen) return;
    const h = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [switcherOpen]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (responseRef.current) responseRef.current.scrollTop = responseRef.current.scrollHeight;
  }, [chatMessages, chatStreaming]);

  // Focus input when overlay opens
  useEffect(() => {
    if (chatOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [chatOpen]);

  const isCloud = chatProvider === "openrouter";
  const isAgent = chatProvider === "agent";

  const getAdapter = useCallback(async () => {
    if (isAgent) return new AgentAdapter();
    if (isCloud) {
      const key = await chatSecrets.getKey();
      if (!key) throw new Error("OpenRouter key not found. Go to Settings → AI Chat to add one.");
      return new OpenRouterAdapter({ apiKey: key, model: chatOpenRouterModel });
    }
    return new OllamaAdapter({ endpoint: chatOllamaEndpoint, model: chatOllamaModel });
  }, [isAgent, isCloud, chatOpenRouterModel, chatOllamaEndpoint, chatOllamaModel]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || chatStreaming) return;

    setChatError(null);
    setInput("");

    // Snapshot the history BEFORE appending the new user message so the
    // adapter does not receive the same turn twice.
    const historySnapshot = useApp.getState().chatMessages;

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    appendChatMessage(userMsg);

    // Build context block from the current report
    const ctx = buildContextBlock();
    const systemMsg: ChatMessage = {
      role: "system",
      content: ctx
        ? `You are a product metrics assistant for eigenheim. The user has an open report with the following verified data:\n\n${ctx}\n\nCite these numbers exactly. Mark any figure you invent as inferred. Be direct and concise.`
        : "You are a product metrics assistant for eigenheim. No report is currently open. Answer based on general product management knowledge.",
    };

    const messages: ChatMessage[] = [systemMsg, ...historySnapshot, userMsg];

    // Set up abort controller for this request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;

    setChatStreaming(true);
    // prime an empty assistant slot for streaming
    appendChatMessage({ role: "assistant", content: "" });

    try {
      const adapter = await getAdapter();
      await adapter.chat(messages, (delta) => {
        if (signal.aborted) return;
        updateLastAssistantChunk(delta);
      }, signal);
    } catch (e) {
      if (signal.aborted) {
        // Stream was cancelled by closeChat; remove the empty placeholder
        useApp.setState((s) => ({
          chatMessages: s.chatMessages.filter((_, i) => i < s.chatMessages.length - 1),
        }));
        return;
      }
      const msg = e instanceof Error ? e.message : "Unknown error";
      setChatError(msg);
      // remove the empty assistant placeholder
      useApp.setState((s) => ({
        chatMessages: s.chatMessages.filter((_, i) => i < s.chatMessages.length - 1),
      }));
    } finally {
      if (!signal.aborted) setChatStreaming(false);
    }
  }, [chatStreaming, appendChatMessage, updateLastAssistantChunk, setChatStreaming, setChatError, getAdapter]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const handleCloseChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    closeChat();
    setSwitcherOpen(false);
  }, [closeChat]);

  // Close on Escape — must be after handleCloseChat declaration
  useEffect(() => {
    if (!chatOpen) return;
    const h = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { handleCloseChat(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [chatOpen, handleCloseChat]);

  const goToSetup = () => {
    handleCloseChat();
    setSettingsSection("aichat");
    goSettings();
  };

  if (!chatOpen) return null;

  // Overlay animation classes handled via CSS (instant under reduced-motion)
  return (
    <>
      {/* Flat scrim — no backdrop blur */}
      <div
        onClick={handleCloseChat}
        className="eh-chat-scrim"
        style={{
          position: "fixed", inset: 0,
          background: "rgba(0,0,0,0.35)",
          zIndex: 70,
        }}
        aria-hidden
      />

      {/* Overlay frame */}
      <div
        role="dialog"
        aria-label="AI Chat"
        aria-modal="true"
        className="eh-chat-overlay"
        style={{
          position: "fixed",
          top: "30%",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(640px, calc(100vw - 32px))",
          maxHeight: "60vh",
          background: "var(--color-white)",
          border: "1px solid var(--border-secondary)",
          borderRadius: "var(--radius-2xl)",
          boxShadow: "var(--shadow-2xl)",
          zIndex: 71,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header: provider badge + close */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 14px", borderBottom: "1px solid var(--border-secondary)",
          position: "relative",
        }}>
          {/* Provider badge — cloud gets danger (red), local gets info (green) */}
          <div ref={switcherRef} style={{ position: "relative" }}>
            <button
              onClick={() => setSwitcherOpen((v) => !v)}
              aria-label="Switch provider"
              aria-expanded={switcherOpen}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                background: "transparent", border: "none", cursor: "pointer", padding: 0,
              }}
            >
              {isCloud ? (
                <Badge tone="danger">Cloud: OpenRouter</Badge>
              ) : isAgent ? (
                <Badge tone="neutral">Agent · MCP</Badge>
              ) : (
                <Badge tone="info" dot>Local · {chatOllamaModel}</Badge>
              )}
              <ChevronDown size={13} color="var(--text-tertiary)" />
            </button>
            {switcherOpen && (
              <ProviderSwitcher
                onClose={() => setSwitcherOpen(false)}
                onSetup={goToSetup}
              />
            )}
          </div>

          <span style={{ flex: 1 }} />
          <IconButton label="Close chat" onClick={handleCloseChat}>
            <X size={16} />
          </IconButton>
        </div>

        {/* Response area */}
        <div
          ref={responseRef}
          className="eh-scroll"
          style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12, minHeight: 80 }}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
        >
          {chatMessages.length === 0 && !chatError && (
            <div style={{ color: "var(--text-quaternary)", fontSize: 13, textAlign: "center", padding: "16px 0" }}>
              {isAgent
                ? "External agent mode. Use your desktop agent over MCP — eigenheim does not route messages from here."
                : openReportId
                ? "Ask about this report's metrics, trends, or cohorts."
                : "No report open. Ask a product question or open a report first."}
            </div>
          )}

          {chatMessages.map((m, i) => (
            <div key={m.id ?? i} style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
              {m.role === "user" ? (
                <div style={{
                  background: "var(--gray-100)", borderRadius: "var(--radius-lg)",
                  padding: "8px 12px", maxWidth: "85%", fontSize: 14,
                  color: "var(--text-primary)", lineHeight: 1.55,
                }}>
                  {m.content}
                </div>
              ) : (
                <div style={{ maxWidth: "100%", fontSize: 14, color: "var(--text-primary)" }}>
                  {m.content ? (
                    <AnswerText content={m.content} reportId={openReportId} />
                  ) : (
                    chatStreaming && i === chatMessages.length - 1 && (
                      <span style={{ color: "var(--text-quaternary)", fontSize: 13 }}>…</span>
                    )
                  )}
                </div>
              )}
            </div>
          ))}

          {chatError && (
            <ErrorBanner
              component="AI Chat"
              process="response stopped"
              detail={chatError}
              action={
                <div style={{ display: "flex", gap: 8 }}>
                  <Button size="sm" hierarchy="secondary" onClick={() => setChatError(null)}>Dismiss</Button>
                  <Button size="sm" hierarchy="secondary" onClick={goToSetup}>Switch provider</Button>
                </div>
              }
            />
          )}
        </div>

        {/* Footer: provenance notice */}
        <div style={{
          padding: "4px 16px 6px",
          fontSize: 11, color: "var(--text-quaternary)",
          borderTop: chatMessages.length > 0 ? "1px solid var(--border-tertiary)" : "none",
        }}>
          Verified numbers link to trace. Inferred figures are marked.
        </div>

        {/* Cloud egress notice (persistent, non-dismissable when cloud active) */}
        {isCloud && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 16px", background: "var(--error-50)",
            borderTop: "1px solid var(--error-100)",
            fontSize: 12, color: "var(--error-700)",
          }}>
            <AlertTriangle size={13} style={{ flexShrink: 0 }} />
            Messages and report metrics go to OpenRouter. Formulas and source keys stay local.
          </div>
        )}

        {/* Input area */}
        <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-secondary)" }}>
          {chatMessages.length === 0 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  style={{
                    fontSize: 12, padding: "4px 10px", border: "1px solid var(--border-secondary)",
                    borderRadius: "var(--radius-full)", background: "var(--color-white)",
                    color: "var(--text-secondary)", cursor: "pointer",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about this report..."
              rows={1}
              disabled={chatStreaming || isAgent}
              style={{
                flex: 1, resize: "none", fontFamily: "var(--font-sans)", fontSize: 14,
                padding: "9px 12px", borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-primary)", outline: "none",
                background: chatStreaming || isAgent ? "var(--gray-50)" : "var(--color-white)",
                color: "var(--text-primary)", lineHeight: 1.5,
                minHeight: 40, maxHeight: 120, overflowY: "auto",
              }}
            />
            <Button
              hierarchy="primary"
              size="md"
              disabled={chatStreaming || !input.trim() || isAgent}
              onClick={() => void send(input)}
            >
              Send
            </Button>
          </div>
          {chatMessages.length > 0 && (
            <button
              onClick={clearChatMessages}
              style={{ marginTop: 6, fontSize: 12, color: "var(--text-quaternary)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              Clear conversation
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Cmd+K affordance chip for the top bar ────────────────────────────────────

export function ChatAffordance() {
  const openChat = useApp((s) => s.openChat);
  return (
    <button
      onClick={openChat}
      aria-label="Open AI Chat (Cmd+K)"
      title="Ask about this report (Cmd+K)"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 10px", fontSize: 12, fontWeight: 500,
        border: "1px solid var(--border-secondary)",
        borderRadius: "var(--radius-badge)", background: "var(--color-white)",
        color: "var(--text-tertiary)", cursor: "pointer",
        boxShadow: "var(--shadow-xs)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--gray-50)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--color-white)"; }}
    >
      <MessageCircle size={13} />
      <span>⌘K</span>
    </button>
  );
}
