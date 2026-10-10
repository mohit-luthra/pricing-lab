"""Fit everything and write the files the simulator reads.

Run:  python -m pricinglab.pipeline --data data/processed --out web/public/data

Only fitted parameters and chain-level aggregates are exported. No row-level Dominick's data
leaves the machine.
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd

from .config import CATEGORIES, DISPLAY_NAMES
from .demand import OWN, fit_category
from .engine import optimize_prices, simulate_prices, simulate_promo
from .features import LAST_WEEK, build_frame, select_items
from .hierarchy import N_OWN, fit_hierarchy
from .validate import holdout, predict_log_units, recent_level, recent_level_per_row

log = logging.getLogger(__name__)
TIERS = ("chain", "low", "medium", "high")
BASE_WEEKS = 26            # reference prices and costs come from the last half year
RANGE_WEEKS = 104          # allowed price range = what was actually charged in two years
N_DRAWS = 400


def _round(a, digits: int = 4):
    return np.round(np.asarray(a, float), digits).tolist()


def _store_tiers(data_dir: Path) -> pd.Series:
    s = pd.read_parquet(data_dir / "stores.parquet").set_index("store")
    tier = pd.Series("medium", index=s.index)
    tier[s["priclow"] == 1] = "low"
    tier[s["prichigh"] == 1] = "high"
    return tier


def build_model(data_dir: Path, code: str, seed: int = 0) -> dict:
    cat = CATEGORIES[code]
    items = select_items(data_dir, code)
    frame = build_frame(data_dir, code, items)
    k = len(items)
    fits = fit_category(frame)
    post = fit_hierarchy(fits, draws=N_DRAWS, seed=seed)
    log.info("%s: hierarchy max r-hat %.3f, %d divergences", code, post.max_rhat, post.divergences)
    tiers = _store_tiers(data_dir)
    recent = frame[frame["week"] > LAST_WEEK - BASE_WEEKS]
    live_stores = np.sort(recent["store"].unique())
    tier_of = tiers.reindex(live_stores).fillna("medium")
    tier_counts = {"chain": int(len(live_stores)), **{t: int((tier_of == t).sum()) for t in TIERS[1:]}}

    # Reference point: today's regular price and cost for each item.
    p0 = recent.groupby("item")["reg_price"].median().reindex(range(k)).to_numpy()
    undiscounted = recent[recent["promo_on"] == 0]
    c0 = undiscounted.groupby("item")["unit_cost"].median().reindex(range(k))
    c0 = c0.fillna(recent.groupby("item")["unit_cost"].median()).to_numpy()
    span = frame[frame["week"] > LAST_WEEK - RANGE_WEEKS].groupby("item")["reg_price"]
    p_lo = np.minimum(span.quantile(0.05).reindex(range(k)).to_numpy(), p0)
    p_hi = np.maximum(span.quantile(0.95).reindex(range(k)).to_numpy(), p0)

    out_items, tier_dev = [], {t: np.zeros((k, 2)) for t in TIERS}
    rng = np.random.default_rng(seed)
    for i, fit in enumerate(fits):
        d = frame[frame["item"] == i]
        # Baseline = model-implied weekly units per store at regular prices with no promotion,
        # at the demand level of the last four quarters.
        level = recent_level(fit, d)
        smear = float(np.mean(np.exp(d["ln_q"].to_numpy() - predict_log_units(fit, d, recent_level_per_row(fit, d)))))
        at_ref = fit.beta[0] * np.log(p0[i]) + sum(
            fit.beta[fit.names.index(f"x_{j}")] * np.log(p0[j]) for j in range(k) if j != i)
        base_store = np.exp(fit.store_effect.reindex(live_stores) + level + at_ref) * smear
        base_store = base_store.fillna(0.0)
        units = {"chain": float(base_store.sum()),
                 **{t: float(base_store[(tier_of == t).to_numpy()].sum()) for t in TIERS[1:]}}
        dev = pd.DataFrame(post.store_dev[i], index=post.store_ids[i])
        for t in TIERS[1:]:
            members = tier_of.index[(tier_of == t).to_numpy()].intersection(dev.index)
            if len(members):
                tier_dev[t][i] = dev.loc[members].mean().to_numpy()
        last_year = d[d["week"] > LAST_WEEK - 52]
        own = post.own[:, i, :]
        pct = lambda col: _round(np.percentile(own[:, col], [10, 50, 90]), 3)
        upc = int(items["upc"][i])
        out_items.append({
            "id": str(upc), "name": DISPLAY_NAMES.get(upc, str(items["descrip"][i]).title()),
            "price": round(float(p0[i]), 2), "cost": round(float(c0[i]), 3),
            "priceMin": round(float(p_lo[i]), 2), "priceMax": round(float(p_hi[i]), 2),
            "units": {t: round(v, 1) for t, v in units.items()},
            "actualUnits": round(float(last_year.groupby("week")["units"].sum().mean()), 1),
            "promoShare": round(float(last_year["promo_on"].mean()), 3),
            "noiseSd": round(fit.resid_sd_chain_week, 4),
            "elasticity": {"regular": pct(0), "promo": pct(1)},
            "stage1": {"regular": round(float(fit.beta[0]), 3), "promo": round(float(fit.beta[1]), 3),
                       "regularSe": round(float(np.sqrt(fit.cov[0, 0])), 3),
                       "promoSe": round(float(np.sqrt(fit.cov[1, 1])), 3)},
            "endogeneity": {"ols": round(fit.total_ols, 3), "olsSe": round(fit.total_ols_se, 3),
                            "iv": round(fit.total_iv, 3), "ivSe": round(fit.total_iv_se, 3),
                            "firstStageF": round(fit.first_stage_f, 1),
                            "passThrough": round(fit.pass_through, 3)},
            "storePromoElasticity": _round(own[:, 1].mean() + post.store_dev[i][:, 1], 2),
            "fit": {"rows": fit.n_obs, "weeks": fit.n_weeks, "stores": int(len(fit.stores)),
                    "r2Within": round(fit.r2_within, 3)},
        })

    # Items whose prices move together (same price line): their cross effects are not separable.
    chain_price = frame.groupby(["week", "item"])["ln_p"].median().unstack("item")
    corr = chain_price.corr().to_numpy()
    line_priced = [[i, j, round(float(corr[i, j]), 2)] for i in range(k) for j in range(i + 1, k)
                   if corr[i, j] > 0.9]

    parent = list(range(k))                      # union-find: pairs -> price lines

    def root(a: int) -> int:
        while parent[a] != a:
            a = parent[a]
        return a

    for i, j, _ in line_priced:
        parent[root(j)] = root(i)
    lines = [g for g in ([i for i in range(k) if root(i) == r] for r in range(k)) if len(g) > 1]

    model = {
        "code": code, "name": cat.name, "coefficients": OWN, "tiers": tier_counts, "items": out_items,
        "draws": {"n": int(post.own.shape[0]), "own": _round(post.own), "cross": _round(post.cross),
                  "noise": _round(rng.standard_normal((post.own.shape[0], k)), 3)},
        "tierDev": {t: _round(v) for t, v in tier_dev.items()},
        "categoryMean": {name: _round(np.percentile(post.category_mean[:, n], [10, 50, 90]), 3)
                         for n, name in enumerate(OWN)},
        "linePriced": line_priced, "lines": lines,
        "validation": holdout(frame),
        "diagnostics": {"maxRhat": round(post.max_rhat, 3), "divergences": post.divergences,
                        "weeks": [int(frame["week"].min()), int(frame["week"].max())],
                        "rows": int(len(frame)), "stores": int(frame["store"].nunique())},
    }
    assert len(OWN) == N_OWN
    return model


def golden_cases(model: dict) -> dict:
    """Engine outputs for fixed inputs. The TypeScript engine must reproduce these numbers."""
    p0 = [it["price"] for it in model["items"]]
    up = [p * (1.05 if i % 2 == 0 else 0.97) for i, p in enumerate(p0)]
    return {
        "prices": {"input": {"prices": up, "tier": "chain", "weeks": 4},
                   "output": simulate_prices(model, up, "chain", 4)},
        "pricesTier": {"input": {"prices": up, "tier": "high", "weeks": 1},
                       "output": simulate_prices(model, up, "high", 1)},
        "promo": {"input": {"items": [0], "depth": 0.2, "weeks": 2, "deal": "advertised", "funding": 0.5, "tier": "chain"},
                  "output": simulate_promo(model, [0], 0.2, 2, "advertised", 0.5, "chain")},
        "promoLine": {"input": {"items": [0, 3, 8], "depth": 0.15, "weeks": 3, "deal": "bonus", "funding": 0.25, "tier": "medium"},
                      "output": simulate_promo(model, [0, 3, 8], 0.15, 3, "bonus", 0.25, "medium")},
        "promoPlain": {"input": {"items": [3], "depth": 0.03, "weeks": 1, "deal": "none", "funding": 0.0, "tier": "low"},
                       "output": simulate_promo(model, [3], 0.03, 1, "none", 0.0, "low")},
        "optimize": {"input": {"tier": "chain", "maxChange": 0.1, "minMargin": 0.05, "revenueFloor": 0.97, "locked": [1], "linkLines": True},
                     "output": optimize_prices(model, "chain", 0.1, 0.05, 0.97, [1], True)},
        "optimizeFree": {"input": {"tier": "high", "maxChange": 0.2, "minMargin": 0.0, "revenueFloor": 0.0, "locked": [], "linkLines": False},
                         "output": optimize_prices(model, "high", 0.2, 0.0, 0.0, [], False)},
    }


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, default=Path("data/processed"))
    ap.add_argument("--out", type=Path, default=Path("web/public/data"))
    ap.add_argument("--categories", nargs="*", default=list(CATEGORIES), choices=list(CATEGORIES))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args.out.mkdir(parents=True, exist_ok=True)
    index, golden = [], {}
    for code in args.categories:
        model = build_model(args.data, code)
        (args.out / f"{code}.json").write_text(json.dumps(model, separators=(",", ":")))
        golden[code] = golden_cases(model)
        v = model["validation"]
        index.append({"code": code, "name": model["name"], "items": len(model["items"]),
                      "medianApe": round(v["medianApeModel"], 3), "medianApeNaive": round(v["medianApeNaive"], 3)})
        log.info("%s: exported, holdout median error %.0f%% (naive %.0f%%)", code,
                 100 * v["medianApeModel"], 100 * v["medianApeNaive"])
    (args.out / "index.json").write_text(json.dumps(index, indent=1))
    (args.out / "golden.json").write_text(json.dumps(golden, separators=(",", ":")))


if __name__ == "__main__":
    main()
