# Dry-Run Previews for Destructive Maintainer Actions (#529)

Code: `api/src/maintenance/destructive-action-preview.service.ts`
Tests: `api/src/maintenance/destructive-action-preview.service.spec.ts`

Destructive maintainer actions (archive, purge, reindex, revoke, reset) run in
two steps so a maintainer always sees what will change before it changes.

## Flow

```
preview(action, params, actor)
  ├─ authorize actor (permission)            → FORBIDDEN
  ├─ plan(params)  — read-only, never mutates
  └─ returns DryRunPreview { previewId, planDigest, affectedCount, sample,
                             reversible, rollback, warnings, risk, expiresAt }

execute(previewId, action, params, actor, { confirmPlanDigest, acknowledgeBlastRadius? })
  ├─ preview exists / not consumed / not running / not expired
  ├─ same actor, permission re-checked, same params
  ├─ confirmPlanDigest === preview.planDigest
  ├─ blast-radius acknowledgement when affectedCount > maxAffected
  ├─ re-plan: digest differs                 → PREVIEW_STALE (preview discarded)
  └─ execute(params, plan)                   → preview consumed
```

Registering an action:

```ts
previews.register({
  action: 'archive_matured_bonds',
  permission: 'ARCHIVE_BONDS',
  maxAffected: 50,
  plan: (p) => ({ affected, reversible: true, rollback: 'POST /bonds/:id/restore' }),
  execute: (p, plan) => archive(plan.affected),
});
```

## Error codes

| Code | Meaning | Recovery |
|---|---|---|
| `UNKNOWN_ACTION` | No action registered under that name | Fix the action name |
| `FORBIDDEN` | Actor lacks the permission (at preview **or** execute) | Grant the permission, preview again |
| `PREVIEW_NOT_FOUND` | Unknown id, or id belongs to another action | Preview again |
| `PREVIEW_EXPIRED` | Older than the TTL (default 10 min) | Preview again |
| `PREVIEW_CONSUMED` | Already executed successfully | Nothing to do; it cannot run twice |
| `EXECUTION_IN_PROGRESS` | The same preview is executing right now | Wait for the first call |
| `PREVIEW_ACTOR_MISMATCH` | Only the maintainer who previewed may execute | That maintainer executes, or the other one previews |
| `PREVIEW_PARAMS_MISMATCH` | Parameters differ from the previewed ones | Preview the new parameters |
| `PREVIEW_NOT_CONFIRMED` | `confirmPlanDigest` does not match | Echo the preview's `planDigest` |
| `BLAST_RADIUS_NOT_ACKNOWLEDGED` | Plan exceeds `maxAffected` | Pass `acknowledgeBlastRadius: true` after review |
| `PREVIEW_STALE` | State changed between preview and execute | Review a fresh preview |

## Edge cases

- **No-op plans** preview with `risk: 'none'` and a warning; executing one is harmless.
- **Irreversible plans** are always `risk: 'high'` and carry a warning; the
  `rollback` text should say why the change cannot be undone.
- **Retry:** a failed `execute()` leaves the preview executable until it
  expires, so a transient failure can be retried with the same preview. If the
  failed attempt partially applied changes, the re-plan no longer matches and
  the retry is refused as `PREVIEW_STALE`: the maintainer reviews a new preview
  covering only what is left, instead of blindly re-running the original plan.
- **Revoked permissions** between preview and execute block the execution.
- Previews are held in memory: a restart drops them and maintainers preview
  again. Nothing was executed, so no rollback is needed.

## Compatibility

Additive: no existing route or contract changes. Existing destructive routes
can adopt the service one at a time by registering a `plan`/`execute` pair.
