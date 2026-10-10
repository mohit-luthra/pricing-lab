"""Out-of-time check: fit on everything before the last 26 weeks, predict those 26 weeks."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .demand import ItemFit, fit_item
from .features import LAST_WEEK

HOLDOUT_WEEKS = 26
NAIVE_WINDOW = 8
MIN_QUARTER_WEEKS = 8


def recent_level(fit: ItemFit, frame_item: pd.DataFrame) -> float:
    """Demand level to carry forward: average of the last four well-observed quarter effects."""
    weeks_in_q = frame_item.groupby("quarter")["week"].nunique()
    q = fit.quarter_effect.reindex(weeks_in_q.index).fillna(0.0)      # base quarter has effect 0
    q = q[weeks_in_q >= MIN_QUARTER_WEEKS]
    return float(q.tail(4).mean()) if len(q) else 0.0


def predict_log_units(fit: ItemFit, rows: pd.DataFrame, level: float) -> np.ndarray:
    hol = rows[fit.holiday_beta.index].to_numpy() @ fit.holiday_beta.to_numpy()
    return (rows["store"].map(fit.store_effect).to_numpy() + level + hol
            + rows[fit.names].to_numpy() @ fit.beta)


def holdout(frame: pd.DataFrame) -> dict:
    """Accuracy of chain-level weekly unit forecasts per item over the holdout weeks."""
    cut = LAST_WEEK - HOLDOUT_WEEKS
    n_items = int(frame["item"].max()) + 1
    out = []
    for i in range(n_items):
        d = frame[frame["item"] == i]
        train, test = d[d["week"] <= cut], d[d["week"] > cut]
        fit = fit_item(train, i, n_items, by_store=False, instrumented=False)
        test = test[test["store"].isin(fit.store_effect.index)]
        level = recent_level(fit, train)
        # Duan smearing: unbiased back-transform from logs without assuming normal errors.
        smear = float(np.mean(np.exp(train["ln_q"].to_numpy() - predict_log_units(fit, train, recent_level_per_row(fit, train)))))
        pred = np.exp(predict_log_units(fit, test, level)) * smear
        last = train[train["week"] > cut - NAIVE_WINDOW].groupby("store")["units"].mean()
        naive = test["store"].map(last).fillna(last.mean()).to_numpy()
        wk = test.assign(pred=pred, naive=naive).groupby("week").agg(
            actual=("units", "sum"), pred=("pred", "sum"), naive=("naive", "sum"),
            promo=("ln_disc", lambda s: float((s < -0.05).mean() > 0.5)))
        sd = fit.resid_sd_chain_week
        wk["covered"] = (wk["actual"] >= wk["pred"] * np.exp(-1.2816 * sd)) & (wk["actual"] <= wk["pred"] * np.exp(1.2816 * sd))
        wk["item"] = i
        out.append(wk.reset_index())
    wk = pd.concat(out, ignore_index=True)
    wape = lambda a, f: float(np.abs(a - f).sum() / a.sum())
    mdape = lambda a, f: float(np.median(np.abs(a - f) / a))
    promo = wk[wk["promo"] == 1]
    return {
        "holdoutWeeks": HOLDOUT_WEEKS, "itemWeeks": int(len(wk)),
        "wapeModel": wape(wk["actual"], wk["pred"]), "wapeNaive": wape(wk["actual"], wk["naive"]),
        "medianApeModel": mdape(wk["actual"], wk["pred"]), "medianApeNaive": mdape(wk["actual"], wk["naive"]),
        "biasModel": float(wk["pred"].sum() / wk["actual"].sum() - 1),
        "promoItemWeeks": int(len(promo)),
        "wapeModelPromo": wape(promo["actual"], promo["pred"]) if len(promo) else None,
        "wapeNaivePromo": wape(promo["actual"], promo["naive"]) if len(promo) else None,
        "coverage80": float(wk["covered"].mean()),
        "series": [{"item": int(i), "week": g["week"].tolist(), "actual": g["actual"].round(0).tolist(),
                    "pred": g["pred"].round(0).tolist()} for i, g in wk.groupby("item")],
    }


def recent_level_per_row(fit: ItemFit, rows: pd.DataFrame) -> np.ndarray:
    """In-sample quarter effect for every row (used only to compute the smearing factor)."""
    return rows["quarter"].map(fit.quarter_effect).fillna(0.0).to_numpy()
