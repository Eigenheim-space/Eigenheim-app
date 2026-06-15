/**
 * chat/ChatPage.tsx
 *
 * Full-page persistent chat — Phase 2.
 * 3-column layout: history sidebar + conversation + composer.
 *
 * Architecture:
 *   - Reuses useChatEngine for all send/stream/egress logic (NO duplicated model code).
 *   - Reuses ProviderSwitcher, MetricChipEl, AnswerText from ChatShared.
 *   - The overlay (ChatOverlay) stays ephemeral (in-memory). Only this page persists.
 *   - Persistence lives in engine/api/chat.py — LOCAL SQLite, never synced.
 *   - loadMessages() seam: when the user selects a conversation the persisted
 *     messages are hydrated into the shared Zustand list via useChatEngine.loadMessages.
 *
 * Dropped from the prototype (per spec): mic, file-attach, context-window meter,
 * permission pill, queued-message list. None are rendered, even disabled.
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
} from "react";
import {
  Plus,
  MessageCircle,
  ChevronDown,
  AlertTriangle,
  ChevronDown as ChevronDownSm,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useApp } from "../store";
import { Badge, Button, ErrorBanner, IconButton } from "../ui";
import { useChatEngine } from "./useChatEngine";
import { ProviderSwitcher, AnswerText } from "./ChatShared";
import { chatApi, type ConversationListItem, type ConversationMessage } from "../api";
import type { ChatMessage } from "./providers";

// ─── Prompt suggestions (shown when the thread is empty) ──────────────────────

const SUGGESTIONS = [
  "What drove activation last week?",
  "Compare the metric trend over time.",
  "What's the biggest gap in this report?",
];

// ─── Date grouping helper ─────────────────────────────────────────────────────

function groupConversations(
  convs: ConversationListItem[]
): { label: string; items: ConversationListItem[] }[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);

  const today: ConversationListItem[] = [];
  const yesterday: ConversationListItem[] = [];
  const earlier: ConversationListItem[] = [];

  for (const c of convs) {
    const d = new Date(c.updated_at);
    if (d >= todayStart) today.push(c);
    else if (d >= yesterdayStart) yesterday.push(c);
    else earlier.push(c);
  }

  const groups: { label: string; items: ConversationListItem[] }[] = [];
  if (today.length) groups.push({ label: "Today", items: today });
  if (yesterday.length) groups.push({ label: "Yesterday", items: yesterday });
  if (earlier.length) groups.push({ label: "Earlier", items: earlier });
  return groups;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ChatPage() {
  const {
    chatProvider,
    chatOllamaModel,
    openReportId,
    goSettings,
    setSettingsSection,
  } = useApp();

  const engine = useChatEngine();
  const qc = useQueryClient();

  // Active conversation id (null = no conversation selected yet)
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [egressPending, setEgressPending] = useState(false);
  const [pendingText, setPendingText] = useState("");
  const [persistingIds, setPersistingIds] = useState<Set<number>>(new Set());

  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const isCloud = engine.isCloud;
  const isAgent = engine.isAgent;

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: conversations = [] } = useQuery({
    queryKey: ["chat-conversations"],
    queryFn: () => chatApi.listConversations(),
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const goToSetup = useCallback(() => {
    setSettingsSection("aichat");
    goSettings();
  }, [goSettings, setSettingsSection]);

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

  // Pin scroll to bottom when new messages arrive (auto-scroll while near bottom)
  useEffect(() => {
    if (!autoScrollRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [engine.messages, engine.streaming]);

  const onThreadScroll = () => {
    if (!threadRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = threadRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 80;
  };

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Focus input when a conversation is loaded
  useEffect(() => {
    if (activeConvId) inputRef.current?.focus();
  }, [activeConvId]);

  // ── Conversation selection ─────────────────────────────────────────────────

  const loadConversation = useCallback(
    async (convId: string) => {
      const detail = await chatApi.getConversation(convId);
      // Map persisted messages to ChatMessage shape (strip system messages)
      const msgs: ChatMessage[] = detail.messages
        .filter((m: ConversationMessage) => m.role === "user" || m.role === "assistant")
        .map((m: ConversationMessage) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          id: String(m.id),
        }));
      engine.loadMessages(msgs);
      setActiveConvId(convId);
      autoScrollRef.current = true;
    },
    [engine]
  );

  // ── Persistence mutations ──────────────────────────────────────────────────

  const createConvMutation = useMutation({
    mutationFn: (title: string) => chatApi.createConversation(title),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat-conversations"] }),
  });

  const appendMsgMutation = useMutation({
    mutationFn: ({
      convId,
      role,
      content,
    }: {
      convId: string;
      role: "user" | "assistant";
      content: string;
    }) => chatApi.appendMessage(convId, role, content),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chat-conversations"] }),
  });

  // ── New chat ───────────────────────────────────────────────────────────────

  const startNewChat = useCallback(() => {
    engine.clear();
    setActiveConvId(null);
    setInput("");
    setEgressPending(false);
    setPendingText("");
    autoScrollRef.current = true;
    setTimeout(() => inputRef.current?.focus(), 40);
  }, [engine]);

  // ── Send ───────────────────────────────────────────────────────────────────

  const persistTurn = useCallback(
    async (convId: string, userText: string, assistantText: string) => {
      await appendMsgMutation.mutateAsync({ convId, role: "user", content: userText });
      await appendMsgMutation.mutateAsync({ convId, role: "assistant", content: assistantText });
    },
    [appendMsgMutation]
  );

  const trySend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Egress gate — surface confirmation before the engine call
      if (isCloud && !engine.egressConfirmed) {
        setPendingText(trimmed);
        setEgressPending(true);
        return;
      }

      setInput("");
      autoScrollRef.current = true;

      // Auto-create conversation on first send
      let convId = activeConvId;
      if (!convId) {
        const title = trimmed.slice(0, 60) + (trimmed.length > 60 ? "…" : "");
        const newConv = await createConvMutation.mutateAsync(title);
        convId = newConv.id;
        setActiveConvId(convId);
      }

      // Snapshot message count before send so we can identify the new assistant msg
      const beforeCount = engine.messages.length;

      const signal = await engine.send(trimmed);
      if (signal === "egress_required") {
        setPendingText(trimmed);
        setEgressPending(true);
        return;
      }

      // Wait for streaming to finish, then persist both turns.
      // We poll in a tight loop because we're inside an async callback, not a hook.
      const waitForStream = () =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (!useApp.getState().chatStreaming) {
              resolve();
            } else {
              requestAnimationFrame(check);
            }
          };
          check();
        });

      await waitForStream();

      // Find the newly added assistant message (last in list after the user turn)
      const msgs = useApp.getState().chatMessages;
      const userMsg = msgs[beforeCount];
      const assistantMsg = msgs[msgs.length - 1];
      if (
        userMsg?.role === "user" &&
        assistantMsg?.role === "assistant" &&
        assistantMsg.content &&
        convId
      ) {
        const msgIdx = beforeCount; // index marker, not used for dedup — use a Set to avoid double-persist
        void persistTurn(convId, userMsg.content, assistantMsg.content).catch(() => {
          // Persistence failure is non-fatal — the in-memory session is intact.
        });
        setPersistingIds((s) => {
          const n = new Set(s);
          n.delete(msgIdx);
          return n;
        });
      }
    },
    [
      isCloud,
      engine,
      activeConvId,
      createConvMutation,
      persistTurn,
    ]
  );

  const confirmEgressAndSend = useCallback(async () => {
    engine.confirmEgress();
    setEgressPending(false);
    const text = pendingText;
    setPendingText("");
    await trySend(text);
  }, [engine, pendingText, trySend]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void trySend(input);
    }
  };

  // ── Conversation title (for header) ───────────────────────────────────────

  const activeTitle =
    conversations.find((c) => c.id === activeConvId)?.title ?? "New chat";

  // ── Grouped sidebar items ─────────────────────────────────────────────────

  const groups = groupConversations(conversations);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        background: "var(--surface-secondary)",
      }}
    >
      {/* ── History sidebar ─────────────────────────────────────────────── */}
      <div
        style={{
          width: 260,
          flexShrink: 0,
          borderRight: "1px solid var(--border-secondary)",
          background: "var(--surface-primary)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {/* New chat button */}
        <div style={{ padding: "14px 14px 10px" }}>
          <button
            onClick={startNewChat}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              width: "100%",
              height: 40,
              border: "1px solid var(--border-primary)",
              background: "var(--surface-primary)",
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              color: "var(--text-secondary)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 600,
              boxShadow: "var(--shadow-xs)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--surface-hover)";
              e.currentTarget.style.borderColor = "var(--border-brand)";
              e.currentTarget.style.color = "var(--text-brand-secondary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--surface-primary)";
              e.currentTarget.style.borderColor = "var(--border-primary)";
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            <Plus size={15} />
            New chat
          </button>
        </div>

        {/* Conversation list */}
        <div
          className="eh-scroll"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "2px 8px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 0,
          }}
        >
          {groups.length === 0 && (
            <div
              style={{
                padding: "16px 8px",
                fontSize: 13,
                color: "var(--text-quaternary)",
                textAlign: "center",
              }}
            >
              No conversations yet.
              <br />
              Start one below.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-quaternary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  padding: "6px 8px 4px",
                }}
              >
                {g.label}
              </span>
              {g.items.map((c) => {
                const isActive = c.id === activeConvId;
                return (
                  <button
                    key={c.id}
                    onClick={() => void loadConversation(c.id)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                      padding: "9px 10px",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      borderRadius: "var(--radius-md)",
                      background: isActive ? "var(--surface-active)" : "transparent",
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive)
                        e.currentTarget.style.background = "var(--surface-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive)
                        e.currentTarget.style.background = "transparent";
                    }}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        minWidth: 0,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: "50%",
                          background: isActive
                            ? "var(--brand-500)"
                            : "var(--gray-300)",
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: isActive
                            ? "var(--text-primary)"
                            : "var(--text-secondary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.title}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* ── Conversation + composer ──────────────────────────────────────── */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          minHeight: 0,
          background: "var(--surface-secondary)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "13px 24px",
            borderBottom: "1px solid var(--border-secondary)",
            background: "var(--surface-primary)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 5,
              minWidth: 0,
              flex: 1,
            }}
          >
            <span
              style={{
                fontSize: 15,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {activeTitle}
            </span>
            {/* Scope chip */}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 22,
                padding: "0 7px",
                background: "var(--gray-50)",
                border: "1px solid var(--border-secondary)",
                borderRadius: "var(--radius-full)",
                alignSelf: "flex-start",
              }}
              title="Grounded on your whole eigenheim workspace — reports, metrics, events and formulas."
            >
              <MessageCircle size={11} color="var(--text-tertiary)" />
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-tertiary)" }}>
                All of eigenheim
              </span>
            </span>
          </div>

          {/* Provider badge + dropdown */}
          <div ref={switcherRef} style={{ position: "relative", flexShrink: 0 }}>
            <button
              onClick={() => setSwitcherOpen((v) => !v)}
              aria-label="Switch provider"
              aria-expanded={switcherOpen}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
              }}
            >
              {isCloud ? (
                <Badge tone="danger">Cloud: OpenRouter</Badge>
              ) : isAgent ? (
                <Badge tone="neutral">Agent · MCP</Badge>
              ) : (
                <Badge tone="info" dot>
                  Local · {chatOllamaModel}
                </Badge>
              )}
              <ChevronDownSm size={13} color="var(--text-tertiary)" />
            </button>
            {switcherOpen && (
              <ProviderSwitcher
                onClose={() => setSwitcherOpen(false)}
                onSetup={goToSetup}
              />
            )}
          </div>
        </div>

        {/* Thread */}
        <div
          ref={threadRef}
          onScroll={onThreadScroll}
          className="eh-scroll"
          style={{
            flex: 1,
            overflowY: "auto",
            minHeight: 0,
            padding: "26px 0",
          }}
        >
          <div
            style={{
              maxWidth: 720,
              margin: "0 auto",
              padding: "0 28px",
              display: "flex",
              flexDirection: "column",
              gap: 24,
            }}
          >
            {/* Empty state */}
            {engine.messages.length === 0 && !engine.streaming && !engine.error && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 10,
                  padding: "48px 0 16px",
                }}
              >
                <MessageCircle size={40} color="var(--brand-300)" strokeWidth={1.5} />
                <span style={{ fontSize: 16, fontWeight: 600 }}>
                  Ask about anything in eigenheim
                </span>
                <span
                  style={{
                    fontSize: 13,
                    lineHeight: 1.55,
                    color: "var(--text-tertiary)",
                    textAlign: "center",
                    maxWidth: 420,
                  }}
                >
                  Reports, metrics, events, formulas — the chat reads your verified
                  numbers over MCP and links every cited figure to its trace receipt.
                </span>
              </div>
            )}

            {/* Message bubbles */}
            {engine.messages.map((m, i) => {
              if (m.role === "user") {
                return (
                  <div key={m.id ?? i} style={{ display: "flex", justifyContent: "flex-end" }}>
                    <div
                      style={{
                        maxWidth: "78%",
                        background: "var(--brand-600)",
                        color: "#fff",
                        borderRadius: "16px 16px 4px 16px",
                        padding: "10px 14px",
                        fontSize: 15,
                        lineHeight: "22px",
                      }}
                    >
                      {m.content}
                    </div>
                  </div>
                );
              }
              // Assistant message
              return (
                <div key={m.id ?? i} style={{ display: "flex", gap: 12 }}>
                  {/* Assistant avatar */}
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      flexShrink: 0,
                      borderRadius: "var(--radius-full)",
                      background: "var(--brand-50)",
                      border: "1px solid var(--brand-200)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginTop: 2,
                    }}
                  >
                    <MessageCircle size={13} color="var(--brand-600)" />
                  </span>
                  <div
                    style={{
                      fontSize: 15,
                      lineHeight: "27px",
                      color: "var(--text-primary)",
                      minWidth: 0,
                    }}
                  >
                    {m.content ? (
                      <AnswerText content={m.content} reportId={openReportId} />
                    ) : (
                      engine.streaming && i === engine.messages.length - 1 && (
                        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: "var(--brand-400)",
                              animation: "eh-pulse 1.2s ease-in-out 0s infinite",
                            }}
                          />
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: "var(--brand-400)",
                              animation: "eh-pulse 1.2s ease-in-out 0.18s infinite",
                            }}
                          />
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: "50%",
                              background: "var(--brand-400)",
                              animation: "eh-pulse 1.2s ease-in-out 0.36s infinite",
                            }}
                          />
                        </span>
                      )
                    )}
                  </div>
                </div>
              );
            })}

            {/* Error banner */}
            {engine.error && (
              <ErrorBanner
                component="AI Chat"
                process="response stopped"
                detail={engine.error}
                action={
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button
                      size="sm"
                      hierarchy="secondary"
                      onClick={() => useApp.getState().setChatError(null)}
                    >
                      Dismiss
                    </Button>
                    <Button size="sm" hierarchy="secondary" onClick={goToSetup}>
                      Switch provider
                    </Button>
                  </div>
                }
              />
            )}

            {/* Scroll anchor */}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Boundary footer — always present, never dismissable */}
        <div
          style={{
            textAlign: "center",
            fontSize: 11,
            color: "var(--text-quaternary)",
            padding: "4px 0 2px",
            background: "var(--surface-secondary)",
          }}
        >
          Verified numbers link to trace. Inferred figures are marked.
        </div>

        {/* Persistent cloud egress notice */}
        {isCloud && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 28px",
              background: "var(--error-50)",
              borderTop: "1px solid var(--error-100)",
              fontSize: 12,
              color: "var(--error-700)",
            }}
          >
            <AlertTriangle size={13} style={{ flexShrink: 0 }} />
            Messages and report metrics go to OpenRouter. Formulas and source keys
            stay local.
          </div>
        )}

        {/* Egress confirmation */}
        {egressPending && (
          <div
            style={{
              padding: "12px 28px",
              background: "var(--error-50)",
              borderTop: "1px solid var(--error-100)",
            }}
          >
            <div
              style={{ fontSize: 13, fontWeight: 600, color: "var(--error-700)", marginBottom: 6 }}
            >
              Data leaves your machine
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              Your messages and the report metric values go to OpenRouter. Your
              formulas and source keys stay local.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button hierarchy="danger" size="sm" onClick={() => void confirmEgressAndSend()}>
                Send to cloud
              </Button>
              <Button
                hierarchy="secondary"
                size="sm"
                onClick={() => {
                  setEgressPending(false);
                  setPendingText("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Composer */}
        <div
          style={{
            borderTop: "1px solid var(--border-secondary)",
            background: "var(--surface-primary)",
            padding: "12px 0 14px",
          }}
        >
          <div
            style={{
              maxWidth: 760,
              margin: "0 auto",
              padding: "0 28px",
              display: "flex",
              flexDirection: "column",
              gap: 9,
            }}
          >
            {/* Prompt suggestion chips (only when thread is empty) */}
            {engine.messages.length === 0 && !input && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void trySend(s)}
                    style={{
                      fontSize: 12,
                      padding: "5px 11px",
                      border: "1px solid var(--border-secondary)",
                      borderRadius: "var(--radius-full)",
                      background: "var(--color-white)",
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "var(--surface-hover)";
                      e.currentTarget.style.borderColor = "var(--border-brand)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "var(--color-white)";
                      e.currentTarget.style.borderColor = "var(--border-secondary)";
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {/* Composer card */}
            <div
              style={{
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-xl)",
                background: "var(--surface-primary)",
                boxShadow: "var(--shadow-xs)",
              }}
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask about eigenheim..."
                rows={1}
                disabled={engine.streaming || isAgent}
                className="eh-chat-input"
                style={{
                  display: "block",
                  width: "100%",
                  resize: "none",
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  padding: "14px 16px 4px",
                  fontFamily: "var(--font-sans)",
                  fontSize: 15,
                  lineHeight: "22px",
                  color: "var(--text-primary)",
                  maxHeight: 160,
                  overflowY: "auto",
                  boxSizing: "border-box",
                }}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  padding: "4px 8px 8px",
                }}
              >
                <Button
                  hierarchy="primary"
                  size="sm"
                  disabled={engine.streaming || !input.trim() || isAgent}
                  onClick={() => void trySend(input)}
                >
                  Send
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
