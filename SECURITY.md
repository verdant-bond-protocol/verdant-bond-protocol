# Security Disclosure

## Reporting a Vulnerability
Email nwoguvictoriachiamaka@gmail.com with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- (Optional) Suggested fix

## Scope
- Soroban smart contracts (contracts/)
- NestJS API (api/)
- Oracle adapter scripts (oracle/)

## JWT Secret Management

### Secret Requirements (Enforced at Startup)
`JWT_SECRET` and `JWT_REFRESH_SECRET` are **required** in all non-test environments. The application will refuse to start if:
- Either secret is missing or empty
- The secret is shorter than 32 characters
- The secret contains common weak phrases (`dev-secret`, `secret`, `password`, `changeme`, `123456`)

Generate a cryptographically secure secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### JWT Secret Rotation Procedure

Rotate JWT secrets immediately if:
- A secret is accidentally committed to version control
- A secret appears in logs, dumps, or shared environments
- Team members with access leave the project
- On a regular schedule (recommended: every 90 days)
- A security incident involves the auth subsystem

**Step 1 — Generate new secrets**
```bash
export NEW_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
export NEW_JWT_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
```

**Step 2 — Update the environment**
Update `JWT_SECRET` and `JWT_REFRESH_SECRET` in your deployment environment (Kubernetes secrets, AWS Secrets Manager, `.env.production`, etc.). Do **not** restart the API yet.

**Step 3 — Force-invalidate existing sessions (optional, for compromised secrets)**
If you suspect active misuse, purge all active refresh tokens from Redis before rollout:
```bash
redis-cli --scan --pattern "refresh:*" | xargs -r redis-cli DEL
```
Note: The current implementation stores tokens statelessly. For active incident response, consider short-lived `JWT_EXPIRY` and `JWT_REFRESH_EXPIRY` values (e.g. 5m / 1h) until remediation is complete.

**Step 4 — Perform a rolling restart**
Deploy the updated env vars and restart all API instances. On startup each instance will validate the new secrets and refuse to boot if they are weak.

**Step 5 — Verify**
1. Confirm all instances are healthy and pass startup checks.
2. Issue a fresh login and verify access + refresh tokens work end-to-end.
3. Confirm that tokens issued before the rotation are rejected (log out all pre-rotation sessions).

### Test Environment
In `NODE_ENV=test` the `ConfigService` uses built-in, explicitly isolated test secrets. Never commit production secrets to test fixtures. Tests that need custom secrets can set `JWT_SECRET` / `JWT_REFRESH_SECRET` explicitly in their `beforeEach` hooks.
