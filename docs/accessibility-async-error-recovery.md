# Accessibility coverage for async error recovery

**Vertical slice:** a reusable, standalone Angular component that owns the
async operation lifecycle and announces every outcome accessibly, plus a
WCAG 2.1 A/AA regression suite.

## Files

| File | Purpose |
|------|---------|
| `frontend/src/app/shared/components/async-error-recovery/async-error-recovery.component.ts` | State machine (`idle → loading → error → recovering → recovered`), live regions, retry and sign-in actions. |
| `frontend/src/app/shared/components/async-error-recovery/async-error-recovery.a11y.spec.ts` | 7 Jasmine tests covering normal, failure, retry, authorization and edge cases, including axe-core sweeps. |
| `frontend/src/app/shared/testing/axe.ts` | Existing WCAG 2.1 A/AA axe helper reused by the suite. |

## Accessibility contract

- A `role="status"` / `aria-live="polite"` / `aria-atomic="true"` region is
  present from the **first render** and never removed, so screen readers
  announce later changes (WCAG 4.1.3). Visually hidden via clip, not
  `display: none`.
- Failures are additionally announced assertively with `role="alert"` and
  `aria-live="assertive"`.
- The error banner and retry controls stay in the DOM during a retry, so the
  error description referenced by `aria-describedby` remains valid; the retry
  button is disabled while a retry is in flight and the container sets
  `aria-busy="true"`.
- A concurrent second retry is ignored (guarded in `retryNow()`), so the
  announced attempt count always matches the actual number of sends.
- An authorization failure (401/403) adds a named `Sign in to continue` link
  and relabels the retry (`Try again after signing in`); the live message says
  permission is missing rather than implying a generic network problem.
- Colours meet 4.5:1 contrast on the app background (`#166534` success,
  `#b91c1c` error), verified by the axe sweep.
- Each instance gets a unique `messageId`, so two banners on one page cannot
  cross-reference each other.

## Paths covered by tests

- **Normal:** initial operation succeeds → polite "Request completed." and a
  `role="status"` success banner; axe reports no violations.
- **Failure:** a 503 is announced in an assertive `role="alert"` with the
  original detail, and the retry button is enabled and described by that text.
- **Retry:** the first attempt fails, the retry announces "Retry attempt 1 in
  progress.", disables the button, then announces "Recovered on attempt 1."
  and emits `recovered` exactly once.
- **Authorization:** a 403 yields a sign-in link with an accessible name and a
  permission-specific live message.
- **Edge cases:** a rapid double click triggers only one retry; a blank API
  detail still produces a readable "Request failed"; ids are unique per
  instance.

## Running the tests

The repository currently has unrelated pre-existing TypeScript errors in other
frontend specs/components, so the scoped verification uses a temporary tsconfig
that includes only this slice (no changes to the committed test config):

```sh
cd frontend
cat > tsconfig.spec.slice.json <<'EOF'
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "outDir": "./out-tsc/spec-slice", "types": ["jasmine"] },
  "include": [
    "src/app/shared/components/async-error-recovery/async-error-recovery.a11y.spec.ts",
    "src/**/*.d.ts"
  ]
}
EOF
CHROME_BIN=/usr/bin/google-chrome npx ng test --watch=false --browsers=ChromeHeadless \
  --ts-config tsconfig.spec.slice.json \
  --include='**/async-error-recovery.a11y.spec.ts'
```

Once the unrelated pre-existing errors are resolved, the suite runs under the
normal `npm test` command like the other a11y specs.

## Recovery / rollback behaviour

- A failed operation is never silently retried: the component moves to `error`
  and waits for an explicit user action (retry or sign-in).
- A retry that fails again returns to `error` with the new detail; the attempt
  counter and live region make the repeated failure visible.
- Recovery is a pure state transition in the client — there is no server-side
  side effect to roll back. If the operation itself is non-idempotent, callers
  must pass an `Idempotency-Key` (see `docs/offline-operation-queue.md`).

## Contract compatibility / migration

The component is additive and standalone; no existing component, route or API
contract is modified. It can be adopted one screen at a time with no migration:
`<app-async-error-recovery [operation]="reload" (recovered)="..." />`. Inputs
and outputs are optional except `operation`, so existing templates are
unaffected.
