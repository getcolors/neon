# Configuration

Every key `colors.yml` may carry, and every credential the package reads.
Non-secret values only: credentials are `COLORS_PAR_*` environment variables.

## Identity and providers

| Key | Meaning |
|---|---|
| `profile` | Names the work directory, the OpenTofu state key (`<profile>/<stage>.tfstate`), the machine keypair, the `~/.ssh/config` alias, the Vultr resources, and the R2 data prefix (`<profile>/data/`). Never overlay it from the environment. |
| `workdir` | Where rendered output goes. Conventionally `.colors`. |
| `provider-compute` | Must be `vultr`. |
| `provider-backend` | `local`, `s3` or `r2`. |
| `compute-prevent-destroy` | Keep `true` in committed desired state. |

There is deliberately no `provider-dns`: nothing in this package is reachable
by name. The firewall opens 22 only and the client path is an SSH tunnel.

## Neon

| Key | Meaning |
|---|---|
| `neon-image` | The storage image (pageserver, safekeeper, storage broker). Must be pinned by digest (`tag@sha256:...`). |
| `neon-compute-image` | The compute-node image, matched to `neon-pg-version` (`compute-node-v17` for 17). Must be pinned by digest. Upstream cut its last versioned releases in July 2025; `release-9129` + `release-compute-9073` are the final deliberate pairing. |
| `neon-pg-version` | 14, 15, 16, or 17. Must agree with the compute image. |
| `neon-tenant-id` | 32-hex tenant identity. Desired state, not a runtime accident: it is what makes convergence reconcilable and recovery describable. Generate with `openssl rand -hex 16`. |
| `neon-timeline-id` | 32-hex timeline identity, same rules. |
| `neon-database` | The application database convergence creates. |
| `neon-role` | The application role that owns it. Never `cloud_admin`. |

## Neon data in R2

| Key | Meaning |
|---|---|
| `neon-r2-bucket` | The bucket pageserver layers and safekeeper WAL live in, under `<profile>/data/`. |
| `neon-r2-endpoint` | The account's S3 endpoint (`https://<account>.r2.cloudflarestorage.com` or the EU variant). |
| `neon-r2-region` | `auto` for R2. |

Adoption of the prefix is two-phase: convergence writes
`<profile>/data/.colors-init` before any data can exist and
`<profile>/data/.colors-ready` only after the smoke gates pass. A prefix with
data but no matching ready marker fails the converge instead of being
attached; the repair for a known-stale prefix is deliberate and manual —
delete `<profile>/data/` in R2 yourself and re-run create. A
`.colors-generation` counter beside the markers keeps re-attach generations
monotonic across host rebuilds. Never configure R2 lifecycle rules on the
bucket.

## Vultr

| Key | Meaning |
|---|---|
| `vultr-name` | Optional. The machine is named after the profile (Compute Name Standard); set this only to override. |
| `vultr-region` | e.g. `ams`. |
| `vultr-plan` | e.g. `vc2-4c-8gb`. 4 GiB invites bootstrap OOM; 8 GiB is the floor. |
| `vultr-os-id` | Numeric OS id; 2284 is Ubuntu 24.04 LTS x64. |
| `vultr-ssh-keys` | Optional. Absent selects keygen mode (the package owns `~/.ssh/<profile>`); an existing account key id selects opt-out mode. |
| `vultr-ssh-sources` | CIDRs allowed to reach 22 — the only open port. |

## State backend

| Key | Meaning |
|---|---|
| `r2-bucket`, `r2-endpoint` | Where `<profile>/<stage>.tfstate` lives when `provider-backend: r2`. |

## Credentials

| Variable | Used for |
|---|---|
| `COLORS_PAR_VULTR_API_KEY` | The instance, firewall, and account SSH key. |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `COLORS_PAR_R2_SECRET_ACCESS_KEY` | The tofu state backend (operator machine only). |
| `COLORS_PAR_NEON_R2_ACCESS_KEY_ID` / `COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY` | The one pair that reaches the host: pageserver and safekeeper remote storage. Prefer a bucket-scoped token. |

Moving to a different bucket is a **migration, not an edit**: pointing
`neon-r2-bucket` somewhere empty makes the next converge mint a brand-new
empty database there (the bootstrap sees no data and initializes). The
procedure is: stop compute, then — while the pageserver still runs — wait
for its uploads to drain (`remote_consistent_lsn` in
`GET /v1/tenant/<t>/timeline/<tl>` catches up to `last_record_lsn` on the
checkpoint cadence; the metric is only meaningful on a running pageserver,
it reads 0/0 right after a restart), then stop the storage tier, copy the
prefix (`rclone sync r2old:<bucket>/<profile>/data r2new:<bucket>/<profile>/data`),
verify the object count and bytes match, update `neon-r2-bucket` and the
credentials, then re-converge — which re-adopts via the copied ready marker.

Generated on the server, never operator-supplied: the `cloud_admin` and
application-role passwords with their SCRAM verifiers
(`/etc/neon/secrets/`), and the compute JWKS keypair.

## Recovery

The R2 prefix plus the tenant/timeline ids *are* the database. If the host is
lost: `delete` (guarded) then `create` rebuilds a fresh host; the bootstrap
finds the ready marker with this profile, re-attaches the tenant at the next
generation, and the pageserver rebuilds its local state from R2 — bounded by
what the pageserver had uploaded (a fresh safekeeper cannot serve offloaded
WAL back, so the RPO is the activity since the last checkpoint upload).
Wiping only the pageserver's local `tenants/` directory and re-running
`create` exercises the same path without a rebuild and loses nothing, since
the surviving safekeeper replays its WAL (rehearsed, generation counter and
all). The
compute container is recreate-only — `docker compose up -d --force-recreate
compute` — never restarted by hand.
