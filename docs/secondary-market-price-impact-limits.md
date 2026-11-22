# Secondary-Market Price Impact Limits for Illiquid Tranches (#471)

## Overview & Background

Nature-based Solution (NbS) bonds listed on the Stellar secondary marketplace represent tokenized claims on diverse ecological projects (reforestation, blue carbon, mangrove restoration). Because discrete tranches possess distinct maturities, credit yields, and vintage profiles, secondary-market liquidity is often fragmented:
- **Liquid Tranches**: High transaction volume and deep order books (>= 25,000 units).
- **Moderate Tranches**: Active periodic liquidity (5,000 to 25,000 units).
- **Illiquid Tranches**: Thin order books (< 5,000 units total resting depth) where a taker purchasing a significant size can exhaust the book, induce extreme price slippage, or move the clearing price far above fair value.

Issue #471 introduces automated **liquidity tier classification**, **pre-trade price impact evaluation**, and **hard price-impact caps** to protect both market takers from predatory slippage and the tranche from book-clearing manipulation.

---

## 1. Liquidity Tier Classification

Tranches are classified dynamically based on available sell depth (`availableDepth`):

| Liquidity Tier | Depth Threshold (`availableDepth`) | Maximum Allowable Price Impact | Max Depth Consumption per Trade |
| :--- | :--- | :--- | :--- |
| **`LIQUID`** | `>= 25,000` tokens | **300 bps** (3.00%) | 100% |
| **`MODERATE`** | `5,000` to `24,999` tokens | **600 bps** (6.00%) | 100% |
| **`ILLIQUID`** | `< 5,000` tokens | **1,000 bps** (10.00%) | **5,000 bps** (50.00%) |

---

## 2. Mathematical Definition of Price Impact

For a purchase order of size $Q$ filled across $N$ sorted ask levels with quantities $q_i$ and prices $p_i$ ($\sum_{i=1}^N q_i = Q$):

1. **Total Execution Cost**:
   $$\text{TotalCost} = \sum_{i=1}^N q_i \times p_i$$

2. **Average Execution Price**:
   $$\bar{P}_{\text{exec}} = \frac{\text{TotalCost}}{Q}$$

3. **Ideal Cost** (evaluated against best ask $p_{\text{best}}$):
   $$\text{IdealCost} = Q \times p_{\text{best}}$$

4. **Price Impact (in basis points)**:
   $$\text{PriceImpact}_{\text{bps}} = \left( \frac{\text{TotalCost} - \text{IdealCost}}{\text{IdealCost}} \right) \times 10,000$$

5. **Depth Consumption (in basis points)**:
   $$\text{DepthConsumption}_{\text{bps}} = \left( \frac{Q}{\text{TotalAvailableDepth}} \right) \times 10,000$$

---

## 3. Enforcement Workflow & Failure Paths

```mermaid
sequenceDiagram
    autonumber
    actor Investor as Buyer
    participant API as MarketplaceController / DexService
    participant Impact as PriceImpactService
    participant Contract as DEXRouter (Soroban)

    Investor->>API: POST /marketplace/buy { orderId, amount, maxPrice }
    API->>Impact: evaluatePriceImpact(bondId, amount, quoteAsset)
    Impact->>Impact: Classify LiquidityTier (LIQUID | MODERATE | ILLIQUID)
    Impact->>Impact: Calculate priceImpactBps & depthConsumptionBps
    
    alt Price Impact or Depth Cap Exceeded
        Impact-->>API: isAllowed = false, suggestedMaxAmount
        API-->>Investor: 400 Bad Request (PRICE_IMPACT_EXCEEDED)
    else Price Impact within Safe Bounds
        Impact-->>API: isAllowed = true
        API->>Contract: execute_purchase(buyer, orderId, maxPrice, amount)
        Contract-->>API: Confirmed on-chain tx
        API-->>Investor: 200 OK (OrderResponse)
    end
```

---

## 4. API Endpoints

### 1. Pre-Trade Impact Evaluation
- **`GET /marketplace/prices/:bondId/impact`**
- **Query Params**: `amount` (positive integer string), `quoteAsset` (default `USDC`)
- **Response**:
  ```json
  {
    "bondId": 101,
    "requestedAmount": "2000",
    "quoteAsset": "USDC",
    "liquidityTier": "ILLIQUID",
    "availableDepth": "3000",
    "bestPrice": "100",
    "marginalPrice": "110",
    "averageExecutionPrice": "105",
    "totalCost": "210000",
    "priceImpactBps": 500,
    "maxAllowedImpactBps": 1000,
    "isAllowed": false,
    "depthConsumptionRatioBps": 6666,
    "maxDepthConsumptionBps": 5000,
    "reason": "Order consumes 66.7% of illiquid tranche depth, exceeding maximum allowable depth consumption of 50.0%",
    "suggestedMaxAmount": "1500"
  }
  ```

### 2. Tranche Configuration
- **`GET /marketplace/config/:bondId/impact-limits`**: Read current parameter set.
- **`PUT /marketplace/config/:bondId/impact-limits`**: Operator override for special bespoke issuances (requires `x-wallet-address` admin authorization).

---

## 5. Recovery, Retry, and Operational Edge Cases

1. **Retry with `suggestedMaxAmount`**:
   When an order is rejected with `PRICE_IMPACT_EXCEEDED`, the response payload includes a deterministic `suggestedMaxAmount`. Submitting a revised order matching or below this amount is guaranteed to satisfy the price-impact and depth-consumption caps.
2. **Order Book Depletion**:
   If asks are concurrently filled by another trader between quote preview and order execution, `DexService` re-fetches the live order from the ledger before calling `PriceImpactService`, preventing stale executions.
3. **Rollback & Invariants**:
   No on-chain state or escrow balance is modified if price impact validation fails; rejection happens off-chain before any Soroban contract invocation or nonce consumption.

---

## 6. Thin-market slippage limits (#638)

### Targeted-fill premium

`POST /marketplace/buy` fills **one specific order at that order's price**.
The #471 check measured impact as if the buyer swept the book from the best
ask. In a thin book, a buyer could pick a resting outlier ask (say 2× the
best price) and the check would report `0 bps`.

The buy path now passes the target order to the evaluator, which computes:

$$\text{fillPremium}_{bps} = \left\lceil \frac{(p_{\text{order}} - p_{\text{best}}) \times 10{,}000}{p_{\text{best}}} \right\rceil$$

$$\text{priceImpact}_{bps} = \max(\text{sweepImpact}_{bps},\ \text{fillPremium}_{bps})$$

The premium is rounded **up**, so a cap is never exceeded through truncation.
When the premium exceeds the limit, `suggestedMaxAmount` is `0`, because no
size of *that* order is acceptable. `bestOrderId` names the order to retry
against.

### Caller slippage tolerance

`BuyBondDto.maxPriceImpactBps` (optional, integer 0–10000) is the buyer's own
tolerance. The effective cap is `min(tier cap, caller tolerance)`, so a buyer
can tighten the limit but never loosen it. `limitSource` (`tier` or `caller`)
reports which cap applied. `0` means "only fill at the best ask".

The preview endpoint accepts the same inputs, so a preview matches what the
buy will enforce:

```
GET /marketplace/prices/:bondId/impact?amount=10&orderId=3&maxPriceImpactBps=250
```

### Rejection format

A rejection is now an RFC 7807 problem with code `PRICE_IMPACT_EXCEEDED`. The
previous plain `400` lost its details in the global filter. The retry inputs
are in `context`:

```json
{ "status": 400, "code": "PRICE_IMPACT_EXCEEDED", "retryable": false,
  "context": { "suggestedMaxAmount": "0", "bestOrderId": 1, "targetOrderId": 3,
               "fillPremiumBps": 5000, "maxAllowedImpactBps": 1000, "limitSource": "tier" } }
```

### Authorization and config safety

- **Authorization:** `PUT /marketplace/config/:bondId/impact-limits` used to
  accept *any* `x-wallet-address` header, so anyone could loosen a thin
  market's limits. It now requires the protocol admin wallet
  (`STELLAR_PUBLIC_KEY`) and fails closed with `403` when that key is not
  configured.
- **Validation:** configs are checked before they are stored. Thresholds must
  be positive integer strings, the illiquid threshold must not exceed the
  moderate threshold, tier caps must be between 0 and 10000 bps, and the depth
  cap must be between 1 and 10000. An invalid patch is rejected and the
  previous config is kept.
- **Corrupted cache:** a corrupted cached override (which would previously
  crash every evaluation in `BigInt`) is ignored with a warning, and the
  conservative defaults apply.
- **Bad asks:** a non-positive ask in the book blocks trading instead of
  dividing by zero.

### Edge cases and invariants

- Every check runs **before** any contract call, so a rejection consumes no
  nonce and moves no escrow.
- Retrying with `suggestedMaxAmount` against the same book is guaranteed to
  pass under the same tolerance.
- Ask-price ties are broken by order id, so `bestOrderId` is deterministic.

### Tests

```bash
cd api
npx jest src/marketplace/price-impact.service.spec.ts src/marketplace/thin-market-buy-guard.spec.ts \
  src/marketplace/marketplace.controller.guard.spec.ts
```
