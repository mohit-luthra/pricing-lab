import math

import pytest

from pricinglab.sizes import OZ_PER_LITRE, parse_size_oz


@pytest.mark.parametrize("raw,expected", [
    ("6 OZ", 6.0), ("16 OZ.", 16.0), ("3.25OZ", 3.25), ("12.5 O", 12.5), ("10.25O", 10.25),
    ("6/12OZ", 72.0), ("24/12O", 288.0), ("3/3 OZ", 9.0), ("27/8.4", 226.8), ("64.0", 64.0),
    ("2 LT", 2 * OZ_PER_LITRE), ("1.5 LT", 1.5 * OZ_PER_LITRE), ("3 LITE", 3 * OZ_PER_LITRE),
])
def test_volume_sizes(raw, expected):
    assert parse_size_oz(raw) == pytest.approx(expected)


def test_truncated_L_depends_on_category():
    assert parse_size_oz("17.7 L", weight_category=True) == pytest.approx(17.7 * 16)
    assert parse_size_oz("2 L") == pytest.approx(2 * OZ_PER_LITRE)
    assert parse_size_oz("25 LB", weight_category=True) == 400.0


@pytest.mark.parametrize("raw", ["50 CT", "3 EA", "42USES", "4 PACK", "", "FREEC", None, float("nan")])
def test_counts_and_garbage_are_nan(raw):
    assert math.isnan(parse_size_oz(raw))
