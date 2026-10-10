"""Data sanity check, not the model: pooled own-price elasticity per category.

log(units) ~ log(price) [+ deal flag] with product-store and week fixed effects, SEs clustered
by store. If the cleaned data is sound these should be clearly negative and should shrink
once the deal flag absorbs the promotion lift.
"""
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from linearmodels.iv.absorbing import AbsorbingLS

from pricinglab.config import CATEGORIES
from pricinglab.diagnostics import sku_summary

TOP_N = 20
data = Path(sys.argv[1] if len(sys.argv) > 1 else "data/processed")
rows = []
for code, cat in CATEGORIES.items():
    top = sku_summary(data, code).query("modelable").head(TOP_N)["upc"].tolist()
    df = duckdb.sql(
        f"SELECT store, upc, week, units, unit_price, on_deal FROM '{data / (code + '_panel.parquet')}' "
        f"WHERE upc IN ({','.join(map(str, top))})"
    ).df()
    df["ln_q"], df["ln_p"] = np.log(df["units"]), np.log(df["unit_price"])
    df["deal"] = df["on_deal"].astype(float)
    absorb = pd.DataFrame({
        "sku_store": (df["upc"].astype(str) + "_" + df["store"].astype(str)).astype("category"),
        "week": df["week"].astype("category"),
    })
    out = {"category": cat.name, "skus": len(top), "rows": len(df)}
    for label, cols in (("price_only", ["ln_p"]), ("with_deal_flag", ["ln_p", "deal"])):
        fit = AbsorbingLS(df["ln_q"], df[cols], absorb=absorb).fit(cov_type="clustered", clusters=df["store"])
        out[f"elasticity_{label}"] = round(fit.params["ln_p"], 2)
        out[f"se_{label}"] = round(fit.std_errors["ln_p"], 3)
    out["deal_lift_pct"] = round((np.exp(fit.params["deal"]) - 1) * 100)
    rows.append(out)
print(pd.DataFrame(rows).to_csv(sep="\t", index=False))
