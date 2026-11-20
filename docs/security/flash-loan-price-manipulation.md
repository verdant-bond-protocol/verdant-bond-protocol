# Flash-Loan / Single-Transaction Price Manipulation

Scope: the `dex-router` secondary market for bond tranche tokens, and any
current or future contract that might consume a bond's market price for a
financial decision. Addresses issue #216.

## 1. Threat

A flash-loan-style attack distorts an on-chain price **within a single
transaction** — pushing it far from fair value momentarily — so that another
contract that reads that instantaneous price makes a wrong, profitable-to-the-
attacker decision (e.g. over-valuing collateral, mispricing a redemption),
after which the price is restored in the same transaction. It requires almost no
capital at risk because the distortion and the exploit settle atomically.

## 2. Where market price is (and isn't) read for financial decisions

Every function in `dex-router` that touches price was enumerated:

| Function | Uses price for | Manipulable sink? |
|---|---|---|
| `list_bond_tokens` | stores the seller's own `price_per_token` on their order | No — it is the maker's chosen limit price, not a market read |
| `execute_purchase` | charges `amount * order.price_per_token`; enforces `max_price >= order.price_per_token` | No — the taker pays the specific maker's fixed limit price, capped by the taker's own `max_price` slippage guard |
| `get_order` / `get_bond_orders` / … | display / enumeration | No — read-only reporting |

**Key finding:** the dex-router is an **order book**, not an AMM. There is no
pool spot price, and **no function derives a "market price" from book state and
feeds it into a value-changing calculation.** Each trade settles at a specific
resting order's limit price, and the taker is protected by `max_price`. So there
is currently **no in-transaction price sink** for a flash-loan attack to exploit:
distorting the book by placing/among orders does not change what any other
calculation returns, because nothing reads an aggregate price.

## 3. Mitigation: TWAP is the only sanctioned market-price input

Because a *future* consumer (collateral valuation, redemption pricing, an
analytics surface) is the realistic way this class of bug enters the protocol,
this PR makes the safe primitive exist and mandates its use:

- `dex-router` now records a `(timestamp, price)` observation on **every fill**
  (bounded ring buffer, `MAX_PRICE_OBS = 32` per bond).
- `get_twap(bond_id, quote_asset, window_seconds)` returns the **time-weighted** average of
  executed prices over the trailing window. Each observation's price is weighted
  by *how long it persisted*, not by its magnitude, so a price that existed for
  one ledger contributes essentially nothing.

**Rule:** any function with financial consequences that needs a bond's market
price MUST call `get_twap` with the relevant quote asset and an appropriately long window — never the latest
trade / spot price, and never raw order-book state.

## 4. Economic-attack model (capital vs. profit)

Assume honest trading has established a TWAP `P̄` over a window `W` (seconds),
and an attacker wants a value-reading function to see a price `P_a = k·P̄`
(k ≫ 1) for the duration `t` their distortion persists.

- **Cost to distort.** To move executed prices the attacker must actually trade
  at `P_a`. On this order book that means either buying resting bonds at inflated
  prices (paying the spread to honest makers) or self-trading their own listing
  (round-tripping tokens through the 100%-escrowed listing path, still paying any
  transfer/settlement and forgoing nothing they can reclaim atomically, since a
  fill moves real bond tokens and quote balances). Either way the manipulated
  observation only reflects the size actually traded.
- **Effect on TWAP.** The distortion moves the TWAP by at most
  `Δ ≈ (P_a − P̄)·t / W`. For a single-transaction attack `t` is at most a few
  seconds while `W` is chosen in the hours-to-days range, so `t/W → 0` and
  `Δ` is negligible regardless of `k`. To move the TWAP by a fraction `f` the
  attacker must *hold* the distorted price for `t ≈ f·W` — i.e. keep paying the
  spread against arbitrageurs for a large fraction of the whole window, which is
  no longer a flash attack and is bounded by real, at-risk capital and realistic
  tranche liquidity.
- **Profit.** Because no function reads spot price (§2), the in-transaction
  distortion yields **zero** exploitable mispricing today; once consumers use
  `get_twap`, their reading barely moves (previous bullet), so there is no
  profitable single-transaction manipulation.

## 5. Simulated attack (tested)

`contracts/dex-router/src/lib.rs::test_twap_resists_single_transaction_spike`
seeds honest trades at price `100` across the window, then executes a single
manipulated fill at `10_000` (a 100× spot distortion) one second before reading
the price. The **spot / last trade is `10_000`**, but `get_twap` stays **below
`200`** — the 100× spike is absorbed to under 2× because it persisted for 1s out
of ~2000s. A financial consumer reading `get_twap` is therefore unharmed; the
attack is unprofitable/blocked.

Related tests: `test_twap_is_time_weighted_average` (correctness),
`test_twap_without_trades_errors` (`NoPriceData`), `test_twap_zero_window_rejected`.

## 6. Acceptance criteria → status

- [x] All financially-consequential functions using market price enumerated and
  reviewed (§2) — none consume an aggregate/spot market price today.
- [x] Time-weighted-average pricing available and mandated wherever price feeds a
  financial decision (`get_twap`, §3).
- [x] Documented economic-attack model of attacker capital vs. profit under
  realistic liquidity (§4).
- [x] A simulated flash-loan-style scenario is tested and shown to be absorbed /
  unprofitable (§5).
