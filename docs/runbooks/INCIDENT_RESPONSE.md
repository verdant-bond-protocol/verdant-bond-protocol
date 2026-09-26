# Verdant Bond Protocol - Incident Response Runbook

Closes #273

## Incident Categories

### Severity Levels
- **P0**: Service down, data loss, security breach
- **P1**: Core functionality impaired, financial impact  
- **P2**: Non-critical feature degraded
- **P3**: Minor issues

### Common Categories
1. Bond Settlement Failures
2. Data Inconsistency  
3. Authentication Issues
4. Performance Degradation
5. Integration Failures

## Triage Process

### Initial Assessment (5 min)

```bash
# Health checks
curl https://api.verdant-bond.example/health
curl https://api.verdant-bond.example/health/db

# Recent deployments
git log --oneline -5

# Error logs  
kubectl logs -n verdant-bond deployment/api --tail=100 | grep ERROR
```

## Emergency Rollback

### Feature Flag (1 min)
```bash
kubectl set env deployment/api FEATURE_NEW=false -n verdant-bond
```

### Application Rollback (5 min)
```bash
kubectl rollout undo deployment/api -n verdant-bond
kubectl rollout status deployment/api -n verdant-bond
```

### Database Rollback (10 min)
```bash
npm run migrate:rollback
```

## Common Incidents

### Bond Settlement Failures
```bash
# Diagnose
psql -c "SELECT * FROM settlements WHERE status='pending' AND created_at < NOW() - INTERVAL '10 minutes';"

# Resolve
npm run retry-settlements -- --older-than=10m
```

### DB Connection Exhaustion
```bash
# Diagnose
psql -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# Resolve
kubectl set env deployment/api DB_POOL_MAX=50 -n verdant-bond
```

### Data Inconsistency
```bash
# Diagnose
npm run validate:consistency -- --since=1h

# Resolve
npm run reconcile -- --auto-fix
```

## Validation Commands

```bash
# Health
curl https://api.verdant-bond.example/health | jq .

# Database
psql -c "SELECT 1;"

# Recent activity
psql -c "SELECT id, status FROM bonds ORDER BY created_at DESC LIMIT 10;"
```

## Communication Template

```
Subject: [P1] Verdant Bond - <Issue>
Status: Investigating
Impact: <description>
ETA: <time>
```

Last Updated: 2024-01-01
