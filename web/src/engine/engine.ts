/**
 * Simulation engine. A line-for-line port of src/pricinglab/engine.py: the test suite checks
 * that both produce the same numbers from the same model file.
 *
 * Demand for item i in one week, relative to its baseline (regular prices, no promotion):
 *   q_i = base_i * exp( sum_j E_ij * ln(p_j / p0_j) )                     regular price changes
 *   q_i = base_i * (1 - depth)^b_promo * exp(step + deal + dip * lag)     own promotion
 *   q_j = base_j * (1 - depth)^E_ji                                       competing items
 * Every result is computed once per posterior draw, then summarised as P10 / P50 / P90.
 */
import type {
  BoundState, CategoryModel, Deal, OptimizeResult, PriceResult, PromoResult, Summary, Tier,
} from "./types";

const REG = 0, PROMO = 1, STEP = 2, DEAL_B = 3, DEAL_S = 4, DIP = 5, N_OWN = 6;
const DEAL_INDEX: Record<Deal, number | null> = { none: null, bonus: DEAL_B, advertised: DEAL_S };
export const PROMO_THRESHOLD = 0.05;
const GRID_STEPS = 41;
const MAX_SWEEPS = 25;

export class InputError extends Error {}

interface Prepared {
  k: number; d: number;
  p0: Float64Array; c0: Float64Array; base: Float64Array; sd: Float64Array;
  own: Float64Array;      // d * k * N_OWN, tier adjustment already applied
  cross: Float64Array;    // d * k * k
  elast: Float64Array;    // d * k * k, cross with the regular own elasticity on the diagonal
  noise: Float64Array;    // d * k
}

const cache = new WeakMap<CategoryModel, Map<Tier, Prepared>>();

function prepare(model: CategoryModel, tier: Tier): Prepared {
  if (!(tier in model.tiers)) throw new InputError(`unknown tier '${tier}'`);
  let byTier = cache.get(model);
  if (!byTier) cache.set(model, (byTier = new Map()));
  const hit = byTier.get(tier);
  if (hit) return hit;
  const k = model.items.length, d = model.draws.n;
  const dev = model.tierDev[tier];
  const own = new Float64Array(d * k * N_OWN);
  const cross = new Float64Array(d * k * k);
  const elast = new Float64Array(d * k * k);
  const noise = new Float64Array(d * k);
  for (let n = 0; n < d; n++) {
    for (let i = 0; i < k; i++) {
      for (let c = 0; c < N_OWN; c++) {
        const adj = c === REG ? dev[i][0] : c === PROMO ? dev[i][1] : 0;
        own[(n * k + i) * N_OWN + c] = model.draws.own[n][i][c] + adj;
      }
      for (let j = 0; j < k; j++) {
        const v = model.draws.cross[n][i][j];
        cross[(n * k + i) * k + j] = v;
        elast[(n * k + i) * k + j] = i === j ? own[(n * k + i) * N_OWN + REG] : v;
      }
      noise[n * k + i] = model.draws.noise[n][i];
    }
  }
  const prepared: Prepared = {
    k, d, own, cross, elast, noise,
    p0: Float64Array.from(model.items, (it) => it.price),
    c0: Float64Array.from(model.items, (it) => it.cost),
    base: Float64Array.from(model.items, (it) => it.units[tier]),
    sd: Float64Array.from(model.items, (it) => it.noiseSd),
  };
  byTier.set(tier, prepared);
  return prepared;
}

/** Same definition as numpy.percentile (linear interpolation). */
function percentile(sorted: Float64Array, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function summarize(x: Float64Array): Summary {
  const s = Float64Array.from(x).sort();
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i];
  return { p10: percentile(s, 0.1), p50: percentile(s, 0.5), p90: percentile(s, 0.9), mean: sum / x.length };
}

function share(x: Float64Array, test: (v: number, i: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (test(x[i], i)) n++;
  return n / x.length;
}

export function simulatePrices(
  model: CategoryModel, prices: number[], tier: Tier = "chain", weeks = 1, noise = true,
): PriceResult {
  const m = prepare(model, tier);
  const { k, d, p0, c0, base } = m;
  if (prices.length !== k || prices.some((p) => !Number.isFinite(p) || p <= 0)) {
    throw new InputError(`prices must be ${k} positive finite numbers`);
  }
  if (!(weeks >= 1)) throw new InputError("weeks must be at least 1");
  const lr = prices.map((p, i) => Math.log(p / p0[i]));
  const rev0 = new Float64Array(d), rev1 = new Float64Array(d);
  const prof0 = new Float64Array(d), prof1 = new Float64Array(d);
  const u0 = new Float64Array(d), u1 = new Float64Array(d), dRev = new Float64Array(d);
  const dProf = new Float64Array(d), dUnits = new Float64Array(d);
  const ratio = Array.from({ length: k }, () => new Float64Array(d));
  const itemProfit = Array.from({ length: k }, () => new Float64Array(d));
  const root = Math.sqrt(weeks);
  for (let n = 0; n < d; n++) {
    for (let i = 0; i < k; i++) {
      const shock = noise ? Math.exp((m.sd[i] * m.noise[n * k + i]) / root) : 1;
      const q0 = base[i] * shock * weeks;                       // same shock in both arms
      let s = 0;
      for (let j = 0; j < k; j++) s += m.elast[(n * k + i) * k + j] * lr[j];
      const q1 = q0 * Math.exp(s);
      rev0[n] += q0 * p0[i]; rev1[n] += q1 * prices[i];
      prof0[n] += q0 * (p0[i] - c0[i]); prof1[n] += q1 * (prices[i] - c0[i]);
      u0[n] += q0; u1[n] += q1;
      ratio[i][n] = q1 / q0 - 1;
      itemProfit[i][n] = q1 * (prices[i] - c0[i]) - q0 * (p0[i] - c0[i]);
    }
    dRev[n] = rev1[n] - rev0[n]; dProf[n] = prof1[n] - prof0[n]; dUnits[n] = u1[n] - u0[n];
  }
  return {
    baseline: { revenue: summarize(rev0), profit: summarize(prof0), units: summarize(u0) },
    scenario: { revenue: summarize(rev1), profit: summarize(prof1), units: summarize(u1) },
    delta: { revenue: summarize(dRev), profit: summarize(dProf), units: summarize(dUnits) },
    probProfitUp: share(prof1, (v, n) => v > prof0[n]),
    items: Array.from({ length: k }, (_, i) => {
      const m0 = p0[i] - c0[i], m1 = prices[i] - c0[i];
      return {
        unitsChangePct: summarize(ratio[i]),
        profitChange: summarize(itemProfit[i]),
        // volume change needed for this item's own profit to stay level at the new margin
        breakEvenUnitsChangePct: m1 > 0 ? m0 / m1 - 1 : Infinity,
      };
    }),
  };
}

export function simulatePromo(
  model: CategoryModel, items: number[], depth: number, weeks = 1, deal: Deal = "advertised",
  funding = 0, tier: Tier = "chain",
): PromoResult {
  const m = prepare(model, tier);
  const { k, d, p0, c0, base } = m;
  const promoted = Array.from(new Set(items.map((i) => Math.trunc(i)))).sort((a, b) => a - b);
  if (!promoted.length || promoted[0] < 0 || promoted[promoted.length - 1] >= k || items.some((i) => !Number.isInteger(i))) {
    throw new InputError(`items must be indices between 0 and ${k - 1}`);
  }
  if (!(depth > 0 && depth < 0.9)) throw new InputError("depth must be between 0 and 0.9");
  if (!(weeks >= 1) || !(funding >= 0 && funding <= 1)) {
    throw new InputError("weeks must be >= 1 and funding between 0 and 1");
  }
  if (!(deal in DEAL_INDEX)) throw new InputError("deal must be none, bonus or advertised");
  const logCut = Math.log(1 - depth), lag = -logCut;
  const inPromo = new Array<boolean>(k).fill(false);
  for (const i of promoted) inPromo[i] = true;
  const dealIdx = DEAL_INDEX[deal];
  const useStep = depth >= PROMO_THRESHOLD;

  const lift = new Float64Array(d), extra = new Float64Array(d), dipU = new Float64Array(d);
  const canU = new Float64Array(d), netU = new Float64Array(d), rev = new Float64Array(d);
  const net = new Float64Array(d), ownPromo = new Float64Array(d), ownDip = new Float64Array(d);
  const cannibal = new Float64Array(d), needed = new Float64Array(d);
  let basePromoUnits = 0, baseMargin = 0, promoMarginTotal = 0;
  const promoMargin = new Float64Array(k);
  for (let i = 0; i < k; i++) promoMargin[i] = p0[i] * (1 - depth) - c0[i] + funding * depth * p0[i];
  for (const i of promoted) {
    basePromoUnits += base[i];
    baseMargin += base[i] * (p0[i] - c0[i]);
    promoMarginTotal += base[i] * promoMargin[i];
  }
  for (let n = 0; n < d; n++) {
    let liftUnits = 0, fundingValue = 0;
    for (let i = 0; i < k; i++) {
      // each item feels the summed price cut of the *other* promoted items through cross effects
      let spill = 0;
      for (const j of promoted) spill += m.cross[(n * k + i) * k + j];
      spill *= logCut;
      const margin0 = p0[i] - c0[i];
      if (inPromo[i]) {
        const o = (n * k + i) * N_OWN;
        const first = Math.exp(
          m.own[o + PROMO] * logCut + (useStep ? m.own[o + STEP] : 0) + (dealIdx === null ? 0 : m.own[o + dealIdx]) + spill,
        );
        const after = Math.exp(m.own[o + DIP] * lag);
        const mult = first + first * after * (weeks - 1);          // summed over promo weeks
        liftUnits += base[i] * first;
        ownPromo[n] += base[i] * (mult * promoMargin[i] - weeks * margin0);
        ownDip[n] += base[i] * margin0 * (after - 1);
        extra[n] += base[i] * (mult - weeks);
        dipU[n] += base[i] * (after - 1);
        rev[n] += base[i] * p0[i] * (mult * (1 - depth) + after - (weeks + 1));
        fundingValue += base[i] * p0[i] * mult;
      } else {
        const other = Math.exp(spill) - 1;
        cannibal[n] += base[i] * margin0 * other * weeks;
        canU[n] += base[i] * other * weeks;
        rev[n] += base[i] * p0[i] * other * weeks;
      }
    }
    lift[n] = liftUnits / basePromoUnits - 1;
    net[n] = ownPromo[n] + ownDip[n] + cannibal[n];
    netU[n] = extra[n] + dipU[n] + canU[n];
    // profit is linear in the funding share, so the break-even share has a closed form
    needed[n] = Math.max(0, funding - net[n] / (depth * fundingValue));
  }
  return {
    items: promoted,
    liftPct: summarize(lift),
    incrementalUnits: summarize(extra),
    dipUnits: summarize(dipU),
    cannibalisedUnits: summarize(canU),
    netUnits: summarize(netU),
    revenue: summarize(rev),
    profit: summarize(net),
    profitParts: { promoWeeks: summarize(ownPromo), dip: summarize(ownDip), cannibalisation: summarize(cannibal) },
    probProfitable: share(net, (v) => v > 0),
    breakEvenLiftPct: promoMarginTotal > 0 ? baseMargin / promoMarginTotal - 1 : null,
    breakEvenFunding: summarize(needed),
    promoMarginPerUnit: promoted.map((i) => promoMargin[i]),
  };
}

/** Groups of items priced as one line. Every item appears in exactly one group. */
export function priceLines(model: CategoryModel, link = true): number[][] {
  const k = model.items.length;
  const lines = link ? (model.lines ?? []).map((g) => [...g].sort((a, b) => a - b)) : [];
  const seen = new Set(lines.flat());
  for (let i = 0; i < k; i++) if (!seen.has(i)) lines.push([i]);
  return lines.sort((a, b) => a[0] - b[0]);
}

export interface OptimizeOptions {
  tier?: Tier; maxChange?: number; minMargin?: number; revenueFloor?: number;
  locked?: number[]; linkLines?: boolean;
}

/**
 * Regular prices that maximise expected weekly category profit. Coordinate ascent on a fixed
 * grid of price multipliers: deterministic, never leaves the bounds, and only accepts a move
 * that keeps expected revenue above the floor.
 */
export function optimizePrices(model: CategoryModel, opts: OptimizeOptions = {}): OptimizeResult {
  const { tier = "chain", maxChange = 0.1, minMargin = 0, revenueFloor = 0, locked = [], linkLines = true } = opts;
  if (!(maxChange >= 0 && maxChange <= 1) || !(minMargin >= 0 && minMargin < 1) || !(revenueFloor >= 0 && revenueFloor <= 1.5)) {
    throw new InputError("maxChange in [0,1], minMargin in [0,1), revenueFloor in [0,1.5]");
  }
  const m = prepare(model, tier);
  const { k, d, p0, c0, base } = m;
  const lo = new Float64Array(k), hi = new Float64Array(k);
  model.items.forEach((it, i) => {
    lo[i] = Math.max(it.priceMin, p0[i] * (1 - maxChange));
    hi[i] = Math.min(it.priceMax, p0[i] * (1 + maxChange));
    if (minMargin > 0) lo[i] = Math.max(lo[i], c0[i] / (1 - minMargin));
    hi[i] = Math.max(hi[i], lo[i]);                                // floor above the cap: the floor wins
  });
  const lockedSet = new Set(locked);
  const groups = priceLines(model, linkLines);
  const g = groups.length;
  const mLo = new Float64Array(g), mHi = new Float64Array(g);
  const member = new Int32Array(k);
  groups.forEach((grp, gi) => {
    mLo[gi] = Math.max(...grp.map((i) => lo[i] / p0[i]));
    mHi[gi] = Math.max(Math.min(...grp.map((i) => hi[i] / p0[i])), mLo[gi]);
    if (grp.some((i) => lockedSet.has(i))) { mLo[gi] = 1; mHi[gi] = 1; }
    for (const i of grp) member[i] = gi;
  });

  const lr = new Float64Array(k);
  const evaluate = (mult: Float64Array): [number, number] => {
    for (let i = 0; i < k; i++) lr[i] = Math.log(mult[member[i]]);
    let profit = 0, revenue = 0;
    for (let n = 0; n < d; n++) {
      for (let i = 0; i < k; i++) {
        let s = 0;
        const row = (n * k + i) * k;
        for (let j = 0; j < k; j++) s += m.elast[row + j] * lr[j];
        const q = base[i] * Math.exp(s);
        const p = p0[i] * mult[member[i]];
        profit += q * (p - c0[i]);
        revenue += q * p;
      }
    }
    return [profit / d, revenue / d];
  };

  const ones = new Float64Array(g).fill(1);
  const [baseProfit, baseRev] = evaluate(ones);
  let mult = Float64Array.from(ones, (v, gi) => Math.min(Math.max(v, mLo[gi]), mHi[gi]));
  let [best, rev] = evaluate(mult);
  const feasibleStart = rev >= revenueFloor * baseRev;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let improved = false;
    for (let gi = 0; gi < g; gi++) {
      if (mHi[gi] <= mLo[gi]) continue;
      for (let s = 0; s < GRID_STEPS; s++) {
        const cand = s === GRID_STEPS - 1 ? mHi[gi] : mLo[gi] + (s * (mHi[gi] - mLo[gi])) / (GRID_STEPS - 1);
        const trial = Float64Array.from(mult);
        trial[gi] = cand;
        const [prof, r] = evaluate(trial);
        const ok = r >= revenueFloor * baseRev || (!feasibleStart && r > rev);
        if (ok && prof > best + 1e-9 * Math.max(1, Math.abs(best))) {
          mult = trial; best = prof; rev = r; improved = true;
        }
      }
    }
    if (!improved) break;
  }

  const prices = Array.from({ length: k }, (_, i) => p0[i] * mult[member[i]]);
  const sim = simulatePrices(model, prices, tier, 1, false);
  const state = (i: number): BoundState => {
    const gi = member[i];
    if (mHi[gi] <= mLo[gi]) return "fixed";
    if (Math.abs(mult[gi] - mHi[gi]) < 1e-9) return "upper";
    return Math.abs(mult[gi] - mLo[gi]) < 1e-9 ? "lower" : "none";
  };
  const probInelastic = Array.from({ length: k }, (_, i) => {
    let n = 0;
    for (let s = 0; s < d; s++) if (m.own[(s * k + i) * N_OWN + REG] > -1) n++;
    return n / d;
  });
  return {
    prices,
    changePct: prices.map((p, i) => p / p0[i] - 1),
    atBound: prices.map((_, i) => state(i)),
    probInelastic,
    bounds: prices.map((_, i) => [p0[i] * mLo[member[i]], p0[i] * mHi[member[i]]] as [number, number]),
    lines: groups,
    expected: { profit: best, revenue: rev, baselineProfit: baseProfit, baselineRevenue: baseRev },
    delta: sim.delta,
    probProfitUp: sim.probProfitUp,
    feasible: rev >= revenueFloor * baseRev,
  };
}
