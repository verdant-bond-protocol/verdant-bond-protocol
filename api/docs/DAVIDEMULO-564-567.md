# Davidemulo hardening slice (#564–#567)

This focused verification slice covers the request-correlation and privacy
boundary. The upstream merge target supplies the related actor-scoped conflict
and expiring-capability implementations; the executable check prevents the
request/response observability path from regressing while those protections are
used by retries and authorization failures.

Correlation IDs are accepted from the caller when present and generated when
absent. Authorization-bearing log fields are redacted before serialization.
Conflict handling remains fail-closed, and expired/revoked capability grants
must not authorize a sensitive action.
