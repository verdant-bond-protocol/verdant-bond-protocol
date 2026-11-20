# Bond Coupon Schedule Semantics

This document defines the validation rules applied to a bond's coupon
schedule when issuing a bond (`POST /bonds`), so the frontend, API, and
on-chain contract stay consistent.

## Units

Every timestamp in a bond's configuration — `maturityDate` and every entry
in `couponSchedule` — is an **epoch second** (`u64`), matching
`env.ledger().timestamp()` in `contracts/bond-issuer/src/lib.rs`. Nothing in
this flow uses milliseconds.

`frontend/src/app/bonds/issue-bond/issue-bond.component.ts` collects the
maturity date from an `<input type="date">` and converts it with
`Math.floor(new Date(value).getTime() / 1000)`. `Date.getTime()` already
returns UTC epoch milliseconds regardless of the browser's local timezone,
so this conversion is timezone-safe without any extra handling.

## Validation rules

A coupon schedule is valid when:

1. It is **non-empty**.
2. Every entry is **strictly greater than the current time** at submission.
3. Every entry is **strictly less than `maturityDate`**.
4. Entries are in **strictly ascending order** (which also rules out
   duplicate dates).

These rules are enforced in two places, independently:

- **Frontend**: `frontend/src/app/shared/validators/coupon-schedule.validators.ts`
  (`couponScheduleGroupValidator`), applied at the issue-bond form's
  group level so it can compare `couponSchedule` against `maturityDate`.
- **API**: `api/src/bonds/dto/coupon-schedule.validator.ts`
  (`IsValidCouponSchedule`), applied to `CreateBondDto.couponSchedule` in
  `api/src/bonds/dto/create-bond.dto.ts`.

## What the contract itself enforces

`issue_bond` in `contracts/bond-issuer/src/lib.rs` only checks:

- `maturity_date` is strictly in the future (`BondError::Overflow`).
- `coupon_schedule` is non-empty (`BondError::ZeroAmount`).
- Every coupon date is strictly less than `maturity_date`
  (`BondError::ZeroAmount`).

The contract does **not** check ordering, duplicates, or whether a coupon
date has already passed — by design, that enforcement is the frontend and
API's responsibility, so the contract's error codes and existing test suite
(`test_issue_bond_past_maturity`, `test_issue_bond_empty_schedule`) are
unaffected by this validation.
