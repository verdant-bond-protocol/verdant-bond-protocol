# Oracle Signer Rotation & Revocation (#618)

## Overview
Verdant Bond Protocol implements a two-layer oracle signer lifecycle covering both off-chain symmetric HMAC keyrings (`oracle/keyring.ts`) and on-chain provider signer bindings (`contracts/oracle-consumer/src/lib.rs`).

## Lifecycle & Flows

### Normal Rotation
1. **Off-chain (`OracleKeyring.rotateKey`)**: Introduces a new key at `validFromMs` and bounds the previous key's `validUntilMs` to `validFromMs + overlapMs` so in-flight reports signed moments before rotation still verify.
2. **On-chain (`OracleConsumer::rotate_provider_signer`)**: Authorized by either the contract `admin` or the `provider` itself. Rebinds `ProviderSigner(provider)` and `SignerToProvider(new_signer)` while clearing the previous reverse mapping.

### Emergency Revocation
1. **Off-chain (`OracleKeyring.revokeKey` / `rotateAndRevoke`)**: Immediately marks a key as revoked at `revokedAtMs` with `reason` and `actor` audit metadata. Any signature timestamped at or after `revokedAtMs` is rejected even if `validUntilMs` has not elapsed.
2. **On-chain (`OracleConsumer::revoke_provider_signer`)**: Records a `SignerRevocation` entry in `DataKey::RevokedSigner(signer)`, removes `SignerToProvider`, and clears `ProviderSigner` if the revoked key was active.

## Edge Cases & Recovery / Rollback
- **Revoked key replay**: Rejected on both `verify()` and `sign()`.
- **Re-using a revoked signer on-chain**: `rotate_provider_signer` rejects any `new_signer` present in `RevokedSigner`.
- **Erroneous off-chain revocation**: `OracleKeyring.reinstateKey(keyId, reinstatedAtMs)` restores the key only if its `validUntilMs` window has not already expired.
- **Erroneous on-chain revocation**: The provider or admin recovers by calling `rotate_provider_signer` with a fresh, non-revoked signer address.
- **Authorization**: Non-admin, non-provider callers are rejected with `OracleError::Unauthorized`. Nonces prevent replay of rotation/revocation transactions.
