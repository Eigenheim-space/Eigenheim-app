/**
 * chat/useChatEngine.ts
 *
 * Shared hook that owns the send/stream/abort loop, adapter selection,
 * message list, streaming flag, error state, and egress tracking.
 *
 * Both ChatOverlay and (Phase 2) ChatPage call this hook — neither
 * re-implements model logic.
 *
 * Egress gate (Privacy veto fix):
 * - send() refuses to call the cloud adapter if chatEgressConfirmedThisSession
 *   is false. The caller receives an "egress_required" signal and must surface
 *   the confirmation before retrying.
 * - chatEgressConfirmedThisSession is intentionally NOT persisted to disk.
 *   It resets on every app restart to ensure per-session disclosure.
 */

import { useCallback, useRef } from "react";
import { useApp } from "../store";
import { buildContextBlock } from "./context";
import {
  OpenRouterAdapter,
  OllamaAdapter,
  type ChatMessage,
} from "./providers";
import { chatSecrets } from "./chatSecrets";

export type EgressSignal = "egress_required" | null;

export interface ChatEngineResult {
  /** Current message list (user + assistant turns). */
  messages: ChatMessage[];
  /** Whether a stream is in flight. */
  streaming: boolean;
  /** Last error string, or null. */
  error: string | null;
  /** True when cloud (OpenRouter) is the active provider. */
  isCloud: boolean;
  /**
   * Send a user message. Returns "egress_required" if cloud is active and the
   * egress gate has not been confirmed this session — the caller must surface
   * the confirmation modal and retry after setChatEgressConfirmed(true).
   */
  send: (text: string) => Promise<EgressSignal>;
  /** Abort the in-flight stream and clear the empty placeholder. */
  stop: () => void;
  /** Clear all messages and the error. */
  clear: () => void;
  /** Confirm egress for this session (call after the user accepts the modal). */
  confirmEgress: () => void;
  /** Whether egress has been confirmed for this session. */
  egressConfirmed: boolean;
  /**
   * Replace the current message list with the provided messages.
   * Used by ChatPage to load a persisted conversation into the engine.
   * The overlay always starts with an empty list; only the page calls this.
   */
  loadMessages: (msgs: ChatMessage[]) => void;
}

export function useChatEngine(): ChatEngineResult {
  const {
    chatProvider,
    chatOllamaEndpoint,
    chatOllamaModel,
    chatOpenRouterModel,
    chatMessages,
    appendChatMessage,
    updateLastAssistantChunk,
    clearChatMessages,
    chatStreaming,
    setChatStreaming,
    chatError,
    setChatError,
    chatEgressConfirmedThisSession,
    setChatEgressConfirmed,
  } = useApp();

  const abortRef = useRef<AbortController | null>(null);

  const isCloud = chatProvider === "openrouter";

  const getAdapter = useCallback(async () => {
    if (isCloud) {
      const key = await chatSecrets.getKey();
      if (!key)
        throw new Error(
          "OpenRouter key not found. Go to Settings → AI Chat to add one."
        );
      return new OpenRouterAdapter({ apiKey: key, model: chatOpenRouterModel });
    }
    return new OllamaAdapter({
      endpoint: chatOllamaEndpoint,
      model: chatOllamaModel,
    });
  }, [isCloud, chatOpenRouterModel, chatOllamaEndpoint, chatOllamaModel]);

  const send = useCallback(
    async (text: string): Promise<EgressSignal> => {
      const trimmed = text.trim();
      if (!trimmed || chatStreaming) return null;

      // Belt-and-suspenders egress gate: refuse cloud call without per-session
      // confirmation. chatEgressConfirmedThisSession is intentionally NOT persisted
      // (persisting it would defeat the per-session disclosure requirement).
      if (isCloud && !chatEgressConfirmedThisSession) {
        return "egress_required";
      }

      setChatError(null);

      // Snapshot history BEFORE appending the new user message so the adapter
      // does not receive the same turn twice.
      const historySnapshot = useApp.getState().chatMessages;

      const userMsg: ChatMessage = { role: "user", content: trimmed };
      appendChatMessage(userMsg);

      const ctx = buildContextBlock();
      const systemMsg: ChatMessage = {
        role: "system",
        content: ctx
          ? `You are a product metrics assistant for eigenheim. The user has an open report with the following verified data:\n\n${ctx}\n\nCite these numbers exactly. Mark any figure you invent as inferred. Be direct and concise.`
          : "You are a product metrics assistant for eigenheim. No report is currently open. Answer based on general product management knowledge.",
      };

      const messages: ChatMessage[] = [systemMsg, ...historySnapshot, userMsg];

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setChatStreaming(true);
      // Prime an empty assistant slot for streaming
      appendChatMessage({ role: "assistant", content: "" });

      try {
        const adapter = await getAdapter();
        await adapter.chat(
          messages,
          (delta) => {
            if (signal.aborted) return;
            updateLastAssistantChunk(delta);
          },
          signal
        );
      } catch (e) {
        if (signal.aborted) {
          // Stream was cancelled; remove the empty placeholder
          useApp.setState((s) => ({
            chatMessages: s.chatMessages.slice(0, -1),
          }));
          return null;
        }
        const msg = e instanceof Error ? e.message : "Unknown error";
        setChatError(msg);
        // Remove the empty assistant placeholder
        useApp.setState((s) => ({
          chatMessages: s.chatMessages.slice(0, -1),
        }));
      } finally {
        if (!signal.aborted) setChatStreaming(false);
      }

      return null;
    },
    [
      chatStreaming,
      isCloud,
      chatEgressConfirmedThisSession,
      appendChatMessage,
      updateLastAssistantChunk,
      setChatStreaming,
      setChatError,
      getAdapter,
    ]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const clear = useCallback(() => {
    clearChatMessages();
  }, [clearChatMessages]);

  const confirmEgress = useCallback(() => {
    setChatEgressConfirmed(true);
  }, [setChatEgressConfirmed]);

  /**
   * Replace the Zustand message list with the provided array.
   * ChatPage calls this when the user selects a persisted conversation.
   * ChatOverlay never calls it — the overlay is always ephemeral.
   */
  const loadMessages = useCallback((msgs: ChatMessage[]) => {
    useApp.setState({ chatMessages: msgs, chatError: null });
  }, []);

  return {
    messages: chatMessages,
    streaming: chatStreaming,
    error: chatError,
    isCloud,
    send,
    stop,
    clear,
    confirmEgress,
    egressConfirmed: chatEgressConfirmedThisSession,
    loadMessages,
  };
}
