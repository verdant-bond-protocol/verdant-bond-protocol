# Accessibility Regression Coverage

Accessibility is enforced in CI, not just reviewed by hand. This document
describes what is covered today, how to extend it, and the operational edge
cases that make accessibility regressions easy to miss (#373).

## Approach

Two complementary layers:

1. **Attribute/behaviour contracts** — fast, deterministic assertions that the
   keyboard/screen-reader/announcement contracts of a component still hold.
   These do not depend on rendering fidelity, so a purely visual change cannot
   make them flaky.
2. **Automated axe sweeps** — `axe-core` run over rendered markup for the
   WCAG 2.1 A/AA rule tags, for the densest pages.

Shared helper: [`frontend/src/app/shared/testing/axe.ts`](../frontend/src/app/shared/testing/axe.ts)
(`axeViolations(element)`), which flattens violations into readable lines.

## Current coverage

| Workflow | Spec | Layer |
| --- | --- | --- |
| Dense issuance form | `frontend/src/app/bonds/issue-bond/issue-bond.a11y.spec.ts` | contracts |
| Data tables + charts | `frontend/src/app/dashboard/dashboard.a11y.spec.ts` | axe sweep |
| Error recovery / announcements | `frontend/src/app/shared/errors/api-error.spec.ts` | contracts |

The issuance-form contracts assert that:

- every `input`/`select` has an associated `<label for>` (programmatic label);
- no control is `aria-hidden` or pulled out of the tab order with a negative
  `tabindex`;
- the submit button has an accessible name and is only enabled once the form is
  valid (keyboard operability);
- field-level validation failures render with `role="alert"`;
- submission errors use an assertive live region (`role="alert"`,
  `aria-live="assertive"`) and success uses a polite one (`role="status"`,
  `aria-live="polite"`).

The error-recovery contracts assert that API failures always normalize to a
non-empty, human-readable `detail` — the string that gets announced to users —
rather than `undefined`.

## Adding coverage

- Prefer a contract test when the risk is "the attribute/role disappears".
- Prefer an axe sweep when the risk is a broad, unknown regression on a page.
  Use `axeViolations` and assert `toEqual([])`.
- For every interactive flow, cover the **error** path, not just the happy
  path: announcements are the first thing to regress.
- Keep specs deterministic; avoid asserting exact colors or layout.

## Operational edge cases

- **Same-page live regions**: `role="alert"`/`aria-live` must exist in the DOM
  *before* the message is inserted for screen readers to announce it. The
  specs assert the region's presence, which is what makes the later insertion
  work.
- **Disabled submit**: a disabled `<button>` is skipped by the tab order; the
  contract test therefore asserts it becomes enabled (focusable) exactly when
  the form is valid.
- **Reduced motion**: CSS-only and not asserted here; if a component adds
  motion it must honour `prefers-reduced-motion` and should add a contract test
  that the animated class is gated on the media query.

## Failure modes & rollback

- A failing a11y contract fails the frontend CI job; fix the markup rather than
  deleting the assertion.
- If an axe sweep becomes flaky due to environment (font/contrast rendering),
  quarantine the specific rule in the helper with a linked issue — do not
  disable the whole sweep.
- All specs are additive and read-only; reverting a spec is safe and does not
  affect runtime behaviour.
