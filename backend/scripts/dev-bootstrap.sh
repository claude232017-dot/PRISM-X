#!/usr/bin/env bash
#
# Brings up a complete local backend: PostgreSQL, Redis, schema, RLS policies
# and seed data. Idempotent — safe to re-run.
#
# Intended for ephemeral dev containers, where the database does not survive
# a restart but the migrations (which do, in git) are the source of truth.
#
#   ./scripts/dev-bootstrap.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=${PGDATA:-/var/lib/postgresql/data}

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "PostgreSQL"
mkdir -p "$PGDATA" /var/run/postgresql
chown -R postgres:postgres "$PGDATA" /var/run/postgresql 2>/dev/null || true

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "initialising cluster..."
  su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth-local=trust --auth-host=trust" >/dev/null
fi

if ! pg_isready -q 2>/dev/null; then
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/pg.log -o '-p 5432' start" >/dev/null
  for _ in $(seq 1 30); do pg_isready -q 2>/dev/null && break; sleep 1; done
fi
pg_isready

for db in prismx prismx_test; do
  psql -U postgres -h 127.0.0.1 -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" \
    | grep -q 1 || psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE $db" >/dev/null
done
echo "databases ready: prismx, prismx_test"

step "Redis"
redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --port 6379 >/dev/null
sleep 1
redis-cli ping

step "Environment"
if [ ! -f .env ]; then
  cp .env.example .env
  # Real random secrets, so a dev instance is never running on placeholders.
  sed -i "s|^CREDENTIAL_ENCRYPTION_KEY=.*|CREDENTIAL_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")|" .env
  echo "created .env with generated secrets"
else
  echo ".env already present, leaving it alone"
fi

step "Dependencies"
[ -d node_modules ] || npm install --no-audit --no-fund

step "Schema + RLS"
npx prisma generate >/dev/null
npx prisma migrate deploy

step "Seed"
npx ts-node --transpile-only prisma/seed.ts

step "Build"
# A stale tsbuildinfo makes tsc believe dist/ is current and emit nothing.
rm -f tsconfig.tsbuildinfo
npx nest build

printf '\n\033[1mReady.\033[0m  Start with: node dist/main.js\n'
printf 'API  http://127.0.0.1:3000/api/v1\n'
printf 'Docs http://127.0.0.1:3000/docs\n\n'
