/** Talks to any OpenAI-compatible chat endpoint (Groq by default). Used by the API route and the evals. */
import type { ChatMessage, ModelReply } from "./run";
import { SYSTEM_PROMPT, TOOL_SPECS } from "./tools";

export interface ProviderConfig { apiKey: string; baseUrl: string; model: string }

export function configFromEnv(env: Record<string, string | undefined>): ProviderConfig | null {
  const apiKey = env.LLM_API_KEY || env.GROQ_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
    model: env.LLM_MODEL || "llama-3.3-70b-versatile",
  };
}

export async function callProvider(messages: ChatMessage[], cfg: ProviderConfig, signal?: AbortSignal): Promise<ModelReply> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model, temperature: 0, max_tokens: 500, tools: TOOL_SPECS, tool_choice: "auto",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Language model request failed (${res.status}). ${detail}`);
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error("Language model returned an empty response.");
  const toolCalls = (message.tool_calls ?? [])
    .filter((c: { type?: string }) => !c.type || c.type === "function")
    .map((c: { id: string; function: { name: string; arguments: string } }) => ({
      id: c.id, name: c.function.name, arguments: c.function.arguments ?? "{}",
    }));
  return { content: typeof message.content === "string" ? message.content : null, toolCalls };
}
