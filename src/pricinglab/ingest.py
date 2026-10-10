"""Raw Dominick's CSVs -> one clean store x product x week panel per category.

Every row removed is counted in an audit so the cleaning is explainable, not silent.
Run:  python -m pricinglab.ingest --raw data/raw --out data/processed
"""
from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

import duckdb
import pandas as pd

from .config import CATEGORIES, DEAL_CODES, RULES, WEEK1_START, Category, CleaningRules
from .sizes import parse_size_oz

log = logging.getLogger(__name__)

MOVEMENT_TYPES = {
    "STORE": "INTEGER", "UPC": "BIGINT", "WEEK": "INTEGER", "MOVE": "INTEGER",
    "QTY": "INTEGER", "PRICE": "DOUBLE", "SALE": "VARCHAR", "PROFIT": "DOUBLE",
    "OK": "INTEGER", "PRICE_HEX": "VARCHAR", "PROFIT_HEX": "VARCHAR",
}


def load_products(raw_dir: Path, cat: Category) -> pd.DataFrame:
    """UPC master with parsed size. One row per UPC."""
    path = raw_dir / f"upc{cat.code}.csv"
    if not path.exists():
        raise FileNotFoundError(f"Missing product file: {path}")
    df = pd.read_csv(path, encoding="latin-1", dtype={"UPC": "int64"})
    df.columns = [c.lower() for c in df.columns]
    if df["upc"].duplicated().any():
        raise ValueError(f"{path.name}: duplicate UPCs in product master")
    # Leading ~ $ and stray bytes are Dominick's internal status flags, not part of the name.
    df["descrip"] = df["descrip"].astype(str).str.replace(r"^[^A-Za-z0-9]+", "", regex=True).str.strip()
    df["size_oz"] = [parse_size_oz(s, weight_category=cat.code == "lnd") for s in df["size"]]
    df["in_scope"] = (
        df["descrip"].str.contains(cat.keep_pattern, case=False, regex=True)
        if cat.keep_pattern else True
    )
    return df[["upc", "descrip", "size", "size_oz", "nitem", "com_code", "in_scope"]]


def build_panel(raw_dir: Path, out_dir: Path, cat: Category, rules: CleaningRules = RULES) -> dict:
    """Clean one category and write `<code>_panel.parquet`. Returns the row audit."""
    movement = raw_dir / f"w{cat.code}.csv"
    if not movement.exists():
        raise FileNotFoundError(f"Missing movement file: {movement}")
    out_dir.mkdir(parents=True, exist_ok=True)
    products = load_products(raw_dir, cat)

    con = duckdb.connect()
    con.execute(f"SET temp_directory = '{out_dir / '.duckdb_tmp'}'")  # spill big sorts to disk
    con.register("products", products)
    con.read_csv(str(movement), header=True, columns=MOVEMENT_TYPES).create_view("mv")
    # Filters run in this order; each row is counted against the first rule it fails.
    con.execute(f"""
        CREATE TEMP TABLE staged AS
        SELECT m.STORE AS store, m.UPC AS upc, m.WEEK AS week, m.MOVE AS units,
               m.PRICE / NULLIF(m.QTY, 0) AS unit_price, m.PROFIT AS margin_pct,
               upper(trim(coalesce(m.SALE, ''))) AS sale,
               p.upc IS NOT NULL AS has_product, coalesce(p.in_scope, false) AS in_scope,
               CASE WHEN m.OK IS DISTINCT FROM 1 THEN 'flagged_bad_by_dominicks'
                    WHEN m.MOVE IS NULL OR m.MOVE <= 0 THEN 'no_sales_that_week'
                    WHEN m.PRICE IS NULL OR m.PRICE <= 0 OR m.QTY IS NULL OR m.QTY < 1 THEN 'no_valid_price'
                    WHEN p.upc IS NULL THEN 'upc_not_in_master'
                    WHEN NOT p.in_scope THEN 'out_of_scope_product'
               END AS drop_reason
        FROM mv m LEFT JOIN products p ON p.upc = m.UPC
    """)
    con.execute("""
        CREATE TEMP TABLE med AS
        SELECT upc, median(unit_price) AS med_price FROM staged
        WHERE drop_reason IS NULL GROUP BY upc
    """)
    con.execute(f"""
        UPDATE staged SET drop_reason = 'price_outlier' FROM med
        WHERE staged.upc = med.upc AND staged.drop_reason IS NULL
          AND (staged.unit_price > med.med_price * {rules.price_outlier_factor}
            OR staged.unit_price < med.med_price / {rules.price_outlier_factor})
    """)

    audit = {"category": cat.code, "raw_rows": con.execute("SELECT count(*) FROM staged").fetchone()[0]}
    audit["dropped"] = dict(con.execute(
        "SELECT drop_reason, count(*) FROM staged WHERE drop_reason IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"
    ).fetchall())

    deals = ", ".join(f"'{d}'" for d in DEAL_CODES)
    out_path = out_dir / f"{cat.code}_panel.parquet"
    con.execute(f"""
        COPY (
            SELECT s.store, s.upc, s.week,
                   DATE '{WEEK1_START.isoformat()}' + (s.week - 1) * 7 AS week_start,
                   s.units, s.unit_price, s.units * s.unit_price AS revenue,
                   CASE WHEN s.sale = '' THEN 'none' WHEN s.sale IN ({deals}) THEN s.sale ELSE 'other' END AS deal,
                   s.sale <> '' AS on_deal,
                   s.margin_pct BETWEEN {rules.margin_min_pct} AND {rules.margin_max_pct} AS cost_ok,
                   CASE WHEN s.margin_pct BETWEEN {rules.margin_min_pct} AND {rules.margin_max_pct}
                        THEN s.unit_price * (1 - s.margin_pct / 100) END AS unit_cost,
                   p.size_oz, s.unit_price / p.size_oz AS price_per_oz,
                   p.descrip, p.nitem, p.com_code
            FROM staged s JOIN products p USING (upc)
            WHERE s.drop_reason IS NULL
            ORDER BY s.upc, s.store, s.week
        ) TO '{out_path}' (FORMAT parquet, COMPRESSION zstd)
    """)
    stats = con.execute(f"""
        SELECT count(*), count(DISTINCT store), count(DISTINCT upc), min(week), max(week),
               min(week_start), max(week_start), sum(revenue), avg(on_deal::INT), avg(cost_ok::INT),
               count(*) FILTER (WHERE size_oz IS NULL)
        FROM '{out_path}'
    """).fetchone()
    keys = ["clean_rows", "stores", "upcs", "week_min", "week_max", "date_min", "date_max",
            "revenue", "share_on_deal", "share_cost_usable", "rows_without_size"]
    audit.update({k: (str(v) if "date" in k else v) for k, v in zip(keys, stats)})
    dupes = con.execute(
        f"SELECT count(*) FROM (SELECT 1 FROM '{out_path}' GROUP BY store, upc, week HAVING count(*) > 1)"
    ).fetchone()[0]
    if dupes:
        raise ValueError(f"{cat.code}: {dupes} duplicate store-upc-week keys after cleaning")
    if audit["clean_rows"] + sum(audit["dropped"].values()) != audit["raw_rows"]:
        raise ValueError(f"{cat.code}: audit does not reconcile to raw row count")
    con.close()
    log.info("%s: kept %s of %s rows", cat.code, f"{audit['clean_rows']:,}", f"{audit['raw_rows']:,}")
    return audit


def build_stores(raw_dir: Path, out_dir: Path) -> int:
    """Store attributes used as demand shifters and for the price-zone structure."""
    path = raw_dir / "demo.dta"
    if not path.exists():
        raise FileNotFoundError(f"Missing demographics file: {path}")
    cols = ["store", "city", "zone", "income", "educ", "age60", "age9", "ethnic", "hsizeavg",
            "workwom", "hvalmean", "density", "poverty", "cubdist", "omnidist", "priclow",
            "pricmed", "prichigh"]
    df = pd.read_stata(path, columns=cols).dropna(subset=["store"])
    df["store"] = df["store"].astype(int)
    df = df.drop_duplicates("store").sort_values("store")
    out_dir.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_dir / "stores.parquet", index=False)
    return len(df)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--out", type=Path, default=Path("data/processed"))
    ap.add_argument("--categories", nargs="*", default=list(CATEGORIES), choices=list(CATEGORIES))
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    audits = [build_panel(args.raw, args.out, CATEGORIES[c]) for c in args.categories]
    n_stores = build_stores(args.raw, args.out)
    log.info("stores: %s", n_stores)
    (args.out / "ingest_audit.json").write_text(json.dumps(audits, indent=2, default=str))


if __name__ == "__main__":
    main()
