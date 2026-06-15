/**
 * chat/ChatShared.tsx
 *
 * Presentational components shared between ChatOverlay and (Phase 2) ChatPage.
 * No model logic here — all state comes from props or the parent's useChatEngine call.
 *
 * Exports:
 *   ProviderSwitcher   — dropdown to switch between ollama / openrouter / agent
 *   MetricChipEl       — inline verified/inferred metric chip
 *   AnswerText         — assistant text with inline metric chips
 */

import { useState, useEffect, useRef } from "react";
import { ExternalLink, Check } from "lucide-react";
import { useApp } from "../store";
import { getReportFromCache } from "../queries";
import { Badge, Button } from "../ui";
import { type ProviderKind } from "./providers";
import { parseAnswerSegments, type MetricChip } from "./context";

// ─── Ollama reachability probe ────────────────────────────────────────────────

type OllamaReach = "unknown" | "reachable" | "unreachable";

/**
 * Lightweight ping of the Ollama /api/tags endpoint.
 * Runs once when the chat surface mounts (or when the endpoint/provider changes).
 * Returns "unknown" on first render, then resolves to "reachable" or "unreachable".
 * Only probes when chatProvider === "ollama"; returns "unknown" otherwise.
 */
export function useOllamaReachability(): OllamaReach {
  const chatProvider = useApp((s) => s.chatProvider);
  const chatOllamaEndpoint = useApp((s) => s.chatOllamaEndpoint);
  const [reach, setReach] = useState<OllamaReach>("unknown");
  const lastEndpoint = useRef<string | null>(null);

  useEffect(() => {
    if (chatProvider !== "ollama") {
      setReach("unknown");
      return;
    }
    // Skip re-probe if the endpoint hasn't changed since last check.
    if (lastEndpoint.current === chatOllamaEndpoint && reach !== "unknown") return;

    let cancelled = false;
    setReach("unknown");

    const probe = async () => {
      try {
        const res = await fetch(`${chatOllamaEndpoint}/api/tags`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!cancelled) {
          lastEndpoint.current = chatOllamaEndpoint;
          setReach(res.ok ? "reachable" : "unreachable");
        }
      } catch {
        if (!cancelled) {
          lastEndpoint.current = chatOllamaEndpoint;
          setReach("unreachable");
        }
      }
    };

    void probe();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatProvider, chatOllamaEndpoint]);

  return reach;
}

// ─── Provider switcher dropdown ───────────────────────────────────────────────

interface ProviderSwitcherProps {
  onClose: () => void;
  onSetup: () => void;
}

export function ProviderSwitcher({ onClose, onSetup }: ProviderSwitcherProps) {
  const {
    chatProvider,
    setChatProvider,
    chatHasCloudKey,
    chatEgressConfirmedThisSession,
    setChatEgressConfirmed,
    chatOllamaModel,
    chatOpenRouterModel,
  } = useApp();

  const [pendingCloud, setPendingCloud] = useState(false);

  const switchTo = (kind: ProviderKind) => {
    if (kind === "openrouter") {
      if (!chatHasCloudKey) {
        onClose();
        onSetup();
        return;
      }
      if (!chatEgressConfirmedThisSession) {
        setPendingCloud(true);
        return;
      }
    }
    setChatProvider(kind);
    onClose();
  };

  const confirmCloud = () => {
    setChatEgressConfirmed(true);
    setChatProvider("openrouter");
    onClose();
  };

  const options: {
    kind: ProviderKind;
    title: string;
    sub: string;
    configured: boolean;
    modelLabel: string;
  }[] = [
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
        position: "absolute",
        top: "calc(100% + 6px)",
        left: 0,
        zIndex: 20,
        background: "var(--color-white)",
        border: "1px solid var(--border-secondary)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-lg)",
        minWidth: 280,
        overflow: "hidden",
      }}
    >
      {pendingCloud ? (
        <div style={{ padding: "14px 16px" }}>
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
              marginBottom: 14,
            }}
          >
            Your messages and the report metric values go to OpenRouter.
            Your formulas and source keys stay local.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button hierarchy="danger" size="sm" onClick={confirmCloud}>
              Send to cloud
            </Button>
            <Button
              hierarchy="secondary"
              size="sm"
              onClick={() => setPendingCloud(false)}
            >
              Cancel
            </Button>
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
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                padding: "10px 14px",
                textAlign: "left",
                border: "none",
                background: active ? "var(--surface-active)" : "transparent",
                cursor: "pointer",
                borderBottom: "1px solid var(--border-tertiary)",
              }}
              onMouseEnter={(e) => {
                if (!active)
                  e.currentTarget.style.background = "var(--surface-hover)";
              }}
              onMouseLeave={(e) => {
                if (!active)
                  e.currentTarget.style.background = active
                    ? "var(--surface-active)"
                    : "transparent";
              }}
            >
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  {o.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-tertiary)",
                    marginTop: 1,
                  }}
                >
                  {o.configured ? o.modelLabel : o.sub}
                </div>
              </div>
              {active && <Check size={15} color="var(--brand-600)" />}
              {!o.configured && (
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--blue-600)",
                    fontWeight: 500,
                  }}
                >
                  Set up
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}

// ─── Metric chip inline component ─────────────────────────────────────────────

export function MetricChipEl({ chip }: { chip: MetricChip }) {
  const openTrace = useApp((s) => s.openTrace);
  const bg = chip.verified ? "var(--blue-50)" : "var(--warning-50)";
  const tone = chip.verified ? "info" : "warning";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        background: bg,
        border: `1px solid ${chip.verified ? "var(--blue-100)" : "var(--warning-100)"}`,
        borderRadius: "var(--radius-sm)",
        padding: "1px 7px",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span style={{ fontWeight: 600 }}>{chip.name}</span>
      <span className="tnum">{chip.value}</span>
      <Badge tone={tone} dot={chip.verified}>
        {chip.verified ? "synced" : "inferred"}
      </Badge>
      <button
        onClick={() => openTrace(chip.reportId, chip.metricId)}
        aria-label={`Open trace for ${chip.name}`}
        title="Open trace"
        style={{
          display: "inline-flex",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          padding: 0,
          color: "var(--blue-600)",
        }}
      >
        <ExternalLink size={11} />
      </button>
    </span>
  );
}

// ─── Answer renderer: text with inline metric chips ───────────────────────────

export function AnswerText({
  content,
  reportId,
}: {
  content: string;
  reportId: string | null;
}) {
  const report = reportId ? getReportFromCache(reportId) : null;
  const metrics = report?.metrics ?? [];
  const segs = parseAnswerSegments(content, metrics, reportId ?? "");
  return (
    <span style={{ lineHeight: 1.6 }}>
      {segs.map((seg, i) =>
        seg.chip ? (
          <MetricChipEl key={i} chip={seg.chip} />
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </span>
  );
}
