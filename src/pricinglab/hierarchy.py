"""Stage 2: hierarchical Bayesian pooling of the stage-1 estimates (category > item > store).

Each stage-1 estimate is treated as a noisy measurement of a true coefficient, and the true
coefficients of one category are assumed to come from a common distribution. Items with
noisy or implausible estimates are pulled toward the category; precise ones barely move.

    measured own coefficients_i ~ MVN(true_i, cluster covariance_i)
    true_i[k]                   ~ Normal(category mean_k, category sd_k)
    measured cross elasticity   ~ Normal(true, se),  true ~ Normal(category mean, category sd)
    store deviation (measured)  ~ Normal(true deviation, se),  true ~ Normal(0, tau_item)
"""
from __future__ import annotations

from dataclasses import dataclass

import jax.numpy as jnp
import numpy as np
import numpyro
import numpyro.distributions as dist
from jax import random
from numpyro.infer import MCMC, NUTS

from .demand import OWN, ItemFit

N_OWN = len(OWN)
THIN = 5        # sample 5x what is exported, then keep every 5th draw


@dataclass
class Posterior:
    own: np.ndarray            # draws x items x 6   [b_reg, b_promo, step, deal_b, deal_s, dip]
    cross: np.ndarray          # draws x items x items, zero diagonal; [i, j] = effect of j's price on i
    store_dev: list[np.ndarray]   # per item: stores x 2 posterior-mean deviation from the chain
    store_ids: list[np.ndarray]
    category_mean: np.ndarray  # draws x 6
    max_rhat: float
    divergences: int


def _nearest_psd(cov: np.ndarray, floor: float = 1e-6) -> np.ndarray:
    """Clip eigenvalues so a cluster-robust covariance is always usable as a likelihood."""
    sym = (cov + cov.T) / 2
    vals, vecs = np.linalg.eigh(sym)
    return (vecs * np.clip(vals, floor, None)) @ vecs.T


def _model(own_hat, own_cov, cross_hat, cross_se, dev_hat, dev_se, dev_item):
    k = own_hat.shape[0]
    mean = numpyro.sample("mean", dist.Normal(jnp.zeros(N_OWN), 5.0).to_event(1))
    sd = numpyro.sample("sd", dist.HalfNormal(jnp.full(N_OWN, 2.0)).to_event(1))
    z = numpyro.sample("z", dist.Normal(jnp.zeros((k, N_OWN)), 1.0).to_event(2))
    own = numpyro.deterministic("own", mean + sd * z)
    numpyro.sample("own_obs", dist.MultivariateNormal(own, covariance_matrix=own_cov), obs=own_hat)

    c_mean = numpyro.sample("c_mean", dist.Normal(0.0, 1.0))
    c_sd = numpyro.sample("c_sd", dist.HalfNormal(1.0))
    zc = numpyro.sample("zc", dist.Normal(jnp.zeros(cross_hat.shape), 1.0).to_event(2))
    cross = numpyro.deterministic("cross", c_mean + c_sd * zc)
    numpyro.sample("cross_obs", dist.Normal(cross, cross_se).to_event(2), obs=cross_hat)

    tau = numpyro.sample("tau", dist.HalfNormal(jnp.full((k, 2), 1.5)).to_event(2))
    zd = numpyro.sample("zd", dist.Normal(jnp.zeros(dev_hat.shape), 1.0).to_event(2))
    dev = numpyro.deterministic("dev", tau[dev_item] * zd)
    numpyro.sample("dev_obs", dist.Normal(dev, dev_se).to_event(2), obs=dev_hat)


def fit_hierarchy(fits: list[ItemFit], draws: int = 400, warmup: int = 1000, chains: int = 4,
                  seed: int = 0) -> Posterior:
    k = len(fits)
    own_hat = np.stack([f.beta[:N_OWN] for f in fits])
    own_cov = np.stack([_nearest_psd(f.cov[:N_OWN, :N_OWN]) for f in fits])
    cross_hat = np.stack([f.beta[N_OWN:] for f in fits])
    cross_se = np.stack([np.sqrt(np.clip(np.diag(f.cov)[N_OWN:], 1e-6, None)) for f in fits])
    dev_hat = np.concatenate([f.store_beta - f.beta[:2] for f in fits])
    dev_se = np.concatenate([f.store_se for f in fits])
    dev_item = np.concatenate([np.full(len(f.stores), f.item) for f in fits])

    per_chain = int(np.ceil(draws / chains)) * THIN
    mcmc = MCMC(NUTS(_model, target_accept_prob=0.9), num_warmup=warmup, num_samples=per_chain,
                num_chains=chains, chain_method="sequential", progress_bar=False)
    mcmc.run(random.PRNGKey(seed), jnp.asarray(own_hat), jnp.asarray(own_cov), jnp.asarray(cross_hat),
             jnp.asarray(cross_se), jnp.asarray(dev_hat), jnp.asarray(dev_se), jnp.asarray(dev_item))
    s = {name: np.asarray(v) for name, v in mcmc.get_samples().items()}
    grouped = mcmc.get_samples(group_by_chain=True)
    rhat = max(float(np.nanmax(numpyro.diagnostics.gelman_rubin(np.asarray(grouped[n]))))
               for n in ("mean", "sd", "own", "c_mean", "c_sd", "tau"))
    div = int(np.asarray(mcmc.get_extra_fields().get("diverging", np.zeros(1))).sum())

    s = {name: v[::THIN] for name, v in s.items()}
    n = min(draws, len(s["own"]))
    cross_full = np.zeros((n, k, k))
    for i in range(k):
        cross_full[:, i, [j for j in range(k) if j != i]] = s["cross"][:n, i, :]
    dev_mean = s["dev"].mean(axis=0)
    return Posterior(
        own=s["own"][:n], cross=cross_full,
        store_dev=[dev_mean[dev_item == f.item] for f in fits],
        store_ids=[f.stores for f in fits],
        category_mean=s["mean"][:n], max_rhat=rhat, divergences=div,
    )
