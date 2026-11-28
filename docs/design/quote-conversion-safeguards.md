# Design Note: Cross-Currency Quote Expiry & Conversion Safeguards (#620)

## Scope of This Vertical Slice

This slice delivers end-to-end cross-currency quote issuance, validation, and atomic single-use consumption in the `valuation` module:

- **Includes**:
  - `ConversionQuote` data model with integer ratio rates (`rateNumerator / rateDenominator` + `scale`), `issuedAt`, `expiresAt`, `status` (`open | used | expired`), `account`, `purpose`, `amount`, `convertedAmount`, and `dust`.
  - `CurrencyRateSource` interface and a deterministic `StaticTestRateSource` implementation.
  - `QuoteConversionService` with BigInt-only arithmetic, floor rounding, dust tracking, staleness fail-closed guard, slippage/deviation check against reference rate, atomic single-use consumption under concurrency, idempotency-key deduplication, and mid-conversion rollback.
  - RBAC permissions (`REQUEST_CONVERSION_QUOTE`, `CONSUME_CONVERSION_QUOTE`) and REST endpoints under `/valuations/quotes`.
  - Structured RFC 7807 error codes (`QUOTE_EXPIRED`, `QUOTE_ALREADY_USED`, `QUOTE_SLIPPAGE_EXCEEDED`, `STALE_RATE_SOURCE`, `QUOTE_BINDING_MISMATCH`).
- **Deliberately Left Out**:
  - Live external FX / Stellar DEX orderbook rate feed integration. **No live rate source is wired**; `StaticTestRateSource` serves deterministic test pairs until a live adapter implementing `CurrencyRateSource` is configured.
  - Multi-hop path payment routing or Soroban on-chain swap execution (handled by `DEXRouter` on-chain).
  - Persistent PostgreSQL quote table (currently in-memory store with Redis-compatible semantics; schema migration is deferred until DB persistence lands).

## Data Model

`ConversionQuote`:
- `id: string` (UUID)
- `baseCurrency: string`, `quoteCurrency: string`
- `rateNumerator: string`, `rateDenominator: string`, `scale: number` (default `7`, i.e. $10^7$ stroop precision)
- `source: string`, `observedAt: string`
- `issuedAt: string`, `expiresAt: string` (default TTL: `QUOTE_TTL_MS = 30_000`)
- `amount: string` (integer minor units), `convertedAmount: string` (integer minor units), `dust: string` (remainder in `rateDenominator` units)
- `account: string` (Stellar public key / actor), `purpose: ConversionPurpose`
- `status: 'open' | 'used' | 'expired'`
- `consumedAt?: string`, `consumedBy?: string`

## Invariants & Safeguards

1. **No Floating-Point Money**: All amounts, rates, slippage checks, and conversions use `BigInt` integer arithmetic. Zero, negative, non-integer, and values exceeding `MAX_AMOUNT_MINOR_UNITS` ($10^{18}$) or `MAX_RATE_VALUE` ($10^{15}$) are rejected.
2. **Rounding Rule (Floor / Toward Protocol)**:
   $$\text{convertedAmount} = \left\lfloor \frac{\text{amount} \times \text{rateNumerator}}{\text{rateDenominator}} \right\rfloor, \quad \text{dust} = (\text{amount} \times \text{rateNumerator}) \bmod \text{rateDenominator}$$
   Rounding down ensures conversion **cannot create money** and any `A -> B -> A` round trip yields $\le \text{original}$. Remainder `dust` is explicitly recorded on the quote.
3. **Fail-Closed Staleness**: If `now - observedAt > maxRateAgeMs` (default `60_000` ms), quote issuance fails closed with `STALE_RATE_SOURCE`.
4. **Slippage / Reference-Rate Guard**: Deviation $|r - r_{\text{ref}}| / r_{\text{ref}}$ in basis points must not exceed `maxSlippageBps` (default `100` bps = 1%). Breaches throw `QUOTE_SLIPPAGE_EXCEEDED`.
5. **Account & Purpose Binding**: `consumeQuote` requires the caller `account` and `purpose` to match the quote's bound values (`QUOTE_BINDING_MISMATCH`).
6. **Atomic Single-Use**: An in-flight lock per `quoteId` ensures concurrent `consumeQuote` calls serialize; only the first succeeds and transitions `open -> used`, while all others fail with `QUOTE_ALREADY_USED`.
7. **Rollback on Halfway Failure**: If the downstream settlement callback (`onBeforeCommit`) throws during consumption, the quote is restored to `open` (or `expired` if TTL elapsed) and `consumedAt`/`consumedBy` are cleared before rethrowing.
8. **Idempotency**: Both `issueQuote` and `consumeQuote` accept an `idempotencyKey` (and HTTP `Idempotency-Key` header via `@Idempotent()`), returning the original result on identical retries and rejecting payload mismatches.
