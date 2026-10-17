# Large-Integer Financial Values: API Contract

Token amounts in the protocol are Soroban `i128` minor units. A JavaScript
`number` (IEEE-754 double) is only exact up to `Number.MAX_SAFE_INTEGER`
(2^53 − 1 = 9,007,199,254,740,991). That is about 900 million whole units of
a 7-decimal asset such as USDC or XLM. Any amount above that must cross the
API as a string, or it gets rounded silently.

This document defines the wire contract for those values. The first endpoint
covered end to end is `POST /fees/preview`.

## Contract

| Rule | Detail |
| --- | --- |
| Wire type | Every `*MinorUnits` field is a JSON **string** of base-10 ASCII digits, in requests and in responses. |
| Range | `0` to `170141183460469231731687303715884105727` (i128 max, 2^127 − 1), inclusive. |
| Length | At most 64 characters, so zero-padded input is accepted but parsing cost stays bounded. |
| Canonical form | Responses never have leading zeros. `"000123"` is echoed back as `"123"`. |
| JSON numbers | **Rejected with 400**, even small safe ones like `1000`. |
| Error | `400` with `message` containing `amountMinorUnits must be a non-negative integer string` (same text as before this change). |
| Determinism | The same request always gets a byte-identical response. |
| Auth order | `JwtAuthGuard` runs before validation, so an unauthenticated caller gets `401` whatever the body is. |

Implementation:

- `IsMinorUnitsString` (`api/src/common/decorators/is-minor-units-string.decorator.ts`)
- `parseMinorUnits` and `I128_MAX` (`api/src/common/utils/bigint.util.ts`)
- `createGlobalValidationPipe` (`api/src/common/pipes/global-validation.pipe.ts`), the production pipe, which the tests also use.

## Why JSON numbers are rejected rather than coerced

The global `ValidationPipe` runs with `enableImplicitConversion: true`. Before
this change, a client sending

```json
{ "amountMinorUnits": 12345678901234567891, "asset": "USDC" }
```

got a **200** that priced `12345678901234567000`. `JSON.parse` had already
rounded the number before any API code ran, and implicit conversion turned
the rounded double into a valid-looking digit string. Once the value has been
parsed there is no way to tell whether it was rounded, so the only safe
contract is to refuse JSON numbers entirely. `IsMinorUnitsString` restores the
raw request value before validation, which defeats the implicit conversion.

## Verification

```bash
cd api
npx jest fees.large-integer.contract bigint.util route-authorization
```

`src/fees/fees.large-integer.contract.spec.ts` boots `FeesController` with
the real `FeesService` and the production pipe, and covers four paths:

- **Normal**: an exact round-trip at 0, 1, `MAX_SAFE_INTEGER` ± 1/2, u64
  max ± 1, a 20-digit value, and i128 max. Each result is checked against an
  independent BigInt oracle of the published schedule. The test also asserts
  that every `*MinorUnits` field in the raw response text is a quoted string,
  and that `total + net == input` holds for all three schedules at i128 max.
- **Failure**: 24 rejected inputs return 400 and never reach the service.
  These include JSON numbers, signs, decimals, exponents, hex, `n` suffixes,
  separators, whitespace, non-ASCII digits, i128 max + 1, 2^128, over-long
  strings, a 10,000-digit string, and wrong JSON types. Rejected values are
  not echoed back in the error.
- **Retry**: sequential and concurrent retries return byte-identical
  responses. A client that was rejected for sending a number recovers by
  resending the same digits as a string. A rejected request leaves no state
  behind.
- **Authorization**: `anon` gets 401 before parsing, including for a
  malformed amount, so validation cannot be used as an oracle by
  unauthenticated callers. All authenticated roles get the same exact result.
  The route is also registered in `route-authorization.matrix.ts`.

Removing the fix and keeping the previous DTO makes 9 of these tests fail.

## Operational edge cases

- **Client serializers.** Many JSON libraries emit 64-bit integers as numbers
  by default, for example Go's `int64`, Java's `long`, or JS code that calls
  `Number(x)`. These clients now get 400 instead of a silently wrong amount.
  Integrators should configure string serialization, such as Go's
  `json:",string"` or Jackson's `WRITE_NUMBERS_AS_STRINGS`.
- **Client parsers.** Response amounts are strings and must be parsed with
  `BigInt` or a decimal library, never `Number()` or `parseFloat`.
- **Amounts above i128 max** used to be quoted even though they can never
  settle on-chain. They now return 400. No real asset supply comes close to
  this limit, so a rejection here points to a client bug such as a unit or
  decimals mix-up, not a legitimate trade.
- **Zero** is still a valid input and returns an all-zero breakdown. The
  custody minimum-fee floor is capped by the total-fee ≤ amount clamp.
- **Read-only endpoint.** `/fees/preview` charges and records nothing, so a
  retry needs no idempotency key and has no partial state to clean up.

## Recovery and rollback

- **Client recovery:** after a `400` on an amount field, resend the same
  digits as a JSON string. No server-side cleanup is needed.
- **Rollback:** revert the commit that introduced `IsMinorUnitsString`. That
  restores the previous `@IsString() @Matches(/^\d+$/)` DTO. The response
  shape did not change, so a rollback needs no data migration. Rolling back
  re-opens the silent-rounding defect described above, so only do it as a
  short-term measure while affected clients are fixed.
- **Monitoring:** watch for a rise in `400`s on `POST /fees/preview` after
  deploy. A rise means some clients are sending numbers and must switch to
  strings. They were already receiving wrong quotes for amounts above 2^53.

## Compatibility and migration plan

- **Unchanged:** the request and response shapes, the status codes for valid
  and invalid strings, the error message text, the fee math, and all three
  fee schedules.
- **Newly rejected:** (a) JSON numbers for `amountMinorUnits`, (b) strings
  above i128 max, and (c) strings longer than 64 characters. Case (a) was
  never part of the documented contract, which already said "integer string".
  Small numbers happened to work only because of implicit conversion.
- **Migration:** announce the change to integrators, then deploy. Clients
  that already send strings need no change.
- **Follow-up scope:** several DTOs still declare amounts as `number`, for
  example `bonds/dto/subscribe.dto.ts`, `bonds/dto/transfer-bond.dto.ts`,
  `bonds/dto/create-bond.dto.ts` (`faceValue`), and the `marketplace/dto/*`
  amount and price fields. They have the same 2^53 ceiling. Each one should
  move to `@IsMinorUnitsString` behind a versioned contract change (see
  `SCHEMA_EVOLUTION_GUARDRAILS.md`) that accepts both forms during a
  deprecation window, with a copy of this spec for each endpoint. That
  change is outside this vertical slice.
