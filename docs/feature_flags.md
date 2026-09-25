# Feature Flags Management

This document outlines the rollout, verification, and rollback processes for feature flags in the Verdant Bond Protocol.

## Current Feature Flags

| Flag Name | Description | Default State |
|-----------|-------------|---------------|
| `ENABLE_SECONDARY_MARKET` | Controls the ability to list and buy bond tokens on the secondary market. | `false` (Disabled) |

## Rollout Process

Feature flags are read dynamically from the environment variables (or configured configuration sources) in the API server.

1. **Staging Rollout**:
   - Deploy the new code with the feature flag `ENABLE_SECONDARY_MARKET=false` (or unset, as it defaults to false).
   - Verify that the dependent functionality (e.g., secondary market trading) is disabled. API requests to `buyBondTokens` or `listBondTokens` should return a `503 Service Unavailable` with a relevant message.
   - Update the configuration in the staging environment to `ENABLE_SECONDARY_MARKET=true`. Wait for the environment to reload or restart the service if required by your infrastructure.
   - Test the high-risk domain behavior (e.g., perform a listing and a buy operation).

2. **Production Rollout**:
   - Ensure the new version is deployed with the flag disabled initially.
   - Coordinate with maintainers to enable the flag via the environment variable configuration (e.g., Kubernetes ConfigMap, AWS Secrets, or .env file).
   - Once set to `true`, closely monitor API logs and the `dex.service.ts` error rates for any exceptions or irregular transaction failures.

## Verification

To verify the state of a feature flag and ensure the system behaves safely:

1. **Automated Verification**:
   - Run the provided validation script located at `api/validate-feature-flags.js`.
   - The script sets up the NestJS context, disables the flag, and ensures the `DexService` correctly throws an error when attempting to trade. It then enables the flag and confirms the configuration updates accordingly.

2. **Manual Verification**:
   - Send a `POST /marketplace/bonds/list` request while the flag is disabled. Ensure you receive a `503` status code.
   - Send the same request after enabling the flag, ensuring it proceeds past the feature flag check and returns either a `400`/`401` (due to missing auth) or processes the request successfully.

## Rollback Steps (Emergency Disable)

If severe issues, exploits, or irregular behaviors are detected in a feature protected by a feature flag, you can disable it instantly without requiring a full code rollback or redeploy:

1. Update the environment configuration, setting the feature flag back to `false` (e.g., `ENABLE_SECONDARY_MARKET=false`).
2. Restart the API servers or apply the configuration change if your infrastructure supports hot-reloading env vars.
3. Verify that the feature is disabled (e.g., attempt a trade and expect a `503` response).
4. Since this uses safe defaults, completely removing the environment variable will also fall back to the disabled (safe) state.
