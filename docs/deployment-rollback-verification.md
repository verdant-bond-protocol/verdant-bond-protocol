# Deployment rollback verification

Before promoting a deployment, record its version and an immutable step id. If a deployment fails, rollback verification requires:

- the previous step to be successfully deployed;
- the rollback target to equal that previous version; and
- an explicit authorized operator.

The executable checks live in `api/src/common/services/deployment-verification.service.ts` and reject duplicate or incomplete step records. They are independent of deployment tooling so CI and release scripts can consume the same rule set.
