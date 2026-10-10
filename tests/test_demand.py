"""The estimators must recover parameters we planted in simulated data."""
import numpy as np
import pandas as pd
import pytest

from pricinglab.demand import OWN, fit_category
from pricinglab.features import _easter, holiday_weeks
from pricinglab.hierarchy import fit_hierarchy

TRUE = {"ln_reg": -2.0, "ln_disc": -3.5, "promo_on": 0.3, "deal_b": 0.2, "deal_s": 0.7, "lag_depth": -0.6}
CROSS = 0.4


def simulate_frame(n_stores=30, n_weeks=200, seed=0, store_sd=0.0):
    rng = np.random.default_rng(seed)
    rows = []
    reg = {i: np.log(2.0 + i) + np.cumsum(rng.normal(0, 0.01, n_weeks)) for i in (0, 1)}
    disc = {i: np.where(rng.random(n_weeks) < 0.25, -rng.uniform(0.06, 0.4, n_weeks), 0.0) for i in (0, 1)}
    kind = {i: rng.choice(["B", "S", "N"], n_weeks) for i in (0, 1)}
    slope = TRUE["ln_disc"] + store_sd * rng.standard_normal(n_stores)
    for s in range(n_stores):
        for i in (0, 1):
            on = disc[i] < 0
            b, sflag = on & (kind[i] == "B"), on & (kind[i] == "S")
            lag = np.r_[0.0, -disc[i][:-1]]
            other = reg[1 - i] + disc[1 - i]
            ln_q = (3 + 0.1 * s + TRUE["ln_reg"] * reg[i] + slope[s] * disc[i] + TRUE["promo_on"] * on
                    + TRUE["deal_b"] * b + TRUE["deal_s"] * sflag + TRUE["lag_depth"] * lag
                    + CROSS * other + rng.normal(0, 0.2, n_weeks))
            rows.append(pd.DataFrame({
                "item": i, "store": s, "week": np.arange(1, n_weeks + 1), "ln_q": ln_q,
                "ln_reg": reg[i], "ln_disc": disc[i], "promo_on": on.astype(float),
                "deal_b": b.astype(float), "deal_s": sflag.astype(float), "deal_o": 0.0, "lag_depth": lag,
                "ln_p": reg[i] + disc[i], "x_0": reg[0] + disc[0], "x_1": reg[1] + disc[1],
                "unit_cost": np.exp(reg[i] + 0.5 * disc[i] - 0.4), "quarter": 19900 + np.arange(n_weeks) // 13,
            }))
    df = pd.concat(rows, ignore_index=True)
    return df.merge(holiday_weeks(1, n_weeks), on="week")


@pytest.fixture(scope="module")
def fits():
    return fit_category(simulate_frame())


@pytest.fixture(scope="module")
def varied_fits():
    return fit_category(simulate_frame(store_sd=0.5))


def test_pooled_fit_recovers_planted_coefficients(fits):
    for fit in fits:
        est = dict(zip(fit.names, fit.beta))
        for name in OWN:
            assert est[name] == pytest.approx(TRUE[name], abs=0.15), name
        cross_name = [n for n in fit.names if n.startswith("x_")][0]
        assert est[cross_name] == pytest.approx(CROSS, abs=0.1)


def test_standard_errors_are_honest(fits):
    # the planted value should sit inside +/- 4 standard errors of every estimate
    for fit in fits:
        se = np.sqrt(np.diag(fit.cov))
        for j, name in enumerate(OWN):
            assert abs(fit.beta[j] - TRUE[name]) < 4 * se[j] + 0.05, name


def test_store_slopes_vary_and_instrument_is_strong(varied_fits):
    fit = varied_fits[0]
    assert len(fit.stores) == 30
    assert fit.store_beta[:, 1].std() == pytest.approx(0.5, abs=0.2)
    assert fit.first_stage_f > 10
    assert fit.total_iv == pytest.approx(fit.total_ols, abs=1.0)


def test_never_promoted_item_is_marked_unknown_not_zero():
    df = simulate_frame(n_stores=10)
    df.loc[df["item"] == 0, "deal_s"] = 0.0
    fit = fit_category(df, by_store=False, instrumented=False)[0]
    j = OWN.index("deal_s")
    assert fit.beta[j] == 0.0 and fit.cov[j, j] == 25.0


def test_hierarchy_shrinks_noisy_estimates_toward_the_category(fits):
    import copy
    j = OWN.index("ln_reg")
    items = []
    for n in range(6):                         # six items that all look alike...
        f = copy.deepcopy(fits[n % 2])
        f.item = n
        f.beta = np.r_[f.beta[:len(OWN)], np.full(5, CROSS)]
        cov = np.eye(len(OWN) + 5) * 0.01
        cov[:len(OWN), :len(OWN)] = f.cov[:len(OWN), :len(OWN)]
        f.cov = cov
        items.append(f)
    items[0].beta[j] = 3.0                     # ...except one absurd, very uncertain estimate
    items[0].cov[j, :], items[0].cov[:, j] = 0.0, 0.0
    items[0].cov[j, j] = 9.0
    post = fit_hierarchy(items, draws=200, warmup=500, chains=2)
    assert post.own.shape == (200, 6, 6) and post.cross.shape == (200, 6, 6)
    assert post.own[:, 0, j].mean() < 0                              # pulled from +3 to the pack
    assert post.own[:, 1, j].mean() == pytest.approx(items[1].beta[j], abs=0.3)   # precise one stays
    assert post.max_rhat < 1.1
    assert np.allclose(post.cross[:, np.arange(6), np.arange(6)], 0)
    assert post.cross[:, 0, 1].mean() == pytest.approx(CROSS, abs=0.1)
    assert len(post.store_dev) == 6 and post.store_dev[0].shape == (30, 2)


def test_easter_and_holiday_weeks():
    from datetime import date
    assert _easter(1990) == date(1990, 4, 15) and _easter(1997) == date(1997, 3, 30)
    h = holiday_weeks()
    assert h.loc[h["h_thanksgiving"] == 1, "week"].iloc[0] == 11   # 23 Nov 1989
    assert h.drop(columns="week").sum().between(7, 8).all()
