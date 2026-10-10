"""Parse Dominick's free-text SIZE field into fluid/avoirdupois ounces per selling unit."""
from __future__ import annotations

import math
import re

OZ_PER_LITRE = 33.814
OZ_PER_LB = 16.0

# "6/12OZ" -> pack 6, amount 12, unit OZ.  "2 LT" -> pack 1, amount 2, unit LT.
_SIZE_RE = re.compile(r"^\s*(?:(\d+)\s*/\s*)?(\d*\.?\d+)\s*([A-Z]*)")


def _unit_factor(unit: str, weight_category: bool) -> float | None:
    """Ounces per one unit, or None when the unit is a count (CT, EA, PK) or unknown."""
    if unit in ("", "O", "OZ", "OZNR"):
        return 1.0                      # field is 6 chars wide, so OZ is often cut to "O"
    if unit.startswith("LT") or unit == "LITE":
        return OZ_PER_LITRE             # LT, LTR, LTRE, and "3 LITE" (truncated LITER)
    if unit == "LB":
        return OZ_PER_LB
    if unit == "L":
        # Truncation makes "L" ambiguous: pounds for detergent powder, litres for drinks.
        return OZ_PER_LB if weight_category else OZ_PER_LITRE
    return None


def parse_size_oz(size: object, weight_category: bool = False) -> float:
    """Total ounces in one selling unit. NaN when the size is a count or cannot be read.

    >>> parse_size_oz("6/12OZ")
    72.0
    >>> round(parse_size_oz("2 LT"), 1)
    67.6
    >>> parse_size_oz("25 LB", weight_category=True)
    400.0
    >>> math.isnan(parse_size_oz("50 CT"))
    True
    """
    if not isinstance(size, str):
        return math.nan
    m = _SIZE_RE.match(size.upper())
    if not m:
        return math.nan
    pack, amount, unit = m.groups()
    factor = _unit_factor(unit, weight_category)
    if factor is None:
        return math.nan
    oz = (int(pack) if pack else 1) * float(amount) * factor
    return oz if oz > 0 else math.nan
