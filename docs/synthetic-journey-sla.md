# Synthetic Journey SLA & Fault Attribution

The `SyntheticJourneyMonitor` (`api/src/ops/synthetic-journey.monitor.ts`) probes the public investor subscription workflow end-to-end and classifies failures by dependency:

- `readiness` -> inspects `/api/health/ready` for `redis`, `config`, or `soroban-rpc` degradation.
- `list-bonds` / `bond-detail` / `preview-subscribe` -> validates active bond discovery and Soroban RPC simulation.
- `subscribe` / `confirm-transaction` -> optional authenticated write path using `Idempotency-Key` headers and transaction polling.

## Verification

Run the SLA and fault attribution suite from `api/`:

```bash
npm test -- src/ops/synthetic-journey-sla.spec.ts
```
