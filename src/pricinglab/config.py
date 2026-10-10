"""Single source of truth for categories, cleaning thresholds and dates."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

# Dominick's week 1 runs 1989-09-14 (Thu) to 1989-09-20 (data manual, week table).
WEEK1_START = date(1989, 9, 14)


@dataclass(frozen=True)
class Category:
    code: str          # three-letter Dominick's acronym, used in file names
    name: str
    # Regex on DESCRIP that keeps only the products that compete with each other.
    # None keeps everything.
    keep_pattern: str | None = None


CATEGORIES: dict[str, Category] = {
    "tna": Category("tna", "Canned tuna", keep_pattern=(
        # The file is really "canned seafood" (sardines, caviar, clams). Names are cut at 20
        # chars, so tuna is matched on the cut forms too. Seasoning "mix-ins" are excluded.
        r"^(?!.*MIX.IN).*(?:TUNA|ALBACORE|TONGOL|\bTUN?$|CHUNK|CHNK|CNK|\bCHK\b|\bCH LT|SOLID|\bSLD\b|PRIME C|BEE DIET)"
    )),
    "bjc": Category("bjc", "Bottled juices"),
    "lnd": Category("lnd", "Laundry detergents"),
    "sdr": Category("sdr", "Soft drinks"),
}


@dataclass(frozen=True)
class CleaningRules:
    # A unit price further than this factor from the product's own median is a keying error.
    price_outlier_factor: float = 5.0
    # Gross margin (PROFIT, in percent) outside this band makes the implied cost unusable.
    margin_min_pct: float = -50.0
    margin_max_pct: float = 90.0


RULES = CleaningRules()

# Deal codes in the SALE column. B = bonus buy, S = simple price reduction, C = coupon.
# G is undocumented in the manual; kept as its own level rather than guessed at.
DEAL_CODES = ("B", "S", "C", "G")

# Readable names for the simulator. Dominick's descriptions are cut at 20 characters.
DISPLAY_NAMES: dict[int, str] = {
    8000000245: "StarKist Chunk Light in Water 6 oz", 8660000033: "Bumble Bee Chunk Light in Water 6 oz",
    4800000024: "Chicken of the Sea Chunk Light 6 oz", 8660000001: "Bumble Bee Solid White 12 oz",
    3828105005: "Store Brand Chunk Light 6.5 oz", 8660000002: "Bumble Bee Solid White 6 oz",
    7114010110: "Geisha White Tuna 6 oz", 4800001164: "Chicken of the Sea Chunk Light 12.5 oz",
    7760015227: "3 Diamonds Solid White 6 oz", 8000000141: "StarKist Solid White 6 oz",
    1480000034: "Mott's Apple Juice 64 oz", 3828103017: "Store Brand Apple Juice 64 oz",
    3120020007: "Ocean Spray Cranberry Cocktail 64 oz", 3120020005: "Ocean Spray Cranberry Cocktail 48 oz",
    4180022700: "Welch's White Grape Juice 64 oz", 1480031656: "Mott's Natural Apple Juice 64 oz",
    3828103091: "Store Brand Apple Juice 128 oz", 3120020010: "Ocean Spray Cranberry Cocktail 128 oz",
    3120027627: "Ocean Spray Ruby Red Grapefruit 64 oz", 4180020750: "Welch's Grape Juice 64 oz",
    3700092291: "Tide Liquid 100 oz", 3700091829: "Tide with Bleach Liquid 100 oz",
    3700092297: "Tide Free Liquid 100 oz", 3700097081: "Cheer Liquid 100 oz",
    3700091856: "Tide with Bleach Liquid 200 oz", 3700092263: "Tide Liquid 200 oz",
    3700091493: "Era Liquid 100 oz", 3700092290: "Tide Liquid 50 oz", 3700090404: "Dreft Liquid 50 oz",
    3700091828: "Tide with Bleach Liquid 50 oz",
    420: "Pepsi 24-pack cans", 450: "Coca-Cola Classic 24-pack cans", 451: "Diet Coke 24-pack cans",
    421: "Diet Pepsi 24-pack cans", 440: "7-Up 24-pack cans", 4900000639: "Coca-Cola Classic 2 L",
    1200000013: "Pepsi 6-pack cans", 1200000230: "Pepsi 2 L", 1200000017: "Pepsi 24-pack cans (second code)",
    430: "RC Cola 24-pack cans",
}
