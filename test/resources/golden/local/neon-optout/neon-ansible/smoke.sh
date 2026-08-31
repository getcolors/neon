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

role="neon"
db="neondb"
bucket="neon-storage-example"
prefix="neon-optout/data"
endpoint="https://example.eu.r2.cloudflarestorage.com"
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
# rclone, not awscli: Ubuntu 24.04 carries no awscli package. Configured
# entirely from the environment — no config file to manage or leak.
set -a; . /etc/neon/r2.env; set +a
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$endpoint"
export RCLONE_CONFIG_R2_REGION="auto"
# Two flags Ubuntu's rclone needs against a bucket-scoped R2 token: without
# no_check_bucket every upload is preceded by a CreateBucket that the token
# denies (AccessDenied on what looks like a plain write), and without
# no_head the post-upload verification trips a 501 on the first attempt.
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true RCLONE_CONFIG_R2_NO_HEAD=true
first_object() {
  rclone lsf "r2:$bucket/$prefix/$1/" --recursive --files-only 2>/dev/null | head -1
}

pages=$(first_object pageserver)
if [ -z "$pages" ]; then
  echo "neon-smoke: no pageserver objects under $prefix/pageserver/ in R2" >&2
  exit 1
fi

# The safekeeper offloads closed segments only, so close one: pg_switch_wal
# needs more than the application role, which is exactly what cloud_admin's
# generated password is for.
run_psql "$admin_pw" "postgresql://cloud_admin@127.0.0.1:55433/postgres?connect_timeout=10" \
  -tAc "SELECT pg_switch_wal();" >/dev/null
wal=""
for _ in $(seq 1 24); do
  wal=$(first_object safekeeper)
  [ -n "$wal" ] && break
  sleep 5
done
if [ -z "$wal" ]; then
  echo "neon-smoke: no safekeeper WAL segments under $prefix/safekeeper/ in R2 after pg_switch_wal" >&2
  exit 1
fi

# --- complete the ownership handshake ---------------------------------------
# Emptiness counts as absence: a 0-byte marker satisfies a bare existence
# check forever while carrying no ownership, so the test is on content and
# the write is verified by read-back.
if [ "$(rclone cat "r2:$bucket/$prefix/.colors-ready" 2>/dev/null)" != "neon-optout" ]; then
  ready=$(mktemp); printf '%s' "neon-optout" > "$ready"
  rclone copyto "$ready" "r2:$bucket/$prefix/.colors-ready"
  rm -f "$ready"
  back=$(rclone cat "r2:$bucket/$prefix/.colors-ready" 2>/dev/null || true)
  if [ "$back" != "neon-optout" ]; then
    echo "neon-smoke: ready marker read back as '$back', expected 'neon-optout'" >&2
    exit 1
  fi
  echo "CHANGED: wrote ready marker"
fi

echo "neon-smoke: round-trip, auth negatives, and R2 evidence all hold"
