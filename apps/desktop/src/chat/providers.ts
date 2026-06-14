/**
 * chat/providers.ts
 *
 * Dumb adapter layer for the Cmd+K overlay. The engine never imports this.
 * One interface, three adapters:
 *   A — OpenRouter (cloud, BYO key, data egress)
 *   B — Ollama    (local, fully on-machine)
 *   C — External agent (informational only, no in-app model call)
 *
 * Adapters are intentionally minimal: one async method, no retry logic,
 * no streaming middleware, no tool routing.
 */

export type ProviderKind = "openrouter" | "ollama" | "agent";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Stable React key. Assigned on append in the store; absent on system messages. */
  id?: string;
}

/**
 * Single interface every adapter must satisfy.
 * Returns the full assistant text (streaming is handled inside the adapter
 * by reading the SSE/NDJSON response and calling onChunk for each token).
 */
export interface ChatProvider {
  kind: ProviderKind;
  /** Display label, e.g. "OpenRouter · claude-3-haiku" */
  label: string;
  /**
   * Send a chat request. onChunk is called for each streamed token
   * so the UI can render incrementally. Returns the full accumulated text.
   * Throws on network/auth errors so the overlay can display ErrorBanner.
   * Pass signal to abort the in-flight stream when the overlay closes.
   */
  chat(messages: ChatMessage[], onChunk?: (delta: string) => void, signal?: AbortSignal): Promise<string>;
}

// ─── A: OpenRouter adapter ────────────────────────────────────────────────────

export interface OpenRouterConfig {
  apiKey: string;        // from safeStorage — never stored in JS state beyond this call
  model: string;         // e.g. "anthropic/claude-3-haiku"
}

export class OpenRouterAdapter implements ChatProvider {
  kind: ProviderKind = "openrouter";
  label: string;
  private cfg: OpenRouterConfig;

  constructor(cfg: OpenRouterConfig) {
    this.cfg = cfg;
    this.label = `OpenRouter · ${cfg.model}`;
  }

  async chat(messages: ChatMessage[], onChunk?: (delta: string) => void, signal?: AbortSignal): Promise<string> {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "HTTP-Referer": "app://eigenheim",
        "X-Title": "eigenheim",
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        stream: true,
      }),
    });

    if (!res.ok) {
      let detail = `${res.status}`;
      try { detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? detail; } catch { /* ignore */ }
      throw new Error(`OpenRouter: ${detail}`);
    }

    // Read SSE stream
    const reader = res.body?.getReader();
    if (!reader) throw new Error("OpenRouter: no response body");
    const decoder = new TextDecoder();
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") break;
        try {
          const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
          const token = parsed.choices?.[0]?.delta?.content ?? "";
          if (token) {
            accumulated += token;
            onChunk?.(token);
          }
        } catch { /* malformed SSE line, skip */ }
      }
    }

    return accumulated;
  }
}

// ─── B: Ollama adapter ────────────────────────────────────────────────────────

export interface OllamaConfig {
  endpoint: string; // e.g. "http://localhost:11434"
  model: string;    // e.g. "mistral"
}

export class OllamaAdapter implements ChatProvider {
  kind: ProviderKind = "ollama";
  label: string;
  private cfg: OllamaConfig;

  constructor(cfg: OllamaConfig) {
    this.cfg = cfg;
    this.label = `Local · ${cfg.model}`;
  }

  async chat(messages: ChatMessage[], onChunk?: (delta: string) => void, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.cfg.endpoint}/api/chat`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.cfg.model, messages, stream: true }),
    });

    if (!res.ok) {
      throw new Error(`Ollama did not respond at ${this.cfg.endpoint} (${res.status})`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error(`Ollama: no response body at ${this.cfg.endpoint}`);
    const decoder = new TextDecoder();
    let accumulated = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          const token = parsed.message?.content ?? "";
          if (token) {
            accumulated += token;
            onChunk?.(token);
          }
          if (parsed.done) break;
        } catch { /* partial NDJSON, skip */ }
      }
    }

    return accumulated;
  }
}

// ─── C: External agent (informational, no in-app model call) ─────────────────

/**
 * The user's own desktop agent reads eigenheim via MCP.
 * This adapter is a no-op: it informs the user to use their agent directly.
 * No HTTP request is made from eigenheim to any LLM.
 */
export class AgentAdapter implements ChatProvider {
  kind: ProviderKind = "agent";
  label = "Agent · MCP";

  chat(_messages: ChatMessage[], _onChunk?: (delta: string) => void, _signal?: AbortSignal): Promise<string> {
    return Promise.reject(
      new Error(
        "External agent mode: use your desktop agent to talk to eigenheim over MCP. " +
        "eigenheim does not route messages to your agent from this chat."
      )
    );
  }
}

// ─── Helper: detect Ollama models ────────────────────────────────────────────

export async function detectOllamaModels(endpoint: string): Promise<string[]> {
  const res = await fetch(`${endpoint}/api/tags`);
  if (!res.ok) throw new Error(`Ollama did not respond at ${endpoint} (${res.status})`);
  const data = await res.json() as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}

// ─── Helper: test OpenRouter key ─────────────────────────────────────────────

export async function testOpenRouterKey(apiKey: string): Promise<{ ok: boolean; models: string[] }> {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter key rejected (${res.status})`);
  const data = await res.json() as { data?: { id: string }[] };
  const models = (data.data ?? []).map((m) => m.id).slice(0, 40);
  return { ok: true, models };
}
