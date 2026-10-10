/**
 * Free-delivery threshold calculator. Unlike the price and promotion tools, nothing here is
 * estimated from data: Dominick's was a 1990s in-store chain with no delivery. The user states
 * the behavioural assumptions as ranges and the tool shows what follows from them.
 *
 * Policy compared: "free delivery above a basket threshold, a fee below it" versus
 * "the same fee on every order".
 */
import { summarize } from "./engine";
import type { Summary } from "./types";

export interface DeliveryInputs {
  avgBasket: number;        // mean order value today
  basketSpread: number;     // coefficient of variation of order value (0.6 = fairly spread out)
  marginPct: number;        // gross margin on goods, 0..1
  deliveryCost: number;     // what one delivery costs the business
  fee: number;              // delivery fee charged when it is not free
  reachPct: number;         // orders within this share below the threshold may top up, 0..1
  topUp: [number, number];  // share of in-reach orders that add items to qualify (low, high)
  extraOrders: [number, number]; // extra orders among baskets already above the threshold (low, high)
}

export interface ThresholdResult {
  threshold: number;
  profitDelta: Summary;     // per 1,000 current orders, versus charging the fee to everyone
  probBetter: number;
  shareFree: number;        // share of orders that end up with free delivery (median)
}

/** Small deterministic generator so the same inputs always give the same picture. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validate(x: DeliveryInputs) {
  const positive = [x.avgBasket, x.deliveryCost];
  if (positive.some((v) => !(v > 0)) || !(x.fee >= 0) || !(x.basketSpread > 0)) {
    throw new Error("basket, spread and delivery cost must be positive; fee cannot be negative");
  }
  const shares = [x.marginPct, x.reachPct, ...x.topUp, ...x.extraOrders];
  if (shares.some((v) => !(v >= 0 && v <= 1))) throw new Error("percentages must be between 0 and 100");
  if (x.topUp[0] > x.topUp[1] || x.extraOrders[0] > x.extraOrders[1]) throw new Error("each range needs low <= high");
}

const N_ORDERS = 1000;
const N_SCENARIOS = 300;

export function evaluateThresholds(x: DeliveryInputs, thresholds: number[], seed = 7): ThresholdResult[] {
  validate(x);
  const rand = mulberry32(seed);
  // Lognormal baskets with the requested mean and spread.
  const sigma2 = Math.log(1 + x.basketSpread ** 2);
  const mu = Math.log(x.avgBasket) - sigma2 / 2;
  const baskets = Float64Array.from({ length: N_ORDERS }, () => {
    const u = Math.max(rand(), 1e-12), v = rand();
    return Math.exp(mu + Math.sqrt(sigma2) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  });
  // One draw of the uncertain behaviour per scenario, reused across thresholds (paired comparison).
  const behaviour = Array.from({ length: N_SCENARIOS }, () => ({
    topUp: x.topUp[0] + rand() * (x.topUp[1] - x.topUp[0]),
    extra: x.extraOrders[0] + rand() * (x.extraOrders[1] - x.extraOrders[0]),
  }));
  let flat = 0;
  for (const b of baskets) flat += b * x.marginPct + x.fee - x.deliveryCost;

  return thresholds.map((t) => {
    if (!(t > 0)) throw new Error("threshold must be positive");
    let above = 0, reach = 0, below = 0, aboveCount = 0, reachCount = 0;
    for (const b of baskets) {
      if (b >= t) { above += b * x.marginPct - x.deliveryCost; aboveCount++; }
      else if (b >= t * (1 - x.reachPct)) { reach += b * x.marginPct + x.fee - x.deliveryCost; reachCount++; }
      else below += b * x.marginPct + x.fee - x.deliveryCost;
    }
    const toppedUp = t * x.marginPct - x.deliveryCost;            // one in-reach order lifted to the threshold
    const delta = new Float64Array(N_SCENARIOS), free = new Float64Array(N_SCENARIOS);
    behaviour.forEach((s, n) => {
      const profit = above * (1 + s.extra) + reach * (1 - s.topUp) + reachCount * s.topUp * toppedUp + below;
      delta[n] = profit - flat;
      free[n] = (aboveCount * (1 + s.extra) + reachCount * s.topUp) / (N_ORDERS + aboveCount * s.extra);
    });
    let better = 0;
    for (const v of delta) if (v > 0) better++;
    return { threshold: t, profitDelta: summarize(delta), probBetter: better / N_SCENARIOS, shareFree: summarize(free).p50 };
  });
}

export function bestThreshold(results: ThresholdResult[]): ThresholdResult {
  return results.reduce((a, b) => (b.profitDelta.p50 > a.profitDelta.p50 ? b : a));
}
