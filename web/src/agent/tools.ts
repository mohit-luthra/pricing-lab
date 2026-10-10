/**
 * The assistant's tools. The language model never computes a number: it can only call these,
 * and each one runs the same engine as the rest of the app.
 */
import { optimizePrices, simulatePrices, simulatePromo } from "@/engine/engine";
import type { CategoryModel, Deal, Summary, Tier } from "@/engine/types";

export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "simulate_price_change",
      description: "Effect on weekly profit, revenue and units of changing regular prices of one or more items.",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array", minItems: 1,
            items: {
              type: "object",
              properties: {
                item: { type: "integer", description: "Item number from the item list" },
                change_pct: { type: "number", description: "Price change in percent, e.g. -5 for 5% cheaper" },
              },
              required: ["item", "change_pct"],
            },
          },
          tier: { type: "string", enum: ["chain", "low", "medium", "high"] },
        },
        required: ["changes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "simulate_promotion",
      description: "Net effect of a temporary discount, including the dip afterwards and sales lost on other items.",
      parameters: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "integer" }, minItems: 1, description: "Item numbers promoted together" },
          depth_pct: { type: "number", description: "Discount in percent off the regular price" },
          weeks: { type: "integer", minimum: 1 },
          deal: { type: "string", enum: ["none", "bonus", "advertised"] },
          funding_pct: { type: "number", description: "Percent of the discount paid by the supplier" },
          tier: { type: "string", enum: ["chain", "low", "medium", "high"] },
        },
        required: ["items", "depth_pct"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "optimize_prices",
      description: "Regular prices that maximise expected weekly category profit within the given limits.",
      parameters: {
        type: "object",
        properties: {
          max_change_pct: { type: "number", description: "Largest allowed price move in percent" },
          min_margin_pct: { type: "number", description: "Lowest allowed gross margin in percent" },
          revenue_floor_pct: { type: "number", description: "Revenue to keep, as percent of today's" },
          tier: { type: "string", enum: ["chain", "low", "medium", "high"] },
        },
      },
    },
  },
] as const;

export const TOOL_LABEL: Record<string, string> = {
  simulate_price_change: "Ran a price change",
  simulate_promotion: "Ran a promotion scenario",
  optimize_prices: "Searched for best prices",
};

export type ToolName = (typeof TOOL_SPECS)[number]["function"]["name"];
export interface ToolCall { id: string; name: string; arguments: string }

const TIERS: Tier[] = ["chain", "low", "medium", "high"];
const DEALS: Deal[] = ["none", "bonus", "advertised"];
const round = (v: number, digits = 0) => { const f = 10 ** digits; return Math.round(v * f) / f; };
const range = (s: Summary, digits = 0) => ({ low: round(s.p10, digits), median: round(s.p50, digits), high: round(s.p90, digits) });
const pctRange = (s: Summary) => ({ low: round(s.p10 * 100, 1), median: round(s.p50 * 100, 1), high: round(s.p90 * 100, 1) });

function num(v: unknown, name: string, fallback?: number): number {
  if (v === undefined || v === null) {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function tierOf(v: unknown): Tier {
  if (v === undefined || v === null) return "chain";
  if (!TIERS.includes(v as Tier)) throw new Error(`tier must be one of ${TIERS.join(", ")}`);
  return v as Tier;
}

function itemIndex(v: unknown, model: CategoryModel): number {
  const i = num(v, "item");
  if (!Number.isInteger(i) || i < 0 || i >= model.items.length) {
    throw new Error(`item must be a whole number from 0 to ${model.items.length - 1}`);
  }
  return i;
}

/** Runs one tool call. Never throws: bad arguments come back as {error} for the model to fix. */
export function runTool(model: CategoryModel, name: string, rawArgs: string): Record<string, unknown> {
  try {
    const a = rawArgs ? JSON.parse(rawArgs) : {};
    if (name === "simulate_price_change") {
      if (!Array.isArray(a.changes) || !a.changes.length) throw new Error("changes must be a non-empty list");
      const prices = model.items.map((it) => it.price);
      for (const c of a.changes) {
        const i = itemIndex(c?.item, model);
        const pct = num(c?.change_pct, "change_pct");
        if (pct <= -90 || pct > 200) throw new Error("change_pct must be between -90 and 200");
        prices[i] = model.items[i].price * (1 + pct / 100);
      }
      const tier = tierOf(a.tier);
      const r = simulatePrices(model, prices, tier, 1, true);
      return {
        tool: name, tier, per: "week",
        new_prices: a.changes.map((c: { item: number }) => ({ item: model.items[c.item].name, price: round(prices[c.item], 2) })),
        profit_change: range(r.delta.profit), revenue_change: range(r.delta.revenue), units_change: range(r.delta.units),
        baseline_profit: round(r.baseline.profit.p50), chance_profit_improves_pct: round(r.probProfitUp * 100),
        outside_observed_range: a.changes
          .filter((c: { item: number }) => prices[c.item] < model.items[c.item].priceMin || prices[c.item] > model.items[c.item].priceMax)
          .map((c: { item: number }) => model.items[c.item].name),
      };
    }
    if (name === "simulate_promotion") {
      if (!Array.isArray(a.items) || !a.items.length) throw new Error("items must be a non-empty list");
      const items = a.items.map((v: unknown) => itemIndex(v, model));
      const depth = num(a.depth_pct, "depth_pct") / 100;
      const weeks = num(a.weeks, "weeks", 1);
      const funding = num(a.funding_pct, "funding_pct", 0) / 100;
      const deal = (a.deal ?? "advertised") as Deal;
      if (!DEALS.includes(deal)) throw new Error(`deal must be one of ${DEALS.join(", ")}`);
      const tier = tierOf(a.tier);
      const r = simulatePromo(model, items, depth, weeks, deal, funding, tier);
      return {
        tool: name, tier, items: r.items.map((i) => model.items[i].name), weeks,
        sales_lift_pct: pctRange(r.liftPct), net_profit: range(r.profit), net_units: range(r.netUnits),
        profit_parts: {
          promotion_weeks: round(r.profitParts.promoWeeks.p50), dip_after: round(r.profitParts.dip.p50),
          lost_on_other_items: round(r.profitParts.cannibalisation.p50),
        },
        chance_profitable_pct: round(r.probProfitable * 100),
        break_even_funding_pct: round(r.breakEvenFunding.p50 * 100),
      };
    }
    if (name === "optimize_prices") {
      const tier = tierOf(a.tier);
      const r = optimizePrices(model, {
        tier, maxChange: num(a.max_change_pct, "max_change_pct", 10) / 100,
        minMargin: num(a.min_margin_pct, "min_margin_pct", 0) / 100,
        revenueFloor: num(a.revenue_floor_pct, "revenue_floor_pct", 0) / 100,
      });
      return {
        tool: name, tier, per: "week", feasible: r.feasible,
        recommended: model.items.map((it, i) => ({
          item: it.name, price: round(r.prices[i], 2), change_pct: round(r.changePct[i] * 100, 1), stopped_at_limit: r.atBound[i] !== "none",
        })).filter((row) => row.change_pct !== 0),
        profit_change: range(r.delta.profit), revenue_change: range(r.delta.revenue),
        baseline_profit: round(r.expected.baselineProfit), chance_profit_improves_pct: round(r.probProfitUp * 100),
      };
    }
    return { error: `unknown tool '${name}'` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** What the model is told about the category it is working on. */
export function describeCategory(model: CategoryModel): string {
  const rows = model.items.map((it, i) =>
    `${i}: ${it.name}, regular price $${it.price.toFixed(2)}, cost $${it.cost.toFixed(2)}`);
  const lines = (model.lines ?? []).map((g) => g.join("+")).join("; ");
  return [
    `Category: ${model.name}. Items (number: name):`, ...rows,
    lines ? `Items always priced together (promote them together): ${lines}` : "",
    `Store groups: chain (all ${model.tiers.chain} stores), low, medium, high price zones.`,
  ].filter(Boolean).join("\n");
}

export const SYSTEM_PROMPT = `You are the assistant inside Pricing Lab, a pricing and promotion simulator for a grocery chain.
Rules:
- Every number in your answer must come from a tool result in this conversation. Never estimate, never do arithmetic of your own.
- If a question needs a number, call a tool first. If no tool can answer it, say so.
- Money is US dollars per week unless the tool says otherwise. Ranges are the 10th to 90th percentile.
- Answer in at most four short sentences of plain text (no markdown): the recommendation first, then the numbers behind it, then one caveat if a tool flagged one.
- If a tool returns an error, fix the arguments and try again once, or explain what is missing.`;
