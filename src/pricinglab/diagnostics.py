"""Is each product fit for elasticity estimation? Coverage and price-variation checks.

Run:  python -m pricinglab.diagnostics --data data/processed
"""
from __future__ import annotations

import argparse
from pathlib import Path

import duckdb
import pandas as pd

from .config import CATEGORIES

# A product needs breadth (stores), history (weeks) and real price movement to be modelled.
MIN_STORES = 60
MIN_WEEKS = 150
MIN_PRICE_CV = 0.03


def sku_summary(data_dir: Path, code: str) -> pd.DataFrame:
    """One row per UPC: size of the business, coverage, and how much its price actually moves."""
    panel = data_dir / f"{code}_panel.parquet"
    if not panel.exists():
        raise FileNotFoundError(f"{panel} not found. Run pricinglab.ingest first.")
    df = duckdb.sql(f"""
        WITH by_store AS (
            SELECT upc, store, stddev_samp(ln(unit_price)) AS sd_log_price
            FROM '{panel}' GROUP BY upc, store
        ), variation AS (
            SELECT upc, median(sd_log_price) AS price_cv FROM by_store GROUP BY upc
        )
        SELECT p.upc, any_value(p.descrip) AS descrip, any_value(p.size_oz) AS size_oz,
               sum(p.revenue) AS revenue, sum(p.units) AS units,
               count(DISTINCT p.store) AS stores, count(DISTINCT p.week) AS weeks,
               min(p.week) AS first_week, max(p.week) AS last_week,
               median(p.unit_price) AS median_price,
               avg(p.on_deal::INT) AS share_on_deal,
               avg(CASE WHEN p.cost_ok THEN 1 - p.unit_cost / p.unit_price END) AS avg_margin,
               any_value(v.price_cv) AS price_cv
        FROM '{panel}' p JOIN variation v USING (upc)
        GROUP BY p.upc ORDER BY revenue DESC
    """).df()
    df["revenue_share"] = df["revenue"] / df["revenue"].sum()
    df["modelable"] = (
        (df["stores"] >= MIN_STORES) & (df["weeks"] >= MIN_WEEKS) & (df["price_cv"] >= MIN_PRICE_CV)
    )
    return df


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", type=Path, default=Path("data/processed"))
    args = ap.parse_args(argv)
    for code, cat in CATEGORIES.items():
        s = sku_summary(args.data, code)
        s.to_csv(args.data / f"{code}_sku_summary.tsv", sep="\t", index=False)
        ok = s[s["modelable"]]
        print(f"{cat.name}: {len(ok)} of {len(s)} UPCs modelable, "
              f"covering {ok['revenue_share'].sum():.0%} of revenue")


if __name__ == "__main__":
    main()
