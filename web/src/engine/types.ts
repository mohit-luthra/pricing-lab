/** Shape of public/data/<category>.json, written by the Python pipeline. */
export type Tier = "chain" | "low" | "medium" | "high";
export type Deal = "none" | "bonus" | "advertised";

export interface Item {
  id: string;
  name: string;
  price: number;
  cost: number;
  priceMin: number;
  priceMax: number;
  units: Record<Tier, number>;
  actualUnits: number;
  promoShare: number;
  noiseSd: number;
  elasticity: { regular: number[]; promo: number[] };
  stage1: { regular: number; promo: number; regularSe: number; promoSe: number };
  endogeneity: { ols: number; olsSe: number; iv: number; ivSe: number; firstStageF: number; passThrough: number };
  storePromoElasticity: number[];
  fit: { rows: number; weeks: number; stores: number; r2Within: number };
}

export interface Validation {
  holdoutWeeks: number;
  itemWeeks: number;
  wapeModel: number;
  wapeNaive: number;
  medianApeModel: number;
  medianApeNaive: number;
  biasModel: number;
  coverage80: number;
  series: { item: number; week: number[]; actual: number[]; pred: number[] }[];
}

export interface CategoryModel {
  code: string;
  name: string;
  coefficients: string[];
  tiers: Record<Tier, number>;
  items: Item[];
  draws: { n: number; own: number[][][]; cross: number[][][]; noise: number[][] };
  tierDev: Record<Tier, number[][]>;
  categoryMean: Record<string, number[]>;
  linePriced: [number, number, number][];
  lines: number[][];
  validation: Validation;
  diagnostics: { maxRhat: number; divergences: number; weeks: number[]; rows: number; stores: number };
}

export interface Summary { p10: number; p50: number; p90: number; mean: number }

export interface PriceResult {
  baseline: { revenue: Summary; profit: Summary; units: Summary };
  scenario: { revenue: Summary; profit: Summary; units: Summary };
  delta: { revenue: Summary; profit: Summary; units: Summary };
  probProfitUp: number;
  items: { unitsChangePct: Summary; profitChange: Summary; breakEvenUnitsChangePct: number }[];
}

export interface PromoResult {
  items: number[];
  liftPct: Summary;
  incrementalUnits: Summary;
  dipUnits: Summary;
  cannibalisedUnits: Summary;
  netUnits: Summary;
  revenue: Summary;
  profit: Summary;
  profitParts: { promoWeeks: Summary; dip: Summary; cannibalisation: Summary };
  probProfitable: number;
  breakEvenLiftPct: number | null;
  breakEvenFunding: Summary;
  promoMarginPerUnit: number[];
}

export type BoundState = "upper" | "lower" | "fixed" | "none";

export interface OptimizeResult {
  prices: number[];
  changePct: number[];
  atBound: BoundState[];
  probInelastic: number[];
  bounds: [number, number][];
  lines: number[][];
  expected: { profit: number; revenue: number; baselineProfit: number; baselineRevenue: number };
  delta: PriceResult["delta"];
  probProfitUp: number;
  feasible: boolean;
}
