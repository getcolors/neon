# neon

A tri-colour Package Skill (green, red, blue) that provisions **self-hosted
Neon — serverless Postgres with storage/compute separation — on one Vultr
instance**: the storage broker, the pageserver, one safekeeper, and a compute
node running Postgres under `compute_ctl`, with Cloudflare R2 as the remote
storage for pageserver layers and safekeeper WAL.

Nothing is published beyond loopback. The firewall opens **22 only**, there
is no DNS record, and the supported client path is an SSH tunnel through the
`~/.ssh/config` alias the package writes. The R2 prefix plus the tenant and
timeline ids in `colors.yml` *are* the database: a rebuilt host re-attaches
them and rehydrates from R2.

## Install

```sh
npx skills add getcolors/neon
cp .agents/skills/package-neon-green/green ./green
chmod +x green
```

The launcher in your project root is a **copy**, not a symlink. After
`npx skills update -p`, copy it again or the project keeps running the old pin.

The same deployment can run through the TypeScript (`package-neon-red`) or
Python (`package-neon-blue`) implementation — all three render byte-identical
artifacts from one `colors.yml`.

## Use

```sh
./green build              # render .colors/<profile>/ — contacts nothing
./green create --dry-run   # walk the workflow, skip every side effect
./green create             # converge for real
./green delete             # guarded; see below
```

`build` and `--dry-run` work on a fresh checkout with an empty environment,
which makes them the safe way to check a `colors.yml` edit. Exit code 2 means
validation failure and lists every problem at once.

## Configuration

`colors.yml` is the only file you edit; see
`skills/package-neon-green/references/configuration.md` for every key.
Credentials are `COLORS_PAR_*` environment variables in a gitignored
`.envrc.private`:

| Variable | For |
|---|---|
| `COLORS_PAR_VULTR_API_KEY` | compute |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | OpenTofu state (operator machine only) |
| `COLORS_PAR_NEON_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | Neon remote storage — the one pair that reaches the host; prefer a bucket-scoped token |

There is no DNS credential because there is no DNS: nothing in this package
is reachable by name. The database role passwords are generated on the
server during convergence and are never operator-supplied.

Never export `COLORS_PAR_PROFILE`: the profile keys remote state, and
overlaying it points one deployment at another's.

## After a create

```sh
ssh -L 55433:127.0.0.1:55433 <profile>          # the alias the package wrote
psql 'postgresql://neon@127.0.0.1:55433/neondb' # password: see below
```

- `ssh <profile> cat /etc/neon/secrets/neon_role_password` — the
  application role's generated password.
- `ssh <profile> neon-status` — containers, tenant/timeline state, and how
  to connect.
- `ssh <profile> neon-rotate` — rotate the role password atomically, with
  rollback; the old password provably stops working before the new one is
  recorded.

Acceptance already proved, on the server: the SQL round-trip, a wrong
password refused, a passwordless connection refused, privilege escalation
refused, pageserver objects in R2, and a WAL segment offloaded after
`pg_switch_wal()` — and from the workstation: the tunnel path itself.

## Durability, honestly

The pageserver uploads layers and the safekeeper offloads closed WAL
segments to R2 under `<profile>/data/`, so the data survives the host. But
commit acknowledgement requires the host's disk, and WAL offload is
asynchronous: losing the host can lose the tail of acknowledged WAL since
the last offloaded segment. That is the single-node RPO. This is a demo-tier
deployment and says so; it is not a substitute for a replicated cluster.

Never configure R2 lifecycle rules on the bucket — they would delete live
layers and WAL that Neon still references.

## Recovery

The guarded `delete` leaves the R2 data in place. A subsequent `create`
builds a fresh host, finds this profile's ready marker, re-attaches the
tenant at the next generation, and the pageserver rebuilds local state from
R2; the smoke gates then require the data to be readable. The ownership
markers refuse a foreign or half-initialized prefix instead of attaching it;
the repair for a known-stale prefix is deliberate and manual — delete
`<profile>/data/` in R2 yourself and re-run.

## Delete

`delete` is protected by `compute-prevent-destroy: true`. Lift it for one
run with `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false ./green delete`; never
edit the committed flag. The `~/.ssh/config` block is removed before the
destroy, the machine keypair after it, and the R2 data not at all.

## Development

```sh
cd green && bb test && bb golden
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh
./scripts/launcher.sh
```

Green is canonical; a behavioural change lands in all three colours in the
same commit and passes parity. See `CLAUDE.md` for the traps this package
has already paid for (the recreate-only compute container, the uid-1000
pageserver, the missing testing APIs, the verifier-file determinism).
