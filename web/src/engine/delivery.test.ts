import { describe, expect, it } from "vitest";
import { bestThreshold, evaluateThresholds, mulberry32, type DeliveryInputs } from "./delivery";
import { callFor, deliveryVerdict } from "./verdict";

const base: DeliveryInputs = {
  avgBasket: 40, basketSpread: 0.6, marginPct: 0.3, deliveryCost: 6, fee: 4,
  reachPct: 0.25, topUp: [0.2, 0.4], extraOrders: [0.0, 0.1],
};

describe("free-delivery calculator", () => {
  it("is deterministic", () => {
    expect(evaluateThresholds(base, [30, 50, 80])).toEqual(evaluateThresholds(base, [30, 50, 80]));
    expect(mulberry32(1)()).toBe(mulberry32(1)());
  });

  it("with no behaviour change, free delivery only gives away the fee", () => {
    const still = { ...base, topUp: [0, 0] as [number, number], extraOrders: [0, 0] as [number, number] };
    const [r] = evaluateThresholds(still, [50]);
    expect(r.profitDelta.p10).toBeCloseTo(r.profitDelta.p90, 9);
    expect(r.profitDelta.p50).toBeLessThan(0);
    // loss = fee x number of orders that now ride free
    expect(r.profitDelta.p50).toBeCloseTo(-base.fee * r.shareFree * 1000, 6);
  });

  it("an unreachable threshold changes nothing", () => {
    const [r] = evaluateThresholds(base, [100000]);
    expect(Math.abs(r.profitDelta.p50)).toBeLessThan(1e-9);
  });

  it("more top-up and more extra orders can only help", () => {
    const strong = { ...base, topUp: [0.6, 0.8] as [number, number], extraOrders: [0.2, 0.3] as [number, number] };
    const weak = evaluateThresholds(base, [60])[0], good = evaluateThresholds(strong, [60])[0];
    expect(good.profitDelta.p50).toBeGreaterThan(weak.profitDelta.p50);
  });

  it("picks the best threshold and words the call", () => {
    const results = evaluateThresholds(base, [20, 40, 60, 80, 100]);
    const best = bestThreshold(results);
    expect(Math.max(...results.map((r) => r.profitDelta.p50))).toBe(best.profitDelta.p50);
    expect(deliveryVerdict(best).reason).toContain("per 1,000 orders");
  });

  it("rejects impossible inputs", () => {
    expect(() => evaluateThresholds({ ...base, marginPct: 1.4 }, [50])).toThrow();
    expect(() => evaluateThresholds({ ...base, topUp: [0.5, 0.2] }, [50])).toThrow();
    expect(() => evaluateThresholds(base, [0])).toThrow();
  });

  it("probability bands", () => {
    expect([0.9, 0.6, 0.3, 0.1].map(callFor)).toEqual(["go", "test", "hold", "stop"]);
  });
});
