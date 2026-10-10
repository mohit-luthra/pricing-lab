"""A tiny hand-built category model with known parameters, shared by the engine tests."""
import numpy as np
import pytest


def make_model(n_draws: int = 50, reg=(-2.0, -3.0, -1.5), cross=0.2, spread: float = 0.0, seed: int = 1):
    rng = np.random.default_rng(seed)
    k = len(reg)
    own = np.zeros((n_draws, k, 6))
    own[:, :, 0] = np.array(reg) + spread * rng.standard_normal((n_draws, k))   # regular
    own[:, :, 1] = -4.0                                                          # promo depth
    own[:, :, 2] = 0.1                                                           # on-promotion step
    own[:, :, 3] = 0.2                                                           # bonus buy
    own[:, :, 4] = 0.6                                                           # advertised
    own[:, :, 5] = -0.5                                                          # dip
    cr = np.full((n_draws, k, k), cross)
    cr[:, np.arange(k), np.arange(k)] = 0.0
    items = [{"id": str(i), "name": f"Item {i}", "price": p, "cost": c, "priceMin": p * 0.8,
              "priceMax": p * 1.2, "noiseSd": 0.2,
              "units": {"chain": 1000.0, "low": 100.0, "medium": 600.0, "high": 300.0}}
             for i, (p, c) in enumerate([(2.0, 1.2), (3.0, 2.4), (1.0, 0.5)][:k])]
    zeros = [[0.0, 0.0]] * k
    return {
        "items": items, "tiers": {"chain": 10, "low": 1, "medium": 6, "high": 3},
        "draws": {"n": n_draws, "own": own.tolist(), "cross": cr.tolist(),
                  "noise": rng.standard_normal((n_draws, k)).tolist()},
        "tierDev": {"chain": zeros, "low": zeros, "medium": zeros, "high": [[-0.5, -0.5]] * k},
        "lines": [],
    }


@pytest.fixture()
def model():
    return make_model()
