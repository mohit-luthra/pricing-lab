/**
 * The assistant endpoint. The whole conversation loop runs here on the server: the browser
 * sends a category and one question, and gets back a finished answer. Nothing the browser
 * sends can change the instructions, the tools, or what the tools return, and an answer that
 * used no tool is replaced by a fixed refusal before it leaves the server.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { admit, budgetFromEnv, counterFromEnv, MemoryCounter, parseRequest, type CategoryCode } from "@/agent/guard";
import { callProvider, configFromEnv } from "@/agent/provider";
import { ask } from "@/agent/run";
import type { CategoryModel } from "@/engine/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const memory = new MemoryCounter();
const models = new Map<CategoryCode, CategoryModel>();

/**
 * Category files live in public/data. They are read from disk (next.config.mjs makes sure they
 * are packaged with this function on Vercel); if that ever fails, they are fetched from this
 * same site instead. Loaded once per server and kept.
 */
async function loadModel(code: CategoryCode, origin: string): Promise<CategoryModel> {
  const hit = models.get(code);
  if (hit) return hit;
  let model: CategoryModel;
  try {
    model = JSON.parse(await readFile(path.join(process.cwd(), "public", "data", `${code}.json`), "utf8"));
  } catch {
    const res = await fetch(`${origin}/data/${code}.json`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Category data could not be loaded (${res.status}).`);
    model = (await res.json()) as CategoryModel;
  }
  models.set(code, model);
  return model;
}

/** Lets the page show "switched off" before anyone types a question. */
export async function GET() {
  return NextResponse.json({ enabled: configFromEnv(process.env) !== null });
}

export async function POST(request: Request) {
  const cfg = configFromEnv(process.env);
  if (!cfg) {
    return NextResponse.json({ error: "The assistant is switched off: no language model key is configured on this deployment." }, { status: 503 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 }); }
  const parsed = parseRequest(body);
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });

  const visitor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const gate = await admit(visitor, Date.now(), budgetFromEnv(process.env), counterFromEnv(process.env, memory), memory);
  if (!gate.ok) return NextResponse.json({ error: gate.message, reason: gate.reason }, { status: 429 });

  try {
    const model = await loadModel(parsed.code, new URL(request.url).origin);
    const answer = await ask(model, parsed.question, (messages) => callProvider(messages, cfg, AbortSignal.timeout(20_000)), parsed.history);
    return NextResponse.json(answer);
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : "";
    const message = (e instanceof Error ? e.message : "The language model could not be reached.") + cause;
    console.error("[ask] failed:", message);                 // shows in the terminal / Vercel logs
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
