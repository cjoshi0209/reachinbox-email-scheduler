#!/usr/bin/env bash
# Starts the full stack in production mode on a single host (used for the GitHub Codespace demo):
# Postgres + Redis (AOF) + Elasticsearch via docker compose, then the API, the worker and the
# Next.js dashboard. Requires backend/.env (see backend/.env.example). Logs go to ./logs.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs

docker compose up -d
echo "waiting for postgres/redis/elasticsearch..."
for i in $(seq 1 90); do
  if docker compose exec -T postgres pg_isready -U reachinbox >/dev/null 2>&1 \
    && docker compose exec -T redis redis-cli ping >/dev/null 2>&1 \
    && curl -fs localhost:9200/_cluster/health >/dev/null 2>&1; then break; fi
  sleep 2
done

(cd backend && ([ -d node_modules ] || npm ci || npm install --no-audit --no-fund)) >/dev/null
(cd frontend && ([ -d node_modules ] || npm ci || npm install --no-audit --no-fund)) >/dev/null

cd backend
npx prisma migrate deploy
npm run build
pkill -f "node dist/server.js" || true
pkill -f "node dist/worker.js" || true
NODE_ENV=production nohup node dist/server.js > ../logs/api.log 2>&1 &
NODE_ENV=production nohup node dist/worker.js > ../logs/worker.log 2>&1 &
cd ../frontend
npm run build
pkill -f "next start" || true
nohup npx next start -p 3000 > ../logs/frontend.log 2>&1 &
cd ..

for i in $(seq 1 60); do curl -fs localhost:4000/health >/dev/null 2>&1 && curl -fs -o /dev/null localhost:3000/login && break; sleep 2; done
curl -s localhost:4000/health; echo
echo "stack is up: dashboard :3000, API :4000"
