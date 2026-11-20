# Cross-Environment Configuration Contract (#352)

`EnvConfigValidator` checks each variable at boot (present, valid URL, strong
secret, valid contract id). The configuration contract
(`api/src/common/config/config-contract.ts`) checks what only shows up
**across** variables and **across** environments. Those are the
misconfigurations that silently point the protocol at the wrong ledger or let
one leaked secret compromise two environments.

```bash
cd api
npm run config:contract -- --target=production                       # current process env
npm run config:contract -- --target=production --file=.env.production
npm run config:contract -- --target=production --file=.env.production --compare=.env.staging
```

Exit code 0 means pass, 1 means violations, 2 means bad usage. Output names
variables and codes only, never values.

## Rules

| Code | Rule | Targets |
|------|------|---------|
| `MISSING` | Required vars are present and non-blank. Staging adds `STELLAR_PUBLIC_KEY`, `GOVERNANCE_ADDRESS` and `DEFAULT_PROVIDER_ADDRESS`. Production also adds `KYC_PROVIDER_URL`, `KYC_API_KEY`, `AUDIT_EVIDENCE_PEPPER` and `APP_URL` | all |
| `NODE_ENV_MISMATCH` | `NODE_ENV` fits the target (`production` only for production) | all |
| `NETWORK_MISMATCH` | production → `mainnet`; staging → `testnet`; development → `testnet`/`standalone` | all |
| `ENDPOINT_NETWORK_MISMATCH` | Horizon and RPC hosts agree with `STELLAR_NETWORK` (no testnet or futurenet hosts on mainnet, no SDF mainnet host off mainnet) | all |
| `INVALID_URL` | URLs parse | all |
| `INSECURE_URL` / `LOOPBACK_URL` | External endpoints use https; no loopback hosts for any URL, including DB and Redis | staging, production |
| `INVALID_CONTRACT_ID` / `DUPLICATE_CONTRACT_ID` | Each contract var is a `C…` id, and no id fills two roles | all |
| `INVALID_SECRET_SEED` | Signer keys are `S…` seeds | all |
| `SHARED_SIGNER` | Admin, investor and user signer keys are distinct | staging, production |
| `ADMIN_KEY_MISMATCH` | `STELLAR_PUBLIC_KEY` is the public key of `ADMIN_SECRET_KEY` | all |
| `FILE_SIGNER_IN_PRODUCTION` | `SIGNING_KEY_PROVIDER=file` is not allowed | production |
| `SHARED_SECRET` | `JWT_REFRESH_SECRET` ≠ `JWT_SECRET` | all |
| `INVALID_PROVIDER` / `PROVIDER_NOT_WHITELISTED` | Oracle whitelist entries are `G…` accounts, and `DEFAULT_PROVIDER_ADDRESS` is one of them | all |
| `SHARED_ACROSS_ENVIRONMENTS` | (`--compare`) No JWT secret, signer key, IPFS/KYC key, evidence pepper, database URL or contract id is identical between the two envs | pair |

Tests: `api/src/common/config/config-contract.spec.ts` builds a valid profile
per target and breaks one rule per case.

## Rollout plan (compatibility)

The contract is **not** wired into application startup. Existing deployments
boot exactly as before. Rollout:

1. **Now.** CI and the deploy pipeline run `config:contract` against the
   rendered env for the target, with `--compare` against the neighbouring
   environment. A failure blocks the deploy.
2. **After one clean release cycle.** Optionally call `checkConfigContract`
   from `EnvConfigValidator.onModuleInit` behind a flag, starting in warn-only
   mode.

## Operational edge cases

- **Third-party RPC providers.** Hosts without "testnet" in their name pass on
  testnet. The mainnet check rejects anything that looks like a test or
  loopback host, so a mainnet RPC must not carry those tokens.
- **Local development.** `localhost` URLs, `http`, and shared signer keys are
  allowed for `--target=development`. `.env.example` placeholders (`C...`,
  `S...`) fail on purpose until real values are filled in.
- **Contract redeploys.** Update every contract var together. A partial update
  that reuses the old id for a new role trips `DUPLICATE_CONTRACT_ID`.
- **Recovery from a bad deploy.** If a release shipped with a violating
  config, roll back to the last env revision that passed. Then rotate any
  secret reported as `SHARED_ACROSS_ENVIRONMENTS`, because both environments
  must now be treated as having that secret exposed.
