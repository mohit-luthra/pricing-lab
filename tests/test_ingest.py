"""End-to-end ingest on a tiny hand-built file where every expected outcome is known."""
from datetime import date

import pandas as pd
import pytest

from pricinglab.config import Category
from pricinglab.ingest import build_panel

CAT = Category("zzz", "Test", keep_pattern=r"TUNA")
HEADER = "STORE,UPC,WEEK,MOVE,QTY,PRICE,SALE,PROFIT,OK,PRICE_HEX,PROFIT_HEX\n"
ROWS = [
    "2,111,1,10,1,1.00,,25,1,x,x",      # keep: plain week
    "2,111,2,30,2,1.60,B,10,1,x,x",     # keep: 2-for-1.60 bonus buy -> unit price 0.80
    "2,111,3,0,1,0,,0,1,x,x",           # drop: no sales
    "2,111,4,5,1,1.00,,25,0,x,x",       # drop: OK = 0
    "2,111,5,5,1,50.00,,25,1,x,x",      # drop: 50x the median price
    "2,111,6,5,1,1.00,,99.9,1,x,x",     # keep, but margin unusable -> no cost
    "2,222,1,5,1,2.00,,25,1,x,x",       # drop: sardines are out of scope
    "2,999,1,5,1,2.00,,25,1,x,x",       # drop: UPC missing from master
    "2,111,7,5,1,1.00,Z,25,1,x,x",      # keep: unknown deal code -> 'other'
]


@pytest.fixture()
def panel(tmp_path):
    raw, out = tmp_path / "raw", tmp_path / "out"
    raw.mkdir()
    (raw / "wzzz.csv").write_text(HEADER + "\n".join(ROWS) + "\n")
    (raw / "upczzz.csv").write_text(
        "COM_CODE,UPC,DESCRIP,SIZE,CASE,NITEM\n1,111,~STARKIST TUNA,6 OZ,24,1\n1,222,SARDINES,4 OZ,24,2\n"
    )
    audit = build_panel(raw, out, CAT)
    return audit, pd.read_parquet(out / "zzz_panel.parquet").set_index("week")


def test_audit_reconciles(panel):
    audit, df = panel
    assert audit["raw_rows"] == len(ROWS)
    assert audit["clean_rows"] == len(df) == 4
    assert audit["dropped"] == {
        "no_sales_that_week": 1, "flagged_bad_by_dominicks": 1, "price_outlier": 1,
        "out_of_scope_product": 1, "upc_not_in_master": 1,
    }


def test_multibuy_price_and_revenue(panel):
    _, df = panel
    assert df.loc[2, "unit_price"] == pytest.approx(0.80)
    assert df.loc[2, "revenue"] == pytest.approx(24.0)
    assert df.loc[2, "deal"] == "B" and df.loc[2, "on_deal"]
    assert df.loc[1, "deal"] == "none" and not df.loc[1, "on_deal"]
    assert df.loc[7, "deal"] == "other"


def test_cost_from_margin(panel):
    _, df = panel
    assert df.loc[1, "unit_cost"] == pytest.approx(0.75)
    assert not df.loc[6, "cost_ok"] and pd.isna(df.loc[6, "unit_cost"])


def test_dates_sizes_and_name_cleanup(panel):
    _, df = panel
    assert pd.Timestamp(df.loc[1, "week_start"]).date() == date(1989, 9, 14)
    assert pd.Timestamp(df.loc[2, "week_start"]).date() == date(1989, 9, 21)
    assert df.loc[1, "price_per_oz"] == pytest.approx(1 / 6)
    assert df.loc[1, "descrip"] == "STARKIST TUNA"


def test_missing_file_is_a_clear_error(tmp_path):
    with pytest.raises(FileNotFoundError, match="wzzz.csv"):
        build_panel(tmp_path, tmp_path / "out", CAT)
