"""Reference simulation engine. Pure functions on the exported category model (a dict with the
same shape as web/public/data/<category>.json), so Python and the browser run identical maths.

Demand for item i in one week, relative to its baseline (regular prices, no promotion):

    q_i = base_i * exp( sum_j E_ij * ln(p_j / p0_j) )            regular price changes
    q_i = base_i * (1 - depth)^b_promo * exp(step + deal effect + dip * lagged depth)   own promotion
    q_j = base_j * (1 - depth)^E_ji                              effect on competing items

Items that are always priced together (a price line) can be promoted and re-priced as one.

Every result is computed once per posterior draw, then summarised as P10 / P50 / P90.
"""
from __future__ import annotations

import numpy as np

REG, PROMO, STEP, DEAL_B, DEAL_S, DIP = 0, 1, 2, 3, 4, 5
PROMO_THRESHOLD = 0.05      # must match features.PROMO_THRESHOLD
DEAL_TYPES = {"none": None, "bonus": DEAL_B, "advertised": DEAL_S}
GRID_STEPS = 41
MAX_SWEEPS = 25


def _summary(x: np.ndarray) -> dict:
    p10, p50, p90 = np.percentile(x, [10, 50, 90])
    return {"p10": float(p10), "p50": float(p50), "p90": float(p90), "mean": float(x.mean())}


def _arrays(model: dict, tier: str):
    items = model["items"]
    if tier not in model["tiers"]:
        raise ValueError(f"unknown tier '{tier}', expected one of {list(model['tiers'])}")
    p0 = np.array([it["price"] for it in items], float)
    c0 = np.array([it["cost"] for it in items], float)
    base = np.array([it["units"][tier] for it in items], float)
    own = np.array(model["draws"]["own"], float)                     # D x K x 6
    cross = np.array(model["draws"]["cross"], float)                 # D x K x K
    dev = np.array(model["tierDev"][tier], float)                    # K x 2
    own = own.copy()
    own[:, :, REG] += dev[:, 0]
    own[:, :, PROMO] += dev[:, 1]
    return p0, c0, base, own, cross


def _elasticity_matrix(own: np.ndarray, cross: np.ndarray) -> np.ndarray:
    e = cross.copy()
    idx = np.arange(e.shape[1])
    e[:, idx, idx] = own[:, :, REG]
    return e


def _check_prices(prices, k: int) -> np.ndarray:
    p = np.asarray(prices, float)
    if p.shape != (k,) or not np.all(np.isfinite(p)) or np.any(p <= 0):
        raise ValueError(f"prices must be {k} positive finite numbers")
    return p


def simulate_prices(model: dict, prices, tier: str = "chain", weeks: int = 1, noise: bool = True) -> dict:
    """Outcome of holding the given regular prices for `weeks` weeks versus current prices."""
    p0, c0, base, own, cross = _arrays(model, tier)
    k = len(p0)
    p = _check_prices(prices, k)
    if weeks < 1:
        raise ValueError("weeks must be at least 1")
    e = _elasticity_matrix(own, cross)
    shock = np.ones((own.shape[0], k))
    if noise:
        sd = np.array([it["noiseSd"] for it in model["items"]])
        shock = np.exp(sd * np.array(model["draws"]["noise"], float) / np.sqrt(weeks))   # D x K
    q0 = base * shock * weeks                                         # same shock in both arms
    q1 = q0 * np.exp(e @ np.log(p / p0))
    rev0, rev1 = q0 @ p0, q1 @ p
    prof0, prof1 = q0 @ (p0 - c0), q1 @ (p - c0)
    margin0, margin1 = p0 - c0, p - c0
    with np.errstate(divide="ignore", invalid="ignore"):
        breakeven = np.where(margin1 > 0, margin0 / margin1 - 1, np.inf)
    return {
        "baseline": {"revenue": _summary(rev0), "profit": _summary(prof0), "units": _summary(q0.sum(1))},
        "scenario": {"revenue": _summary(rev1), "profit": _summary(prof1), "units": _summary(q1.sum(1))},
        "delta": {"revenue": _summary(rev1 - rev0), "profit": _summary(prof1 - prof0),
                  "units": _summary((q1 - q0).sum(1))},
        "probProfitUp": float(np.mean(prof1 > prof0)),
        "items": [{
            "unitsChangePct": _summary(q1[:, i] / q0[:, i] - 1),
            "profitChange": _summary(q1[:, i] * margin1[i] - q0[:, i] * margin0[i]),
            # volume change needed for this item's own profit to stay level at the new margin
            "breakEvenUnitsChangePct": float(breakeven[i]),
        } for i in range(k)],
    }


def simulate_promo(model: dict, items, depth: float, weeks: int = 1, deal: str = "advertised",
                   funding: float = 0.0, tier: str = "chain") -> dict:
    """A temporary price cut on one item, or on several items promoted together (a price line),
    including the week after it ends (the dip).

    items    item index, or a list of indices that share the promotion
    depth    discount as a fraction of the regular price (0.2 = 20% off)
    deal     "none" (unannounced price cut), "bonus" (shelf tag) or "advertised" (featured cut)
    funding  share of the discount paid by the supplier (trade funding), 0..1
    """
    p0, c0, base, own, cross = _arrays(model, tier)
    k = len(p0)
    promoted = sorted({int(i) for i in ([items] if np.isscalar(items) else items)})
    if not promoted or promoted[0] < 0 or promoted[-1] >= k:
        raise ValueError(f"items must be indices between 0 and {k - 1}")
    if not 0 < depth < 0.9:
        raise ValueError("depth must be between 0 and 0.9")
    if weeks < 1 or not 0 <= funding <= 1:
        raise ValueError("weeks must be >= 1 and funding between 0 and 1")
    if deal not in DEAL_TYPES:
        raise ValueError(f"deal must be one of {list(DEAL_TYPES)}")
    log_cut = np.log(1 - depth)                        # negative
    lag = -log_cut
    in_promo = np.zeros(k, bool)
    in_promo[promoted] = True
    # Each item feels the summed price cut of the *other* promoted items through cross effects.
    spill = cross[:, :, in_promo].sum(axis=2) * log_cut               # D x K
    step = own[:, :, STEP] if depth >= PROMO_THRESHOLD else 0.0
    deal_effect = own[:, :, DEAL_TYPES[deal]] if DEAL_TYPES[deal] is not None else 0.0
    first = np.exp(own[:, :, PROMO] * log_cut + step + deal_effect + spill)   # first promo week
    after = np.exp(own[:, :, DIP] * lag)                              # the week after it ends
    promo_mult = first + first * after * (weeks - 1)                  # summed over promo weeks
    others = np.exp(spill)

    margin0 = p0 - c0
    promo_margin = p0 * (1 - depth) - c0 + funding * depth * p0
    pm, ot = in_promo, ~in_promo
    own_promo = (base[pm] * (promo_mult[:, pm] * promo_margin[pm] - weeks * margin0[pm])).sum(1)
    own_dip = (base[pm] * margin0[pm] * (after[:, pm] - 1)).sum(1)
    cannibal = (base[ot] * margin0[ot] * (others[:, ot] - 1)).sum(1) * weeks
    net = own_promo + own_dip + cannibal
    extra_units = (base[pm] * (promo_mult[:, pm] - weeks)).sum(1)
    dip_units = (base[pm] * (after[:, pm] - 1)).sum(1)
    cannibal_units = (base[ot] * (others[:, ot] - 1)).sum(1) * weeks
    revenue = ((base[pm] * p0[pm] * (promo_mult[:, pm] * (1 - depth) + after[:, pm] - (weeks + 1))).sum(1)
               + (base[ot] * p0[ot] * (others[:, ot] - 1)).sum(1) * weeks)
    # Profit is linear in the funding share, so the share that makes the promotion break even
    # has a closed form per draw: (loss at current funding) / (value of one point of funding).
    funding_value = depth * (base[pm] * p0[pm] * promo_mult[:, pm]).sum(1)
    needed = np.clip(funding - net / funding_value, 0.0, None)
    base_margin = float((base[pm] * margin0[pm]).sum())
    promo_margin_total = float((base[pm] * promo_margin[pm]).sum())
    return {
        "items": promoted,
        "liftPct": _summary((base[pm] * first[:, pm]).sum(1) / base[pm].sum() - 1),
        "incrementalUnits": _summary(extra_units),
        "dipUnits": _summary(dip_units),
        "cannibalisedUnits": _summary(cannibal_units),
        "netUnits": _summary(extra_units + dip_units + cannibal_units),
        "revenue": _summary(revenue),
        "profit": _summary(net),
        "profitParts": {"promoWeeks": _summary(own_promo), "dip": _summary(own_dip),
                        "cannibalisation": _summary(cannibal)},
        "probProfitable": float(np.mean(net > 0)),
        # lift needed in a promo week for the promoted items' own margin to break even
        "breakEvenLiftPct": base_margin / promo_margin_total - 1 if promo_margin_total > 0 else None,
        # supplier funding share at which the promotion breaks even (above 1 = cannot break even)
        "breakEvenFunding": _summary(needed),
        "promoMarginPerUnit": [float(promo_margin[i]) for i in promoted],
    }


def price_lines(model: dict, link: bool = True) -> list[list[int]]:
    """Groups of items priced as one line. Every item appears in exactly one group."""
    k = len(model["items"])
    lines = [sorted(g) for g in model.get("lines", [])] if link else []
    seen = {i for g in lines for i in g}
    return sorted(lines + [[i] for i in range(k) if i not in seen])


def _bounds(model: dict, max_change: float, min_margin: float):
    items = model["items"]
    p0 = np.array([it["price"] for it in items], float)
    c0 = np.array([it["cost"] for it in items], float)
    lo = np.maximum([it["priceMin"] for it in items], p0 * (1 - max_change))
    hi = np.minimum([it["priceMax"] for it in items], p0 * (1 + max_change))
    if min_margin > 0:
        lo = np.maximum(lo, c0 / (1 - min_margin))     # price at which margin equals the floor
    hi = np.maximum(hi, lo)                            # floor above the cap: the floor wins
    return lo, hi


def optimize_prices(model: dict, tier: str = "chain", max_change: float = 0.10, min_margin: float = 0.0,
                    revenue_floor: float = 0.0, locked: list[int] | None = None,
                    link_lines: bool = True) -> dict:
    """Regular prices that maximise expected weekly category profit.

    Search is coordinate ascent on a fixed grid of price multipliers: deterministic, never
    leaves the bounds, and only accepts a move that keeps expected revenue above the floor.
    Bounds per item = observed regular-price range, narrowed to +/- max_change around today.
    With link_lines, items that are always priced together move by the same percentage.
    """
    if not 0 <= max_change <= 1 or not 0 <= min_margin < 1 or not 0 <= revenue_floor <= 1.5:
        raise ValueError("max_change in [0,1], min_margin in [0,1), revenue_floor in [0,1.5]")
    p0, c0, base, own, cross = _arrays(model, tier)
    k = len(p0)
    e = _elasticity_matrix(own, cross)
    lo, hi = _bounds(model, max_change, min_margin)
    locked = set(locked or [])
    groups = price_lines(model, link_lines)
    # A group moves by one multiplier m (price = m * current); its range is where all members fit.
    m_lo = np.array([max(lo[i] / p0[i] for i in g) for g in groups])
    m_hi = np.array([min(hi[i] / p0[i] for i in g) for g in groups])
    m_hi = np.maximum(m_hi, m_lo)
    frozen = np.array([any(i in locked for i in g) for g in groups])
    m_lo[frozen], m_hi[frozen] = 1.0, 1.0
    member = np.zeros(k, int)
    for gi, g in enumerate(groups):
        member[g] = gi

    def evaluate(m):
        p = p0 * m[member]
        q = base * np.exp(e @ np.log(m[member]))
        return float((q @ (p - c0)).mean()), float((q @ p).mean())

    base_profit, base_rev = evaluate(np.ones(len(groups)))
    m = np.clip(np.ones(len(groups)), m_lo, m_hi)
    best, rev = evaluate(m)
    feasible_start = rev >= revenue_floor * base_rev
    for _ in range(MAX_SWEEPS):
        improved = False
        for gi in range(len(groups)):
            if m_hi[gi] <= m_lo[gi]:
                continue
            for cand in np.linspace(m_lo[gi], m_hi[gi], GRID_STEPS):
                trial = m.copy()
                trial[gi] = cand
                prof, r = evaluate(trial)
                ok = r >= revenue_floor * base_rev or (not feasible_start and r > rev)
                if ok and prof > best + 1e-9 * max(1.0, abs(best)):
                    m, best, rev, improved = trial, prof, r, True
        if not improved:
            break

    p = p0 * m[member]
    reg = own[:, :, REG]
    sim = simulate_prices(model, p, tier=tier, weeks=1, noise=False)
    tol = 1e-9

    def bound_state(i: int) -> str:
        gi = member[i]
        if m_hi[gi] <= m_lo[gi]:
            return "fixed"
        if abs(m[gi] - m_hi[gi]) < tol:
            return "upper"
        return "lower" if abs(m[gi] - m_lo[gi]) < tol else "none"

    return {
        "prices": [float(x) for x in p],
        "changePct": [float(x) for x in p / p0 - 1],
        "atBound": [bound_state(i) for i in range(k)],
        # share of draws where demand is inelastic: there the bound, not the model, sets the price
        "probInelastic": [float(np.mean(reg[:, i] > -1)) for i in range(k)],
        "bounds": [[float(p0[i] * m_lo[member[i]]), float(p0[i] * m_hi[member[i]])] for i in range(k)],
        "lines": groups,
        "expected": {"profit": best, "revenue": rev, "baselineProfit": base_profit, "baselineRevenue": base_rev},
        "delta": sim["delta"], "probProfitUp": sim["probProfitUp"],
        "feasible": bool(rev >= revenue_floor * base_rev),
    }
