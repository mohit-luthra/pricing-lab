/**
 * Abuse limits for the assistant endpoint. Pure functions with the clock and network injected,
 * so every rule here is unit-tested.
 *
 * Three layers:
 *   1. Request shape: one short question, a known category, a few short turns of history.
 *   2. Per-visitor rate limit.
 *   3. A daily budget for the whole site.
 * Layers 2 and 3 are shared across servers when Upstash Redis is configured; otherwise they
 * fall back to this server's memory, which Vercel resets whenever the function restarts.
 */
import type { ChatMessage } from "./run";

export const LIMITS = {
  questionChars: 400,
  historyTurns: 3,            // question + answer pairs
  historyChars: 900,          // per message
  perMinute: 6,               // per visitor
  perDay: 40,                 // per visitor
  dailyBudget: 300,           // whole site, overridable with ASK_DAILY_LIMIT
};

export const CATEGORY_CODES = ["tna", "bjc", "lnd", "sdr"] as const;
export type CategoryCode = (typeof CATEGORY_CODES)[number];

export interface AskRequest { code: CategoryCode; question: string; history: ChatMessage[] }

/** Returns the cleaned request, or a message saying what is wrong with it. */
export function parseRequest(body: unknown): AskRequest | string {
  if (!body || typeof body !== "object") return "Request body must be a JSON object.";
  const { code, question, history } = body as Record<string, unknown>;
  if (typeof code !== "string" || !CATEGORY_CODES.includes(code as CategoryCode)) return "Unknown category.";
  if (typeof question !== "string" || !question.trim()) return "Ask a question first.";
  if (question.length > LIMITS.questionChars) return `Questions are limited to ${LIMITS.questionChars} characters.`;
  const turns: ChatMessage[] = [];
  if (history !== undefined) {
    if (!Array.isArray(history)) return "History must be a list.";
    for (const m of history.slice(-2 * LIMITS.historyTurns)) {
      const role = (m as ChatMessage)?.role, content = (m as ChatMessage)?.content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") return "History is malformed.";
      turns.push({ role, content: content.slice(0, LIMITS.historyChars) });
    }
  }
  return { code: code as CategoryCode, question: question.trim(), history: turns };
}

export type Verdict = { ok: true } | { ok: false; reason: "minute" | "day" | "budget"; message: string };

const MESSAGES = {
  minute: "Too many questions in a minute. Wait a moment and ask again.",
  day: "You have reached today's limit for questions. Try again tomorrow.",
  budget: "The assistant has reached today's limit. Try again tomorrow.",
};

function decide(minute: number, day: number, site: number, budget: number): Verdict {
  if (minute > LIMITS.perMinute) return { ok: false, reason: "minute", message: MESSAGES.minute };
  if (day > LIMITS.perDay) return { ok: false, reason: "day", message: MESSAGES.day };
  if (site > budget) return { ok: false, reason: "budget", message: MESSAGES.budget };
  return { ok: true };
}

const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);
const minuteKey = (now: number) => Math.floor(now / 60_000);

/** Counters kept in this server's memory. */
export class MemoryCounter {
  private counts = new Map<string, number>();
  async bump(keys: string[]): Promise<number[]> {
    if (this.counts.size > 20_000) this.counts.clear();
    return keys.map((k) => { const n = (this.counts.get(k) ?? 0) + 1; this.counts.set(k, n); return n; });
  }
}

/** Counters kept in Upstash Redis over its REST API, shared by every server. */
export class UpstashCounter {
  constructor(private url: string, private token: string, private fetcher: typeof fetch = fetch) {}
  async bump(keys: string[]): Promise<number[]> {
    const commands = keys.flatMap((k) => [["INCR", k], ["EXPIRE", k, 172_800]]);
    const res = await this.fetcher(`${this.url.replace(/\/+$/, "")}/pipeline`, {
      method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands), signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Upstash answered ${res.status}`);
    const rows = (await res.json()) as { result?: number; error?: string }[];
    return keys.map((_, i) => {
      const n = rows[2 * i]?.result;
      if (typeof n !== "number") throw new Error("Upstash returned an unexpected reply");
      return n;
    });
  }
}

export interface Counter { bump(keys: string[]): Promise<number[]> }

/**
 * Counts this question against the visitor and the site, and says whether it may proceed.
 * If the shared store is unreachable the memory counter is used instead, so an outage at the
 * store never takes the assistant down (and never leaves it unlimited).
 */
export async function admit(visitor: string, now: number, budget: number, primary: Counter, fallback: Counter): Promise<Verdict> {
  const keys = [
    `pl:min:${visitor}:${minuteKey(now)}`, `pl:day:${visitor}:${dayKey(now)}`, `pl:site:${dayKey(now)}`,
  ];
  let counts: number[];
  try { counts = await primary.bump(keys); } catch { counts = await fallback.bump(keys); }
  return decide(counts[0], counts[1], counts[2], budget);
}

export function budgetFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.ASK_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : LIMITS.dailyBudget;
}

export function counterFromEnv(env: Record<string, string | undefined>, memory: Counter): Counter {
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new UpstashCounter(url, token) : memory;
}
