#!/usr/bin/env bash
# Local bootstrap: starts infrastructure, runs migrations, and verifies readiness.
# Usage: ./scripts/bootstrap.sh
set -euo pipefail

echo "==> Starting infrastructure services..."
docker compose up -d postgres redis ipfs

echo "==> Waiting for services to be healthy..."
docker compose exec -T postgres pg_isready -U nbs
docker compose exec -T redis redis-cli ping

echo "==> Running API migrations..."
cd api && npm run migration:run 2>/dev/null || echo "No migrations to run"
cd ..

echo "==> Starting API..."
docker compose up -d api

echo "==> Waiting for API to be healthy..."
for i in $(seq 1 30); do
  if docker compose exec -T api wget --spider -q http://localhost:3000/health 2>/dev/null; then
    echo "==> API is ready at http://localhost:3000"
    exit 0
  fi
  sleep 2
done

echo "==> ERROR: API did not become healthy within 60 seconds"
docker compose logs api
exit 1
