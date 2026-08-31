#!/usr/bin/env bash
# Rotate the application role's password, atomically and with rollback.
#
# The new secret is generated here, its SCRAM verifier is swapped into the
# compute spec via tmpfile+rename, and the compute container is recreated —
# compute_ctl reapplies the spec's roles on startup, which is what makes a
# spec edit a rotation. The old password file is replaced only after the new
# password provably works and the old one is provably refused; any earlier
# failure restores the previous spec and recreates compute again, so the
# system never ends half-rotated. Nothing here prints or logs a secret.
set -euo pipefail

role="neon"
db="neondb"
spec=/etc/neon/config.json
pwfile=/etc/neon/secrets/neon_role_password
url="postgresql://$role@127.0.0.1:55433/$db?connect_timeout=10"

try_psql() { # $1 password
  env -i PATH=/usr/bin:/bin PGPASSWORD="$1" PGCONNECT_TIMEOUT=10 \
    psql -w "$url" -c "SELECT 1" >/dev/null 2>&1
}
recreate_compute() {
  docker compose -f /opt/neon/compose.yml up -d --force-recreate compute >/dev/null 2>&1
  for _ in $(seq 1 30); do
    if docker compose -f /opt/neon/compose.yml ps compute --format '{{.Health}}' | grep -q healthy; then
      return 0
    fi
    sleep 5
  done
  return 1
}

umask 077
old_pw=$(cat "$pwfile")
new_pw=$(openssl rand -hex 24)
verifier=$(printf '%s\n' "$new_pw" | python3 /opt/neon/scramgen.py)

backup=$(mktemp /etc/neon/config.json.rotate.XXXXXX)
cp "$spec" "$backup"

next=$(mktemp /etc/neon/config.json.next.XXXXXX)
jq --arg role "$role" --arg v "$verifier" \
  '(.spec.cluster.roles[] | select(.name == $role) | .encrypted_password) = $v' \
  "$spec" > "$next"
# The postgres user of the compute container (uid 1000) must be able to read
# the spec or compute_ctl dies with a bare Permission denied (os error 13).
chown 1000:1000 "$next"
chmod 0400 "$next"
mv "$next" "$spec"

rollback() {
  mv "$backup" "$spec"
  chown 1000:1000 "$spec"
  chmod 0400 "$spec"
  recreate_compute || true
  echo "neon-rotate: FAILED — previous spec restored, old password still active" >&2
  exit 1
}

# Both secret files are staged before the live checks, so the commit below
# is two adjacent renames and nothing else. The plaintext stages at a FIXED
# path on purpose: if the process dies between the renames, the new
# credential is still retrievable from neon_role_password.next rather than
# lost in an anonymous tmpfile — the recovery journal for the one window
# the renames cannot close.
rm -f /etc/neon/secrets/neon_role_password.next
pwbackup=$(mktemp /etc/neon/secrets/neon_role_password.old.XXXXXX)
cp "$pwfile" "$pwbackup"; chmod 0600 "$pwbackup"
pnext=/etc/neon/secrets/neon_role_password.next
umask 077; printf '%s\n' "$new_pw" > "$pnext"
chmod 0600 "$pnext"
vnext=$(mktemp /etc/neon/secrets/neon_role_verifier.XXXXXX)
printf '%s\n' "$verifier" > "$vnext"
chmod 0600 "$vnext"

recreate_compute || rollback
try_psql "$new_pw" || rollback
if try_psql "$old_pw"; then
  echo "neon-rotate: the old password still works after rotation; rolling back" >&2
  rollback
fi

# Commit: the verifier (what converge renders the spec from — updating it is
# what keeps the next converge from silently un-rotating the role) and the
# plaintext, as two adjacent renames. If either fails, everything — spec,
# verifier, plaintext, compute — is restored to the old credential, which
# the database then accepts again. A kill between the renames leaves the
# new plaintext recoverable at neon_role_password.next.
if ! { mv "$vnext" /etc/neon/secrets/neon_role_verifier && mv "$pnext" "$pwfile"; }; then
  cp "$pwbackup" "$pwfile"; chmod 0600 "$pwfile"
  printf '%s\n' "$(jq -r --arg role "$role" \
    '.spec.cluster.roles[] | select(.name == $role) | .encrypted_password' "$backup")" \
    > /etc/neon/secrets/neon_role_verifier
  chmod 0600 /etc/neon/secrets/neon_role_verifier
  rollback
fi
rm -f "$backup" "$pwbackup"
echo "neon-rotate: rotated; new password in $pwfile"
