#!/usr/bin/env bash
# Reconcile this deployment's Neon identity: the R2 prefix ownership markers,
# the tenant, and the timeline. Idempotent by construction — every step reads
# before it writes, treats already-done as success, and verifies its
# postcondition — so a converge that runs this twice changes nothing the
# second time. Prints CHANGED lines for the steps that acted; the playbook's
# changed_when keys on them.
#
# Ownership is two-phase (init marker before any data can exist, ready marker
# only after the smoke gates pass), so three prefix states are distinguishable:
# ready + matching profile is adoptable, init + matching profile is our own
# interrupted bootstrap and safe to resume, anything else with data is foreign
# or unaccounted-for and fails the converge instead of being attached. The
# repair for a genuinely stale prefix is deliberate and manual: delete
# <prefix>/ in R2 yourself, then re-run create.
set -euo pipefail

profile="<{ profile }>"
tenant="<{ neon-tenant-id }>"
timeline="<{ neon-timeline-id }>"
pg_version=<{ neon-pg-version }>
bucket="<{ neon-r2-bucket }>"
prefix="<{ neon-r2-prefix }>"
endpoint="<{ neon-r2-endpoint }>"
ps="http://127.0.0.1:9898"

set -a; . /etc/neon/r2.env; set +a
s3() { aws s3api "$@" --endpoint-url "$endpoint" --region "<{ neon-r2-region }>"; }

get_marker() {
  local key="$prefix/$1" out
  out=$(mktemp)
  if s3 get-object --bucket "$bucket" --key "$key" "$out" >/dev/null 2>&1; then
    cat "$out"; rm -f "$out"
  else
    rm -f "$out"; return 1
  fi
}
put_marker() {
  local key="$prefix/$1" body
  body=$(mktemp); printf '%s' "$2" > "$body"
  s3 put-object --bucket "$bucket" --key "$key" --body "$body" >/dev/null
  rm -f "$body"
}

# --- prefix ownership -------------------------------------------------------
ready=$(get_marker .colors-ready || true)
init=$(get_marker .colors-init || true)
if [ -n "$ready" ]; then
  if [ "$ready" != "$profile" ]; then
    echo "bootstrap: R2 prefix $prefix/ is owned by '$ready', not '$profile'; refusing to attach" >&2
    exit 1
  fi
elif [ -n "$init" ]; then
  if [ "$init" != "$profile" ]; then
    echo "bootstrap: R2 prefix $prefix/ carries another deployment's in-flight bootstrap ('$init'); refusing" >&2
    exit 1
  fi
  echo "bootstrap: resuming this deployment's interrupted bootstrap"
else
  count=$(s3 list-objects-v2 --bucket "$bucket" --prefix "$prefix/" --max-keys 1 \
            --query 'KeyCount' --output text 2>/dev/null || echo 0)
  if [ "${count:-0}" != "0" ] && [ "${count:-0}" != "None" ]; then
    echo "bootstrap: R2 prefix $prefix/ holds data but no ownership marker; refusing to adopt." >&2
    echo "bootstrap: if this prefix is known-stale, delete it in R2 and re-run create." >&2
    exit 1
  fi
  put_marker .colors-init "$profile"
  echo "CHANGED: wrote init marker"
fi

# --- tenant -----------------------------------------------------------------
attached=$(curl -s "$ps/v1/tenant" | jq -r --arg t "$tenant" '.[] | select(.id==$t) | .id' || true)
if [ -z "$attached" ]; then
  # The generation must rise across attaches of the same tenant (a fresh local
  # state re-attaching R2 data is exactly the recovery case), so it lives as a
  # counter object beside the markers rather than resetting with the host.
  gen=$(get_marker .colors-generation || echo 0)
  case "$gen" in (*[!0-9]*|'') gen=0;; esac
  gen=$((gen + 1))
  curl -sf -X PUT -H 'Content-Type: application/json' \
    -d "{\"mode\": \"AttachedSingle\", \"generation\": $gen, \"tenant_conf\": {}}" \
    "$ps/v1/tenant/$tenant/location_config" >/dev/null
  put_marker .colors-generation "$gen"
  echo "CHANGED: attached tenant $tenant at generation $gen"
fi
for _ in $(seq 1 60); do
  state=$(curl -s "$ps/v1/tenant" | jq -r --arg t "$tenant" '.[] | select(.id==$t) | .state.slug' || true)
  [ "$state" = "Active" ] && break
  sleep 2
done
if [ "${state:-}" != "Active" ]; then
  echo "bootstrap: tenant $tenant did not become Active (state: ${state:-absent})" >&2
  exit 1
fi

# --- timeline ---------------------------------------------------------------
if ! curl -sf "$ps/v1/tenant/$tenant/timeline/$timeline" >/dev/null 2>&1; then
  code=$(curl -s -o /tmp/neon-timeline.out -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d "{\"new_timeline_id\": \"$timeline\", \"pg_version\": $pg_version}" \
    "$ps/v1/tenant/$tenant/timeline/")
  # 201 created it, 409 means it already exists (a lost race with a previous
  # interrupted run) — both leave the postcondition below to decide.
  if [ "$code" != "200" ] && [ "$code" != "201" ] && [ "$code" != "409" ]; then
    echo "bootstrap: timeline creation returned $code: $(cat /tmp/neon-timeline.out)" >&2
    exit 1
  fi
  echo "CHANGED: created timeline $timeline"
fi
for _ in $(seq 1 60); do
  tstate=$(curl -s "$ps/v1/tenant/$tenant/timeline/$timeline" | jq -r '.state' || true)
  [ "$tstate" = "Active" ] && break
  sleep 2
done
if [ "${tstate:-}" != "Active" ]; then
  echo "bootstrap: timeline $timeline did not become Active (state: ${tstate:-absent})" >&2
  exit 1
fi

echo "bootstrap: tenant and timeline Active"
