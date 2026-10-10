/** Parity: the TypeScript engine must reproduce what the Python reference engine computed. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InputError, optimizePrices, priceLines, simulatePrices, simulatePromo } from "./engine";
import type { CategoryModel } from "./types";

const dir = path.resolve(__dirname, "../../public/data");
const load = (name: string) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8"));
const golden = load("golden");
const CODES = ["tna", "bjc", "lnd", "sdr"];

/** Deep comparison with a relative tolerance; Python's None/inf arrive as null/Infinity. */
function expectClose(actual: unknown, expected: unknown, where = "") {
  if (typeof expected === "number") {
    expect(typeof actual, where).toBe("number");
    const a = actual as number;
    if (!Number.isFinite(expected)) return expect(a, where).toBe(expected);
    return expect(Math.abs(a - expected), `${where}: ${a} vs ${expected}`).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(expected)));
  }
  if (Array.isArray(expected)) {
    expect((actual as unknown[]).length, where).toBe(expected.length);
    return expected.forEach((e, i) => expectClose((actual as unknown[])[i], e, `${where}[${i}]`));
  }
  if (expected && typeof expected === "object") {
    for (const [key, e] of Object.entries(expected)) expectClose((actual as Record<string, unknown>)[key], e, `${where}.${key}`);
    return;
  }
  expect(actual, where).toEqual(expected);
}

describe.each(CODES)("parity with Python: %s", (code) => {
  const model = load(code) as CategoryModel;
  const cases = golden[code];

  it("price scenarios", () => {
    for (const name of ["prices", "pricesTier"]) {
      const { input, output } = cases[name];
      expectClose(simulatePrices(model, input.prices, input.tier, input.weeks), output, name);
    }
  });

  it("promotions", () => {
    for (const name of ["promo", "promoLine", "promoPlain"]) {
      const { input, output } = cases[name];
      expectClose(simulatePromo(model, input.items, input.depth, input.weeks, input.deal, input.funding, input.tier), output, name);
    }
  });

  it("optimizer", () => {
    for (const name of ["optimize", "optimizeFree"]) {
      const { input, output } = cases[name];
      expectClose(optimizePrices(model, input), output, name);
    }
  });
});

describe("guards", () => {
  const model = load("tna") as CategoryModel;
  const p0 = model.items.map((it) => it.price);

  it("rejects bad input with a clear error instead of returning NaN", () => {
    expect(() => simulatePrices(model, [1, 2])).toThrow(InputError);
    expect(() => simulatePrices(model, p0.map(() => NaN))).toThrow(InputError);
    expect(() => simulatePrices(model, p0, "mars" as never)).toThrow(InputError);
    expect(() => simulatePromo(model, [99], 0.2)).toThrow(InputError);
    expect(() => simulatePromo(model, [0], 0)).toThrow(InputError);
    expect(() => simulatePromo(model, [0], 0.2, 1, "bogof" as never)).toThrow(InputError);
    expect(() => optimizePrices(model, { maxChange: 5 })).toThrow(InputError);
  });

  it("current prices change nothing", () => {
    const r = simulatePrices(model, p0, "chain", 4);
    expect(Math.abs(r.delta.profit.p50)).toBeLessThan(1e-9);
    expect(r.probProfitUp).toBe(0);
  });

  it("every item belongs to exactly one price line", () => {
    for (const code of CODES) {
      const m = load(code) as CategoryModel;
      expect(priceLines(m).flat().sort((a, b) => a - b)).toEqual(m.items.map((_, i) => i));
    }
  });
});
