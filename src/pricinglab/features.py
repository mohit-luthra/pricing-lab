"""Turn the clean panel into a modelling frame for the current assortment of one category.

One row per item x store x week with: regular price, discount depth, deal flag, last week's
discount (for the post-promotion dip), every competing item's price, and cost instruments.
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from .config import WEEK1_START

LAST_WEEK = 399
N_ITEMS = 10               # items per category in the simulator
RECENT_WEEKS = 104         # "current assortment" = ranked on the last two years
MIN_HISTORY_WEEKS = 150
MIN_RECENT_STORES = 80
PROMO_THRESHOLD = 0.05     # a price at least 5% under regular counts as a promotion
REG_WINDOW = 6             # regular price = highest price within +/- 6 weeks


def select_items(data_dir: Path, code: str, n_items: int = N_ITEMS) -> pd.DataFrame:
    """Top items by recent revenue that are still on shelf chain-wide and have enough history."""
    panel = data_dir / f"{code}_panel.parquet"
    return duckdb.sql(f"""
        SELECT upc, any_value(descrip) AS descrip, any_value(size_oz) AS size_oz,
               sum(revenue) FILTER (WHERE week > {LAST_WEEK - RECENT_WEEKS}) AS recent_revenue,
               count(DISTINCT week) AS weeks,
               count(DISTINCT store) FILTER (WHERE week > {LAST_WEEK - 26}) AS recent_stores
        FROM '{panel}' GROUP BY upc
        HAVING weeks >= {MIN_HISTORY_WEEKS} AND recent_stores >= {MIN_RECENT_STORES}
        ORDER BY recent_revenue DESC LIMIT {int(n_items)}
    """).df()


def _easter(year: int) -> date:
    """Anonymous Gregorian algorithm."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    j, k = c // 4, c % 4
    m = (a + 11 * h) // 319
    r = (2 * e + 2 * j - k - h + m + 32) % 7
    month = (h - m + r + 90) // 25
    return date(year, month, (h - m + r + month + 19) % 32)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th given weekday of a month; n = -1 means the last one."""
    if n > 0:
        d = date(year, month, 1)
        return d + timedelta(days=(weekday - d.weekday()) % 7 + 7 * (n - 1))
    d = date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def holiday_weeks(first_week: int = 1, last_week: int = LAST_WEEK) -> pd.DataFrame:
    """0/1 flags for the Dominick's weeks that contain each major US shopping holiday."""
    weeks = np.arange(first_week, last_week + 1)
    out = pd.DataFrame({"week": weeks})
    start_of = lambda w: WEEK1_START + timedelta(days=7 * (int(w) - 1))
    week_of = lambda d: (d - WEEK1_START).days // 7 + 1
    years = range(start_of(first_week).year, start_of(last_week).year + 2)
    events = {
        "easter": [_easter(y) for y in years],
        "memorial": [_nth_weekday(y, 5, 0, -1) for y in years],
        "july4": [date(y, 7, 4) for y in years],
        "labor": [_nth_weekday(y, 9, 0, 1) for y in years],
        "thanksgiving": [_nth_weekday(y, 11, 3, 4) for y in years],
        "christmas": [date(y, 12, 25) for y in years],
        "newyear": [date(y, 1, 1) for y in years],
    }
    for name, dates in events.items():
        out[f"h_{name}"] = out["week"].isin({week_of(d) for d in dates}).astype(float)
    return out


def build_frame(data_dir: Path, code: str, items: pd.DataFrame | None = None) -> pd.DataFrame:
    """Modelling frame. Columns: item (0..K-1), store, week, ln_q, ln_reg, ln_disc, promo_on, deal_b, deal_s,
    deal_o, lag_depth, x_0..x_{K-1} (log price of every item, own column included), ln_cost_reg,
    ln_cost_disc, quarter, plus holiday flags."""
    items = select_items(data_dir, code) if items is None else items
    upcs = items["upc"].tolist()
    panel = data_dir / f"{code}_panel.parquet"
    df = duckdb.sql(f"""
        SELECT upc, store, week, units, unit_price, deal AS deal_code, unit_cost,
               max(unit_price) OVER w AS reg_price, max(unit_cost) OVER w AS reg_cost
        FROM '{panel}' WHERE upc IN ({','.join(map(str, upcs))})
        WINDOW w AS (PARTITION BY upc, store ORDER BY week
                     RANGE BETWEEN {REG_WINDOW} PRECEDING AND {REG_WINDOW} FOLLOWING)
        ORDER BY upc, store, week
    """).df()
    df["item"] = df["upc"].map({u: i for i, u in enumerate(upcs)}).astype(int)
    df["ln_q"] = np.log(df["units"])
    df["ln_p"] = np.log(df["unit_price"])
    df["ln_reg"] = np.log(df["reg_price"])
    df["ln_disc"] = df["ln_p"] - df["ln_reg"]                       # <= 0, zero when not discounted
    # Hi-lo products respond to "being on promotion at all", then to how deep the cut is.
    df["promo_on"] = (df["ln_disc"] < np.log(1 - PROMO_THRESHOLD)).astype(float)
    # Deal types behave very differently: S (advertised price reduction) lifts far more than
    # B (bonus-buy shelf tag). Coupons and the undocumented G code are controlled for only.
    df["deal_b"] = (df["deal_code"] == "B").astype(float)
    df["deal_s"] = (df["deal_code"] == "S").astype(float)
    df["deal_o"] = (~df["deal_code"].isin(["none", "B", "S"])).astype(float)
    df["ln_cost_reg"] = np.log(df["reg_cost"])
    df["ln_cost_disc"] = np.log(df["unit_cost"]) - df["ln_cost_reg"]

    # Last week's discount depth for the same item and store (0 when not discounted or not sold).
    prev = df[["item", "store", "week", "ln_disc"]].assign(week=lambda d: d["week"] + 1)
    df = df.merge(prev.rename(columns={"ln_disc": "prev_disc"}), on=["item", "store", "week"], how="left")
    df["lag_depth"] = -df["prev_disc"].fillna(0.0)

    # Every item's price in that store-week. Gaps (item not sold there that week) take the
    # chain's median price for the week, then the item's overall median.
    wide = df.pivot(index=["store", "week"], columns="item", values="ln_p")
    chain = df.groupby(["week", "item"])["ln_p"].median().unstack("item")
    wide = wide.fillna(chain.reindex(wide.index.get_level_values("week")).set_axis(wide.index))
    wide = wide.fillna(df.groupby("item")["ln_p"].median())
    wide.columns = [f"x_{j}" for j in wide.columns]
    df = df.merge(wide.reset_index(), on=["store", "week"], how="left")

    start = pd.to_datetime(WEEK1_START) + pd.to_timedelta((df["week"] - 1) * 7, unit="D")
    df["quarter"] = start.dt.year * 10 + start.dt.quarter
    df = df.merge(holiday_weeks(), on="week", how="left")
    return df.drop(columns=["prev_disc", "deal_code"]).reset_index(drop=True)
