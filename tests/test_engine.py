"""Engine results checked against numbers worked out by hand."""
import numpy as np
import pytest

from pricinglab.engine import optimize_prices, price_lines, simulate_prices, simulate_promo
from conftest import make_model


def test_no_change_means_no_delta(model):
    r = simulate_prices(model, [2.0, 3.0, 1.0], weeks=4)
    assert r["delta"]["profit"]["p50"] == pytest.approx(0, abs=1e-9)
    assert r["probProfitUp"] == 0.0


def test_single_price_change_matches_hand_calculation():
    m = make_model(cross=0.0)
    r = simulate_prices(m, [2.2, 3.0, 1.0], noise=False)
    units = 1000 * 1.1 ** -2.0                                   # elasticity -2, price +10%
    assert r["items"][0]["unitsChangePct"]["p50"] == pytest.approx(1.1 ** -2.0 - 1)
    assert r["delta"]["profit"]["mean"] == pytest.approx(units * (2.2 - 1.2) - 1000 * 0.8)
    assert r["delta"]["revenue"]["mean"] == pytest.approx(units * 2.2 - 2000)
    # margin goes 0.8 -> 1.0, so volume may fall 20% before profit is worse
    assert r["items"][0]["breakEvenUnitsChangePct"] == pytest.approx(0.8 / 1.0 - 1)


def test_cross_effect_moves_volume_to_other_items(model):
    r = simulate_prices(model, [2.2, 3.0, 1.0], noise=False)
    assert r["items"][1]["unitsChangePct"]["p50"] == pytest.approx(1.1 ** 0.2 - 1)


def test_weeks_scale_linearly_without_noise(model):
    one = simulate_prices(model, [2.1, 3.1, 1.0], weeks=1, noise=False)
    four = simulate_prices(model, [2.1, 3.1, 1.0], weeks=4, noise=False)
    assert four["delta"]["profit"]["mean"] == pytest.approx(4 * one["delta"]["profit"]["mean"])


def test_tier_uses_its_own_baseline_and_elasticity(model):
    r = simulate_prices(model, [2.2, 3.0, 1.0], tier="high", noise=False)
    assert r["items"][0]["unitsChangePct"]["p50"] == pytest.approx(1.1 ** -2.5 - 1)
    assert r["baseline"]["units"]["mean"] == pytest.approx(900.0)


def test_noise_widens_the_range_but_not_the_paired_comparison(model):
    quiet = simulate_prices(model, [2.2, 3.0, 1.0], noise=False)
    noisy = simulate_prices(model, [2.2, 3.0, 1.0], noise=True)
    spread = lambda r: r["scenario"]["profit"]["p90"] - r["scenario"]["profit"]["p10"]
    assert spread(noisy) > spread(quiet)
    assert noisy["probProfitUp"] == quiet["probProfitUp"]


def test_promo_matches_hand_calculation():
    m = make_model(cross=0.0)
    r = simulate_promo(m, 0, depth=0.2, weeks=1, deal="advertised", funding=0.0)
    lift = 0.8 ** -4.0 * np.exp(0.1 + 0.6)                       # depth, step, advertised
    after = np.exp(-0.5 * -np.log(0.8))                          # dip the week after
    assert r["liftPct"]["p50"] == pytest.approx(lift - 1)
    promo_margin = 2.0 * 0.8 - 1.2
    expected = 1000 * (lift * promo_margin - 0.8) + 1000 * 0.8 * (after - 1)
    assert r["profit"]["mean"] == pytest.approx(expected)
    assert r["breakEvenLiftPct"] == pytest.approx(0.8 / promo_margin - 1)
    assert r["cannibalisedUnits"]["mean"] == pytest.approx(0)


def test_promo_cannibalises_substitutes_and_funding_helps(model):
    plain = simulate_promo(model, 0, 0.2, deal="none")
    funded = simulate_promo(model, 0, 0.2, deal="none", funding=0.5)
    assert plain["cannibalisedUnits"]["mean"] == pytest.approx(2 * 1000 * (0.8 ** 0.2 - 1))
    assert funded["profit"]["mean"] > plain["profit"]["mean"]
    assert funded["liftPct"] == plain["liftPct"]


def test_break_even_funding_really_breaks_even(model):
    r = simulate_promo(model, 1, 0.25, weeks=2, deal="bonus", funding=0.0)
    need = r["breakEvenFunding"]["p50"]
    assert 0 < need < 1
    at_need = simulate_promo(model, 1, 0.25, weeks=2, deal="bonus", funding=need)
    assert at_need["profit"]["p50"] == pytest.approx(0, abs=1e-6)


def test_small_discount_gets_no_promotion_step():
    m = make_model(cross=0.0)
    r = simulate_promo(m, 0, depth=0.03, deal="none")
    assert r["liftPct"]["p50"] == pytest.approx(0.97 ** -4.0 - 1)


def test_line_promotion_adds_cross_effects_between_promoted_items(model):
    r = simulate_promo(model, [0, 1], depth=0.2, deal="none")
    each = 0.8 ** (-4.0 + 0.2) * np.exp(0.1)                     # own depth + partner's price cut
    assert r["liftPct"]["p50"] == pytest.approx(each - 1)
    assert r["items"] == [0, 1]


def test_optimizer_finds_the_textbook_price():
    # One product, constant elasticity -2, cost 1.2: profit peaks at cost * e / (1 + e) = 2.4,
    # which is the top of the allowed range here.
    m = make_model(reg=(-2.0,), cross=0.0)
    r = optimize_prices(m, max_change=0.2)
    assert r["prices"][0] == pytest.approx(2.4)
    m["items"][0]["cost"] = 1.0                                   # now the peak is 2.0: stay put
    assert optimize_prices(m, max_change=0.2)["prices"][0] == pytest.approx(2.0)


def test_optimizer_respects_every_constraint(model):
    r = optimize_prices(model, max_change=0.1, min_margin=0.25, revenue_floor=0.9, locked=[2])
    for i, p in enumerate(r["prices"]):
        lo, hi = r["bounds"][i]
        assert lo - 1e-9 <= p <= hi + 1e-9
    assert r["prices"][2] == 1.0 and r["atBound"][2] == "fixed"
    assert r["prices"][1] >= 2.4 / (1 - 0.25) - 1e-9              # margin floor beats the +10% cap
    assert r["feasible"] and r["expected"]["revenue"] >= 0.9 * r["expected"]["baselineRevenue"] - 1e-6


def test_conflicting_constraints_are_reported_not_hidden(model):
    # a 25% margin floor forces item 1 up, which cannot coexist with "keep 99.9% of revenue"
    r = optimize_prices(model, max_change=0.1, min_margin=0.25, revenue_floor=0.999, locked=[0, 2])
    assert r["feasible"] is False


def test_optimizer_never_makes_things_worse_and_is_deterministic(model):
    a, b = optimize_prices(model), optimize_prices(model)
    assert a == b
    assert a["delta"]["profit"]["mean"] >= -1e-9


def test_linked_lines_move_together():
    m = make_model()
    m["lines"] = [[0, 1]]
    r = optimize_prices(m, max_change=0.1)
    assert r["changePct"][0] == pytest.approx(r["changePct"][1])
    assert price_lines(m) == [[0, 1], [2]]
    assert price_lines(m, link=False) == [[0], [1], [2]]


def test_inelastic_items_are_flagged_not_trusted():
    m = make_model(reg=(-0.5, -3.0, -1.5))
    r = optimize_prices(m)
    assert r["probInelastic"][0] == 1.0 and r["atBound"][0] == "upper"


@pytest.mark.parametrize("call", [
    lambda m: simulate_prices(m, [1.0, 2.0]),
    lambda m: simulate_prices(m, [1.0, -2.0, 1.0]),
    lambda m: simulate_prices(m, [2.0, 3.0, 1.0], tier="mars"),
    lambda m: simulate_prices(m, [2.0, 3.0, 1.0], weeks=0),
    lambda m: simulate_promo(m, 9, 0.2),
    lambda m: simulate_promo(m, 0, 0.95),
    lambda m: simulate_promo(m, 0, 0.2, deal="bogof"),
    lambda m: simulate_promo(m, 0, 0.2, funding=1.5),
    lambda m: optimize_prices(m, max_change=2),
])
def test_bad_inputs_raise_clear_errors(model, call):
    with pytest.raises(ValueError):
        call(model)
