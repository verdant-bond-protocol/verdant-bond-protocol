# Oracle Report Challenge Lifecycle

Oracle reports can be challenged on-chain. This document describes the lifecycle,
the API surface for reviewing challenges, and how challenge state gates coupon
distribution. Implementation: `api/src/oracle/oracle.service.ts` (`
getReportChallengeState`, `getProjectChallengedReports`, `getCouponEligibility`)
and `api/src/oracle/oracle.controller.ts`. Tests:
`api/src/oracle/oracle.challenge.service.spec.ts` and
`api/src/bonds/bonds.coupon-challenge.spec.ts`.

## States

A report moves through one of these statuses (`ReportStatus`):

| Status | Meaning |
| --- | --- |
| `Pending` | Submitted, not yet verified. |
| `Verified` | Accepted by the verifier; eligible to back coupon distribution. |
| `Challenged` | A counter-party has opened a challenge; data is disputed. |
| `Rejected` | Challenge resolved against the report (or otherwise rejected). |

A challenge record (`ChallengeRecord`) carries: `reportId`, `challengerAddress`,
`counterEvidenceHash`, `submittedAt`, `resolved` (bool), and `resolution`
(a `ReportStatus` once resolved — typically `Verified` or `Rejected`).

## Lifecycle

```
        submit_report                 challenge_report                resolve challenge
  Pending ──────────────▶ Verified ─────────────▶ Challenged ───────────────▶ Rejected
                    ▲                                            │                      (or Verified)
                    │                                            └─ resolve in favour ──▶ Verified
                    └─────────────────────────────────────────────────────────────────────
```

- `POST /oracle/reports` creates a `Pending` (then `Verified`) report.
- `POST /oracle/challenge/:reportId` opens a challenge -> report becomes
  `Challenged`. The response includes `counterEvidenceHash`, `challengerAddress`,
  `reason`, and `resolved: false`.
- The challenge is resolved on-chain; `get_challenge_history` then reports
  `resolved: true` with a `resolution` status. The report's status follows the
  resolution (`Rejected` if the challenge succeeded, `Verified` if it did not).

## Reviewing challenges

- **By project:** `GET /oracle/reports/:projectId/challenges` returns every
  `Challenged` report for the project, each paired with its latest
  `ChallengeRecord` (counter-evidence hash, challenger, submitted time,
  resolution).
- **By report:** `GET /oracle/challenges/:reportId` returns the report status
  plus the full list of on-chain challenge records (the resolution history).
- **By provider:** `GET /oracle/stats/:providerAddress` already exposes
  `challengeHistory` (and `slashHistory`) for a provider's track record.

## Coupon distribution eligibility

A bond coupon pays out on the carbon data in its referenced oracle report. If
that report is `Challenged` or `Rejected`, the data is disputed and must not be
paid on.

`GET /oracle/projects/:projectId/coupon-eligibility` returns:

```json
{
  "projectId": "…",
  "eligible": false,
  "reasons": ["1 report(s) are challenged or rejected and must be resolved first"],
  "blockedByReportIds": [7]
}
```

`BondsService.distributeCoupon` consults this when an `OracleService` is wired
in: it fetches the referenced report and **blocks** distribution with a
`400 Bad Request` when the report is `Challenged` or `Rejected`. The bond detail
UI should call the eligibility endpoint and **warn** (or disable the
distribution action) whenever `eligible` is `false`, before the operator hits
the guarded endpoint.

## Frontend

- `api.getProjectChallengedReports(projectId)` / `api.getReportChallengeState(
  reportId)` / `api.getCouponEligibility(projectId)` in `shared/services/
  api.service.ts`.
- The project view renders a challenged-reports panel listing each disputed
  report with its counter-evidence hash, challenger, submitted time, and
  resolution, sourced from `/oracle/reports/:projectId/challenges`.
- The bond detail view calls `getCouponEligibility` for the bond's project and
  shows a blocking warning when `eligible` is `false`.
