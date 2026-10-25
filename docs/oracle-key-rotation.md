# Oracle key rotation and emergency revocation

Oracle signing keys use a rolling validity window. A replacement key starts at
`validFromMs`; the retiring key remains valid through an explicitly bounded
overlap. Verifiers select the key by the signed timestamp and key id, so an
in-flight report remains verifiable during the overlap while new reports use
the replacement.

Normal rotation is immutable and produces an audit record of the windows it
extended. A key never remains valid indefinitely after a rotation. If a key is
compromised, emergency revocation is a separate path: two distinct recovery
approvers are required, and the key is invalid for signatures at or after the
revocation timestamp. Reports signed before that timestamp can still be
verified for audit purposes.

Operators should publish the new key before its start time, verify both keys
against a fixture report, and monitor for a rotation gap. Emergency decisions
must record both approver identities, the key id, timestamp, and incident
reference. The verifier fails closed for an unknown, expired, not-yet-valid, or
revoked key.
