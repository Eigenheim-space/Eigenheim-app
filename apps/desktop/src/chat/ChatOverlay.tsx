/**
 * chat/ChatOverlay.tsx
 *
 * Cmd+K overlay: centered command-bar floating above any view.
 * LIGHT aesthetic: white surface, --radius-2xl, 1px border, soft shadow.
 * Flat scrim rgba(0,0,0,0.35) — NO backdrop blur.
 * prefers-reduced-motion: no scale/fade animation, instant appear/disappear.
 *
 * Model logic lives in useChatEngine (chat/useChatEngine.ts).
 * Presentational pieces live in ChatShared (chat/ChatShared.tsx).
 * Context builder and segment parser live in chat/context.ts.
 * This file is the overlay frame only.
 */

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { X, AlertTriangle, ChevronDown } from "lucide-react";
import { useApp } from "../store";
import { Badge, Button, ErrorBanner, IconButton } from "../ui";
import { useChatEngine } from "./useChatEngine";
import { ProviderSwitcher, AnswerText, useOllamaReachability } from "./ChatShared";

// ─── Suggestion chips ─────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "What drove activation last week?",
  "Compare the metric trend over time.",
  "What's the biggest gap in this report?",
];

// ─── Main overlay ─────────────────────────────────────────────────────────────

export function ChatOverlay() {
  const {
    chatOpen,
    closeChat,
    chatProvider,
    chatOllamaModel,
    openReportId,
    goSettings,
    setSettingsSection,
  } = useApp();

  const engine = useChatEngine();

  const [input, setInput] = useState("");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // When send() returns "egress_required", show the inline cloud disclosure.
  const [egressPending, setEgressPending] = useState(false);
  const [pendingText, setPendingText] = useState("");

  const responseRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);

  const isCloud = engine.isCloud;
  const isAgent = engine.isAgent;
  const ollamaReach = useOllamaReachability();

  // Abort in-flight stream on overlay unmount
  useEffect(() => {
    return () => {
      engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (responseRef.current)
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
  }, [engine.messages, engine.streaming]);

  // Focus input when overlay opens
  useEffect(() => {
    if (chatOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [chatOpen]);

  const handleCloseChat = useCallback(() => {
    engine.stop();
    closeChat();
    setSwitcherOpen(false);
    setEgressPending(false);
    setPendingText("");
  }, [closeChat, engine]);

  // Close on Escape
  useEffect(() => {
    if (!chatOpen) return;
    const h = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") handleCloseChat();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [chatOpen, handleCloseChat]);

  const goToSetup = () => {
    handleCloseChat();
    setSettingsSection("aichat");
    goSettings();
  };

  const trySend = useCallback(
    async (text: string) => {
      const signal = await engine.send(text);
      if (signal === "egress_required") {
        setPendingText(text);
        setEgressPending(true);
        return;
      }
      setInput("");
    },
    [engine]
  );

  const confirmEgressAndSend = useCallback(async () => {
    engine.confirmEgress();
    setEgressPending(false);
    const signal = await engine.send(pendingText);
    if (!signal) {
      setInput("");
      setPendingText("");
    }
  }, [engine, pendingText]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void trySend(input);
    }
  };

  if (!chatOpen) return null;

  return (
    <>
      {/* Flat scrim — no backdrop blur */}
      <div
        onClick={handleCloseChat}
        className="eh-chat-scrim"
        style={{
          position: "fixed",
          inset: 0,
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px",
            borderBottom: "1px solid var(--border-secondary)",
            position: "relative",
          }}
        >
          <div ref={switcherRef} style={{ position: "relative" }}>
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
              ) : ollamaReach === "unreachable" ? (
                <Badge tone="danger">Local · not connected</Badge>
              ) : ollamaReach === "model-missing" ? (
                <Badge tone="warning">Local · {chatOllamaModel} · not installed</Badge>
              ) : (
                <Badge tone="info" dot={ollamaReach === "reachable"}>
                  Local · {chatOllamaModel}
                </Badge>
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
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
            minHeight: 80,
          }}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
        >
          {engine.messages.length === 0 && !engine.error && (
            <div
              style={{
                color: "var(--text-quaternary)",
                fontSize: 13,
                textAlign: "center",
                padding: "16px 0",
              }}
            >
              {isAgent
                ? "External agent mode. Use your desktop agent over MCP — eigenheim does not route messages from here."
                : !isCloud && ollamaReach === "unreachable"
                ? "Ollama is not running. Start it locally, or switch to a different provider in Settings → AI Chat."
                : !isCloud && ollamaReach === "model-missing"
                ? `Model "${chatOllamaModel}" isn't pulled. Run: ollama pull ${chatOllamaModel}`
                : openReportId
                ? "Ask about this report's metrics, trends, or cohorts."
                : "No report open. Ask a product question or open a report first."}
            </div>
          )}

          {engine.messages.map((m, i) => (
            <div
              key={m.id ?? i}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                alignItems: m.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              {m.role === "user" ? (
                <div
                  style={{
                    background: "var(--gray-100)",
                    borderRadius: "var(--radius-lg)",
                    padding: "8px 12px",
                    maxWidth: "85%",
                    fontSize: 14,
                    color: "var(--text-primary)",
                    lineHeight: 1.55,
                  }}
                >
                  {m.content}
                </div>
              ) : (
                <div
                  style={{
                    maxWidth: "100%",
                    fontSize: 14,
                    color: "var(--text-primary)",
                  }}
                >
                  {m.content ? (
                    <AnswerText content={m.content} reportId={openReportId} />
                  ) : (
                    engine.streaming &&
                    i === engine.messages.length - 1 && (
                      <span
                        style={{
                          color: "var(--text-quaternary)",
                          fontSize: 13,
                        }}
                      >
                        …
                      </span>
                    )
                  )}
                </div>
              )}
            </div>
          ))}

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
                  <Button
                    size="sm"
                    hierarchy="secondary"
                    onClick={goToSetup}
                  >
                    Switch provider
                  </Button>
                </div>
              }
            />
          )}
        </div>

        {/* Footer: provenance notice */}
        <div
          style={{
            padding: "4px 16px 6px",
            fontSize: 11,
            color: "var(--text-quaternary)",
            borderTop:
              engine.messages.length > 0
                ? "1px solid var(--border-tertiary)"
                : "none",
          }}
        >
          Verified numbers link to trace. Inferred figures are marked.
        </div>

        {/* Cloud egress notice (persistent, non-dismissable when cloud active) */}
        {isCloud && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 16px",
              background: "var(--error-50)",
              borderTop: "1px solid var(--error-100)",
              fontSize: 12,
              color: "var(--error-700)",
            }}
          >
            <AlertTriangle size={13} style={{ flexShrink: 0 }} />
            Messages and report metrics go to OpenRouter. Formulas and source
            keys stay local.
          </div>
        )}

        {/* Egress confirmation (shown when send() returned "egress_required") */}
        {egressPending && (
          <div
            style={{
              padding: "12px 16px",
              background: "var(--error-50)",
              borderTop: "1px solid var(--error-100)",
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--error-700)",
                marginBottom: 6,
              }}
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
              Your messages and the report metric values go to OpenRouter.
              Your formulas and source keys stay local.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                hierarchy="danger"
                size="sm"
                onClick={() => void confirmEgressAndSend()}
              >
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

        {/* Input area */}
        <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-secondary)" }}>
          {engine.messages.length === 0 && (
            <div
              style={{
                display: "flex",
                gap: 6,
                marginBottom: 8,
                flexWrap: "wrap",
              }}
            >
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void trySend(s)}
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    border: "1px solid var(--border-secondary)",
                    borderRadius: "var(--radius-full)",
                    background: "var(--color-white)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--gray-50)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--color-white)";
                  }}
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
              disabled={engine.streaming || isAgent}
              style={{
                flex: 1,
                resize: "none",
                fontFamily: "var(--font-sans)",
                fontSize: 14,
                padding: "9px 12px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border-primary)",
                outline: "none",
                background:
                  engine.streaming || isAgent
                    ? "var(--gray-50)"
                    : "var(--color-white)",
                color: "var(--text-primary)",
                lineHeight: 1.5,
                minHeight: 40,
                maxHeight: 120,
                overflowY: "auto",
              }}
            />
            <Button
              hierarchy="primary"
              size="md"
              disabled={engine.streaming || !input.trim() || isAgent}
              onClick={() => void trySend(input)}
            >
              Send
            </Button>
          </div>
          {engine.messages.length > 0 && (
            <button
              onClick={engine.clear}
              style={{
                marginTop: 6,
                fontSize: 12,
                color: "var(--text-quaternary)",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Clear conversation
            </button>
          )}
        </div>
      </div>
    </>
  );
}

