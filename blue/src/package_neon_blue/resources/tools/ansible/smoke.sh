#!/usr/bin/env bash
# Server-side acceptance for the Neon deployment, run during convergence.
#
# Exit codes are not evidence; each gate asks the system what it actually has:
# the SQL round-trip proves the whole write path (compute, walproposer, the
# safekeeper, the pageserver), the auth negatives prove the loopback port is a
# gate rather than an open door, and the R2 listings prove remote storage is
# real — layer objects from the pageserver, offloaded WAL segments from the
# safekeeper — under this deployment's own prefix. Only after every gate holds
# does the ready marker land, completing the two-phase ownership handshake
# bootstrap.sh opened.
set -euo pipefail

role="<{ neon-role }>"
db="<{ neon-database }>"
bucket="<{ neon-r2-bucket }>"
prefix="<{ neon-r2-prefix }>"
endpoint="<{ neon-r2-endpoint }>"
url="postgresql://$role@127.0.0.1:55433/$db?connect_timeout=10"

pw=$(cat /etc/neon/secrets/neon_role_password)
admin_pw=$(cat /etc/neon/secrets/cloud_admin_password)

run_psql() { # $1 password (empty = none), $2... psql args
  local p="$1"; shift
  env -i PATH=/usr/bin:/bin PGPASSWORD="$p" PGCONNECT_TIMEOUT=10 psql -w "$@"
}

# --- the round-trip ---------------------------------------------------------
count=$(run_psql "$pw" "$url" -v ON_ERROR_STOP=1 -tAc "
  CREATE TABLE IF NOT EXISTS colors_smoke (id int PRIMARY KEY, note text, at timestamptz);
  INSERT INTO colors_smoke (id, note, at) VALUES (1, 'server-side', now())
    ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at;
  SELECT count(*) FROM colors_smoke;" | tail -1 | tr -d '[:space:]')
if [ "$count" != "1" ]; then
  echo "neon-smoke: colors_smoke should hold exactly one row, got '$count'" >&2
  exit 1
fi

# --- the negatives ----------------------------------------------------------
if run_psql "not-the-password" "$url" -c "SELECT 1" >/dev/null 2>&1; then
  echo "neon-smoke: a wrong password was accepted; the port is an open door" >&2
  exit 1
fi
if run_psql "" "$url" -c "SELECT 1" >/dev/null 2>&1; then
  echo "neon-smoke: a passwordless connection was accepted; the port is an open door" >&2
  exit 1
fi
if run_psql "$pw" "$url" -c "CREATE ROLE colors_smoke_escalation SUPERUSER" >/dev/null 2>&1; then
  echo "neon-smoke: the $role role could create a superuser; it is over-privileged" >&2
  exit 1
fi

# --- remote storage is real -------------------------------------------------
set -a; . /etc/neon/r2.env; set +a
s3() { aws s3api "$@" --endpoint-url "$endpoint" --region "<{ neon-r2-region }>"; }
list_count() {
  s3 list-objects-v2 --bucket "$bucket" --prefix "$prefix/$1/" --max-keys 1 \
    --query 'KeyCount' --output text 2>/dev/null || echo 0
}

pages=$(list_count pageserver)
if [ "${pages:-0}" = "0" ] || [ "${pages:-0}" = "None" ]; then
  echo "neon-smoke: no pageserver objects under $prefix/pageserver/ in R2" >&2
  exit 1
fi

# The safekeeper offloads closed segments only, so close one: pg_switch_wal
# needs more than the application role, which is exactly what cloud_admin's
# generated password is for.
run_psql "$admin_pw" "postgresql://cloud_admin@127.0.0.1:55433/postgres?connect_timeout=10" \
  -tAc "SELECT pg_switch_wal();" >/dev/null
wal=0
for _ in $(seq 1 24); do
  wal=$(list_count safekeeper)
  [ "${wal:-0}" != "0" ] && [ "${wal:-0}" != "None" ] && break
  sleep 5
done
if [ "${wal:-0}" = "0" ] || [ "${wal:-0}" = "None" ]; then
  echo "neon-smoke: no safekeeper WAL segments under $prefix/safekeeper/ in R2 after pg_switch_wal" >&2
  exit 1
fi

# --- complete the ownership handshake ---------------------------------------
ready=$(mktemp)
if ! s3 get-object --bucket "$bucket" --key "$prefix/.colors-ready" "$ready" >/dev/null 2>&1; then
  printf '%s' "<{ profile }>" > "$ready"
  s3 put-object --bucket "$bucket" --key "$prefix/.colors-ready" --body "$ready" >/dev/null
  echo "CHANGED: wrote ready marker"
fi
rm -f "$ready"

echo "neon-smoke: round-trip, auth negatives, and R2 evidence all hold"
