/**
 * Evaluation suite for the assistant. Needs LLM_API_KEY (see .env.example).
 *   npm run evals
 * Scores, per question: did it pick the right tool, with the right arguments, and is every
 * number in the answer traceable to a tool result. Writes evals/results.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callProvider, configFromEnv } from "../src/agent/provider";
import { ask } from "../src/agent/run";
import type { CategoryModel } from "../src/engine/types";

interface Case { id: string; question: string; tool: string | null; check: (args: Record<string, any>) => boolean }

const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 0.51;

function casesFor(model: CategoryModel): Case[] {
  const [a, b, c] = model.items.map((it) => it.name);
  const c0 = model.code;
  return [
    { id: `${c0}-price-up`, question: `What happens to weekly profit if we raise ${a} by 5%?`, tool: "simulate_price_change",
      check: (x) => x.changes?.length === 1 && x.changes[0].item === 0 && near(x.changes[0].change_pct, 5) },
    { id: `${c0}-price-tier`, question: `Cut the price of ${b} by 8% in the high price zone stores only. Worth it?`, tool: "simulate_price_change",
      check: (x) => x.changes?.[0]?.item === 1 && near(x.changes[0].change_pct, -8) && x.tier === "high" },
    { id: `${c0}-promo-advertised`, question: `Should we run a 20% off advertised promotion on ${a} for 2 weeks?`, tool: "simulate_promotion",
      check: (x) => x.items?.includes(0) && near(x.depth_pct, 20) && x.weeks === 2 && (x.deal ?? "advertised") === "advertised" },
    { id: `${c0}-promo-funded`, question: `${c} at 15% off with a shelf tag only, and the supplier pays half the discount. Does it make money?`, tool: "simulate_promotion",
      check: (x) => x.items?.includes(2) && near(x.depth_pct, 15) && x.deal === "bonus" && near(x.funding_pct, 50) },
    { id: `${c0}-optimize-cap`, question: "Find the most profitable prices if no price may move more than 5%.", tool: "optimize_prices",
      check: (x) => near(x.max_change_pct, 5) },
    { id: `${c0}-optimize-floors`, question: "Optimise prices but keep at least 97% of today's revenue and a minimum 20% margin.", tool: "optimize_prices",
      check: (x) => near(x.revenue_floor_pct, 97) && near(x.min_margin_pct, 20) },
  ];
}

const OUT_OF_SCOPE: Case[] = [
  { id: "refuse-market-share", question: "What is our market share versus Jewel-Osco?", tool: null, check: () => true },
  { id: "refuse-forecast", question: "What will the weather be on Saturday and how will it affect sales?", tool: null, check: () => true },
];

async function main() {
  const cfg = configFromEnv(process.env);
  if (!cfg) {
    console.error("Set LLM_API_KEY first (a free Groq key works): see web/.env.example");
    process.exit(1);
  }
  const dir = path.resolve(__dirname, "../public/data");
  const models: CategoryModel[] = ["tna", "bjc", "lnd", "sdr"].map((c) => JSON.parse(readFileSync(path.join(dir, `${c}.json`), "utf8")));
  const suite = [...models.flatMap((m) => casesFor(m).map((k) => ({ k, m }))), ...OUT_OF_SCOPE.map((k) => ({ k, m: models[0] }))];
  interface Row { id: string; toolOk: boolean; argsOk: boolean; faithful: boolean; unsupported: string[]; rounds: number; answer: string }
  const rows: Row[] = [];
  for (const { k, m } of suite) {
    try {
      const answer = await ask(m, k.question, (messages) => callProvider(messages, cfg));
      const first = answer.steps[0];
      const toolOk = k.tool === null ? answer.steps.length === 0 : first?.name === k.tool;
      let argsOk = false;
      try { argsOk = toolOk && (k.tool === null || k.check(JSON.parse(first.args || "{}"))); } catch { argsOk = false; }
      rows.push({ id: k.id, toolOk, argsOk, faithful: answer.verification.unsupported.length === 0,
                  unsupported: answer.verification.unsupported, rounds: answer.rounds, answer: answer.text });
    } catch (e) {
      rows.push({ id: k.id, toolOk: false, argsOk: false, faithful: false, unsupported: [], rounds: 0, answer: `ERROR: ${e instanceof Error ? e.message : e}` });
    }
    await new Promise((r) => setTimeout(r, 1200));     // stay under free-tier rate limits
  }
  const rate = (f: (r: Row) => boolean) => `${rows.filter(f).length}/${rows.length}`;
  const summary = { model: cfg.model, cases: rows.length, toolAccuracy: rate((r) => r.toolOk), argumentAccuracy: rate((r) => r.argsOk), numericFaithfulness: rate((r) => r.faithful) };
  console.table(rows.map(({ id, toolOk, argsOk, faithful, rounds }) => ({ id, toolOk, argsOk, faithful, rounds })));
  console.log(summary);
  writeFileSync(path.resolve(__dirname, "results.json"), JSON.stringify({ summary, rows }, null, 1));
}

main();
