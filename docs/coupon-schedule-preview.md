# Deterministic Coupon Schedule Preview (#439)

Service: `api/src/bonds/coupon-schedule-preview.service.ts`

Before signing a purchase, the investor gets the exact coupon schedule they are buying, plus a `previewHash`. At signing time, `verifyForSigning` recomputes the preview and only proceeds if the hash still matches.

## Determinism rules

- Integer maths only (`bigint`):
  - per-period coupon = `principal * rateBps / (10000 * paymentsPerYear)`, rounded down
  - a short final period is prorated by days, rounded down
- Dates are UTC `YYYY-MM-DD`. Payment dates are always counted from the issue date: `issue + k * (12 / paymentsPerYear)` months. A day past month-end is clamped to the last day of the month (`01-31` gives `04-30` and then `07-31`, with no drift).
- Principal is repaid on the final (maturity) payment.
- Only payments strictly after `purchaseDate` are included.
- `previewHash` is the SHA-256 of the preview body serialized in a fixed field order (it includes `version`, `bondId` and `investor`).

## Paths

| Path | Result |
|---|---|
| Normal | the schedule plus totals and `previewHash` |
| Invalid input | `400 INVALID_PREVIEW_INPUT`: non-integer or zero principal; rate outside 0–10000 bps; unsupported frequency (only 1, 2, 4, 12); impossible dates; maturity not after issue; purchase outside `[issue, maturity)` |
| Too long | `400 PREVIEW_TOO_LONG` above 600 payments |
| Terms changed after preview | `409 PREVIEW_MISMATCH`; the client must fetch a new preview and have it re-confirmed |
| Retry | calling `verifyForSigning` again with the same input and hash succeeds again |
| Authorization | only the investor in the preview can sign (`403 PREVIEW_SIGNER_MISMATCH`) |

## Compatibility and rollback

This is a new, stateless service: no storage or on-chain changes. It does not replace the existing coupon engine; it shows the investor what that engine's schedule terms imply. Bump `COUPON_PREVIEW_VERSION` whenever the calculation changes, so old hashes stop verifying.
