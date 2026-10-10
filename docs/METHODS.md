# Methods

## 1. Data

- Source: Dominick's Finer Foods store-level scanner data, weeks 1 to 399 (Sep 1989 to May 1997).
- Categories: canned tuna, bottled juices, laundry detergents, soft drinks.
- Cleaning (`ingest.py`): drop rows Dominick's flagged bad, weeks with no sales, invalid prices,
  out-of-scope products, and prices more than 5x from the product's median. 19.3M rows kept;
  every drop is counted in `ingest_audit.json` and the counts reconcile to the raw row total.
- Products modelled: per category, the 10 best-sellers of the last two years that have at
  least 150 weeks of history and are still on shelf in 80+ stores.

## 2. Features

- **Regular price**: highest price within plus or minus 6 weeks for that product and store.
- **Discount depth**: log(price / regular price), zero when not discounted.
- **On promotion**: price at least 5% under regular. Captures hi-lo products where being on
  promotion at all matters more than how deep the cut is.
- **Deal type**: B (bonus-buy shelf tag) and S (advertised price reduction) as separate flags.
  They behave very differently: S roughly doubles sales on top of the price effect.
- **Post-promotion dip**: last week's discount depth. Shoppers stock up, then buy less.
- **Competitor prices**: log price of each of the other nine products in that store-week.
- **Controls**: store fixed effects, year-quarter effects, seven US holiday weeks.

## 3. Stage 1: demand regressions (`demand.py`)

```
ln units = store + quarter + holidays
         + b_reg   * ln(regular price)
         + b_promo * ln(price / regular price)
         + step    * [on promotion]
         + d_B * [bonus buy] + d_S * [advertised]
         + dip     * last week's discount depth
         + sum_j g_j * ln(price of product j)
```

- One regression per product, about 25,000 rows each.
- Standard errors clustered by week. Prices are mostly set chain-wide each week, so the
  effective sample is the number of weeks, not store-weeks. Unclustered errors would be several
  times too small.
- Week fixed effects per product are impossible for the same reason: they would absorb almost
  all the price variation.
- A second fit gives every store its own b_reg and b_promo.
- A regressor that never varies for a product (never advertised, say) is marked "unknown"
  with a huge variance rather than zero, so stage 2 fills it in from the category.

## 4. Stage 2: hierarchical Bayes (`hierarchy.py`)

Each stage-1 estimate is a noisy measurement of a true coefficient:

```
estimate_i        ~ MVN(true_i, cluster covariance_i)      six own coefficients per product
true_i[k]         ~ Normal(category mean_k, category sd_k)
cross estimate    ~ Normal(true, se),  true ~ Normal(category mean, category sd)
store deviation   ~ Normal(true deviation, se),  true ~ Normal(0, tau_product)
```

- Fitted with NUTS in NumPyro: 4 chains, 1,000 warmup, 500 draws each, thinned to 400.
- Worst R-hat across categories 1.017, zero divergences.
- Why two stages instead of one big model: the likelihood of a Gaussian regression is fully
  summarised by its estimate and covariance, so stage 2 loses nothing, runs in 30 seconds
  instead of hours, and can use the week-clustered covariance, which a row-level model cannot.
- Effect: detergent estimates move by 0.39 on average, tuna by 0.07. Tide 200 oz goes from
  +0.56 (impossible) to -0.56 with a wide range.

## 5. Endogeneity check

- Concern: the chain discounts when it expects demand to move, biasing the price coefficient.
- Check: 2SLS on total price with wholesale cost as the instrument.
- Result: first-stage F is at least 10 for only 14 of 40 products (3 tuna, 3 juice,
  2 detergent, 6 soft drinks).
- Where usable, instrumented elasticities are about the same in tuna and detergent and clearly
  more elastic in juice and soft drinks.
- Decision: the simulator uses the plain estimates, and the app says that it probably
  understates price sensitivity in juice and soft drinks. An instrument that works for a third
  of products cannot be used to correct the rest.
- Caveat on the instrument itself: cost is average acquisition cost, which lags replacement
  cost, and trade deals often coincide with manufacturer advertising.

## 6. Validation (`validate.py`)

- Hide the last 26 weeks, refit, predict chain-level weekly units per product.
- Benchmark: each store's average of the last 8 training weeks.
- Median absolute error: tuna 18% (23%), juice 20% (37%), detergent 19% (58%),
  soft drinks 69% (180%).
- Volume-weighted error is far worse (46 to 65%) because a few advertised weeks sell 10 to 25x
  normal volume and the data has no record of ad placement.
- 80% prediction intervals cover 71%, 58%, 85%, 52% of weeks: too narrow in juice and
  soft drinks.
- Soft drinks fails. 24-packs sell about 2,000 units a week at regular price and 80,000 on any
  promotion. A log-linear model cannot represent an on/off product. The app labels the
  category "direction only".

## 7. Simulation engine (`engine.py`, `web/src/engine/engine.ts`)

- Baseline: model-implied weekly units at regular prices with no promotion, at the demand
  level of the last four quarters.
- Price scenario: `q_i = base_i * exp(sum_j E_ij * ln(p_j / p0_j))`.
- Promotion: depth effect, on-promotion step, deal-type effect, dip the week after, and
  cross effects on other products. Supplier funding enters the promoted margin.
- Every output is computed for each of the 400 posterior draws and reported as P10/P50/P90.
- Price lines: products whose chain prices correlate above 0.9 were never discounted
  separately, so the data cannot say what a solo change does. The app moves them together.
- Optimizer: coordinate ascent on a 41-point grid per price line, maximising expected profit
  across draws. Bounds are the observed two-year price range, narrowed by the user's maximum
  change, margin floor and revenue floor. It never extrapolates outside observed prices.
- The TypeScript engine reproduces the Python one to 1e-6 on 28 golden cases.

## 8. Assistant (`web/src/agent`, `web/app/api/ask`)

- The model can call three tools and nothing else. The tools run the same engine as the UI.
- The whole loop runs on the server: the browser sends a category and one question.
- An answer is shown only if at least one tool ran successfully; otherwise a fixed refusal
  replaces the model's text. This is what stops it being used as a general chatbot.
- After each answer, every number in the text is matched against the tool results. Numbers
  that cannot be traced are flagged to the user. Digits inside names ("24-pack") are ignored.
- Limits: 400-character questions, 3 turns of history, 6 questions a minute and 40 a day per
  visitor, 300 a day for the site. Counters live in Upstash Redis when configured, otherwise
  in server memory; if Redis is unreachable the memory counters take over.
- Evals: 24 task questions plus 2 out-of-scope ones, scored on tool choice, arguments and
  numeric faithfulness. The loop, limits and checks are unit-tested with a scripted model.

## 9. Known limits

- 1990s prices, one chain. The method transfers, the numbers do not.
- Category view only: no basket or store-traffic effects.
- Zero-sales weeks are missing, so stock-outs are invisible.
- "Chance profit improves" reflects uncertainty in the estimated coefficients only. It does not
  include the possibility that the model form is wrong, so read 100% as "the model is sure",
  not "it is certain".
- Free-delivery tool is assumption-driven, not estimated: the data has no delivery.
