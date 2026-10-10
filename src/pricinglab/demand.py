"""Stage 1: log-log demand regressions per item.

    ln q = store effect + quarter effect + holidays
           + b_reg * ln(regular price) + b_promo * ln(price / regular price)
           + s_on * [price at least 5% below regular]
           + d_b * bonus-buy flag + d_s * advertised-reduction flag
           + f_dip * last week's discount depth
           + sum_j g_j * ln(price of competing item j) + error

Three fits per item:
  pooled      one slope for the chain, standard errors clustered by week (prices and demand
              shocks are largely chain-wide, so weeks, not store-weeks, are the sample size)
  by store    a separate b_reg and b_promo for every store, feeding the hierarchical model
  instrumented  2SLS on total price with wholesale cost as the instrument (endogeneity check)
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

OWN = ["ln_reg", "ln_disc", "promo_on", "deal_b", "deal_s", "lag_depth"]          # order is relied on downstream
MIN_STORE_OBS = 60
UNKNOWN_VARIANCE = 25.0     # sd of 5: effectively "no information" on a log scale


@dataclass
class ItemFit:
    item: int
    names: list[str]                    # OWN + cross columns, in coefficient order
    beta: np.ndarray                    # pooled OLS
    cov: np.ndarray                     # cluster-by-week covariance of beta
    n_obs: int
    n_weeks: int
    r2_within: float
    resid_sd_chain_week: float          # sd of the chain-level weekly log residual
    stores: np.ndarray = field(default_factory=lambda: np.empty(0, int))
    store_beta: np.ndarray = field(default_factory=lambda: np.empty((0, 2)))   # [b_reg, b_promo]
    store_se: np.ndarray = field(default_factory=lambda: np.empty((0, 2)))
    store_effect: pd.Series | None = None      # ln baseline units by store (pooled fit)
    quarter_effect: pd.Series | None = None
    holiday_beta: pd.Series | None = None
    # Endogeneity check: elasticity on total price, plain vs instrumented by wholesale cost.
    total_ols: float = np.nan
    total_ols_se: float = np.nan
    total_iv: float = np.nan
    total_iv_se: float = np.nan
    pass_through: float = np.nan               # first-stage coefficient of price on cost
    first_stage_f: float = np.nan              # cluster-robust; below 10 = weak instrument


def _within(a: np.ndarray, codes: np.ndarray, n_groups: int) -> np.ndarray:
    """Subtract group means (the fixed-effects 'within' transform)."""
    counts = np.bincount(codes, minlength=n_groups).astype(float)
    a2 = a.reshape(len(a), -1)
    sums = np.zeros((n_groups, a2.shape[1]))
    np.add.at(sums, codes, a2)
    return (a2 - (sums / counts[:, None])[codes]).reshape(a.shape)


def _cluster_cov(X: np.ndarray, resid: np.ndarray, clusters: np.ndarray, bread: np.ndarray) -> np.ndarray:
    """Sandwich covariance with one-way clustering and the usual small-sample correction."""
    codes, _ = pd.factorize(clusters)
    g = codes.max() + 1
    scores = np.zeros((g, X.shape[1]))
    np.add.at(scores, codes, X * resid[:, None])
    n, k = X.shape
    adj = g / (g - 1) * (n - 1) / max(n - k, 1)
    return adj * bread @ (scores.T @ scores) @ bread


def _design(d: pd.DataFrame, item: int, n_items: int):
    cross = [f"x_{j}" for j in range(n_items) if j != item]
    hol = [c for c in d.columns if c.startswith("h_")] + ["deal_o"]   # controls with a pooled slope
    quarters = pd.get_dummies(d["quarter"], prefix="q", drop_first=True, dtype=float)
    return cross, hol, quarters


def fit_item(frame: pd.DataFrame, item: int, n_items: int, by_store: bool = True,
             instrumented: bool = True) -> ItemFit:
    d = frame[frame["item"] == item].reset_index(drop=True)
    if len(d) < 500:
        raise ValueError(f"item {item}: only {len(d)} rows, not enough to estimate")
    cross, hol, quarters = _design(d, item, n_items)
    store_codes, store_ids = pd.factorize(d["store"])
    n_stores = len(store_ids)
    names = OWN + cross
    y_raw = d["ln_q"].to_numpy()
    main_raw = d[names].to_numpy()
    ctrl_raw = np.column_stack([d[hol].to_numpy(), quarters.to_numpy()])

    y = _within(y_raw, store_codes, n_stores)
    main = _within(main_raw, store_codes, n_stores)
    ctrl = _within(ctrl_raw, store_codes, n_stores)
    X = np.column_stack([main, ctrl])
    bread = np.linalg.pinv(X.T @ X)
    coef = bread @ X.T @ y
    resid = y - X @ coef
    cov = _cluster_cov(X, resid, d["week"].to_numpy(), bread)
    k = len(names)
    # A regressor that never varies for this item (e.g. it was never on an advertised deal)
    # carries no information: mark it as unknown so the hierarchy fills it from the category.
    dead = np.flatnonzero(main.std(axis=0) < 1e-8)
    coef, cov = coef.copy(), cov.copy()
    coef[dead] = 0.0
    cov[dead, :], cov[:, dead] = 0.0, 0.0
    cov[dead, dead] = UNKNOWN_VARIANCE

    # Fixed effects recovered for forecasting and baselines.
    partial = y_raw - main_raw @ coef[:k] - ctrl_raw @ coef[k:]
    store_effect = pd.Series(partial).groupby(d["store"]).mean()
    fit = ItemFit(
        item=item, names=names, beta=coef[:k], cov=cov[:k, :k], n_obs=len(d),
        n_weeks=d["week"].nunique(), r2_within=float(1 - resid.var() / y.var()),
        resid_sd_chain_week=float(pd.Series(resid).groupby(d["week"]).mean().std()),
        store_effect=store_effect,
        quarter_effect=pd.Series(coef[k + len(hol):], index=[int(c[2:]) for c in quarters.columns]),
        holiday_beta=pd.Series(coef[k:k + len(hol)], index=hol),
    )

    if by_store:
        # Same regression, but ln_reg and ln_disc get one coefficient per store.
        onehot = np.zeros((len(d), n_stores))
        onehot[np.arange(len(d)), store_codes] = 1.0
        Xs = np.column_stack([onehot * main[:, [0]], onehot * main[:, [1]], main[:, 2:], ctrl])
        bread_s = np.linalg.pinv(Xs.T @ Xs)
        coef_s = bread_s @ Xs.T @ y
        e = y - Xs @ coef_s
        meat = (Xs * (e ** 2)[:, None]).T @ Xs                      # heteroskedasticity-robust
        se = np.sqrt(np.clip(np.diag(bread_s @ meat @ bread_s), 0, None))
        sb = np.column_stack([coef_s[:n_stores], coef_s[n_stores:2 * n_stores]])
        ss = np.column_stack([se[:n_stores], se[n_stores:2 * n_stores]])
        n_by_store = np.bincount(store_codes, minlength=n_stores)
        ok = (n_by_store >= MIN_STORE_OBS) & np.isfinite(ss).all(axis=1) & (ss > 1e-6).all(axis=1)
        fit.stores, fit.store_beta, fit.store_se = np.asarray(store_ids)[ok], sb[ok], ss[ok]

    if instrumented:
        # Endogeneity check on the total price: is the plain elasticity biased because the
        # chain discounts when it expects demand to move? Instrument: wholesale cost.
        keep = d["unit_cost"].notna().to_numpy()
        sc, wk = store_codes[keep], d.loc[keep, "week"].to_numpy()
        yk = _within(y_raw[keep], sc, n_stores)
        price = _within(d.loc[keep, "ln_p"].to_numpy(), sc, n_stores)
        cost = _within(np.log(d.loc[keep, "unit_cost"].to_numpy()), sc, n_stores)
        exog = np.column_stack([_within(main_raw[keep][:, 2:], sc, n_stores),
                                _within(ctrl_raw[keep], sc, n_stores)])
        Xk, Z = np.column_stack([price, exog]), np.column_stack([cost, exog])
        bread_o = np.linalg.pinv(Xk.T @ Xk)
        b_ols = bread_o @ Xk.T @ yk
        fit.total_ols = float(b_ols[0])
        fit.total_ols_se = float(np.sqrt(_cluster_cov(Xk, yk - Xk @ b_ols, wk, bread_o)[0, 0]))
        bread_z = np.linalg.pinv(Z.T @ Z)
        pi = bread_z @ Z.T @ price
        fit.pass_through = float(pi[0])
        fit.first_stage_f = float(pi[0] ** 2 / _cluster_cov(Z, price - Z @ pi, wk, bread_z)[0, 0])
        proj = Z @ (bread_z @ (Z.T @ Xk))
        bread_iv = np.linalg.pinv(proj.T @ proj)
        b_iv = bread_iv @ proj.T @ yk
        fit.total_iv = float(b_iv[0])
        fit.total_iv_se = float(np.sqrt(_cluster_cov(proj, yk - Xk @ b_iv, wk, bread_iv)[0, 0]))
    return fit


def fit_category(frame: pd.DataFrame, **kwargs) -> list[ItemFit]:
    n_items = int(frame["item"].max()) + 1
    return [fit_item(frame, i, n_items, **kwargs) for i in range(n_items)]
