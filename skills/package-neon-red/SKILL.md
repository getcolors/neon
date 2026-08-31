---
name: package-neon-red
description: Provision and manage self-hosted Neon serverless Postgres on one Vultr instance — the storage broker, the pageserver, a safekeeper, and a compute node, with Cloudflare R2 as the remote storage for layers and WAL — using OpenTofu and Ansible. Use when asked to deploy, converge, inspect or tear down self-hosted Neon, to run storage/compute-separated Postgres with S3-durable data, or to work on a colors.yml for a neon deployment.
---

# Neon Package Skill (Red)

Provisions one Vultr instance running the Neon storage tier (storage broker,
pageserver, one safekeeper) and a Postgres compute node, with pageserver
layers and safekeeper WAL uploaded to Cloudflare R2 under the deployment's
own prefix, and OpenTofu state in R2.

## Install the launcher

```sh
npx skills add getcolors/neon
cp .agents/skills/package-neon-red/red ./red
chmod +x red
```

The root `red` is a **copy** of the payload, not a symlink. `npx skills
update -p` rewrites the payload and leaves the copy alone, so copy it again
after every update or the project keeps running the old pin.

## Verbs

```sh
./red build              # render .colors/<profile>/ — no provider calls, no credentials
./red create --dry-run   # walk the workflow, skip every side effect
./red create             # converge for real
./red delete             # guarded and destructive
```

`build` and `--dry-run` are the safe way to check a `colors.yml` edit: they
work on a fresh checkout with an empty environment. Exit code 2 is a validation
or usage failure and lists every problem at once. The launcher walks up from
the working directory to find `colors.yml`, so any subdirectory works.

## Rules that are not negotiable

- **`colors.yml` is the only file you edit.** Kebab-case keys, non-secret
  values only.
- **Credentials are `COLORS_PAR_*` environment variables** in a gitignored
  `.envrc.private`. Never in `colors.yml`, generated output, or documentation.
- **Never export `COLORS_PAR_PROFILE`.** The profile keys remote state; the
  package refuses to run when it is set, and that refusal is the guard working.
- **`.colors/` is generated output.** Never edit it, never read it as source,
  never commit it.
- **`delete` is guarded** by `compute-prevent-destroy: true`, liftable only
  with `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` for one run. Never edit the
  committed flag. Never run a real `create` or `delete` against a live
  deployment without explicit authorization.

## What it builds

| Stage | What it manages |
|---|---|
| `neon-infrastructure` | one Vultr instance, a firewall opening 22 only, and in keygen mode the account SSH key named after the profile |
| `neon-ssh-config` | the `~/.ssh/config` block, so `ssh <profile>` works |
| `neon-ansible` | Docker Compose: the storage broker, the pageserver, one safekeeper, and the compute node — plus tenant/timeline reconciliation and the server-side acceptance gates |
| acceptance | the operator path: an SSH tunnel through the generated alias, a psql round-trip with the generated password, and a refused wrong password |

## Connecting

Nothing is published beyond loopback; there is no DNS record and no public
5432. The supported client path is the tunnel:

```sh
ssh -L 55433:127.0.0.1:55433 <profile>
psql 'postgresql://<neon-role>@127.0.0.1:55433/<neon-database>'
```

The role's password is generated on the server:
`ssh <profile> cat /etc/neon/secrets/neon_role_password`. `neon-status` on
the host summarizes container, tenant and timeline state; `neon-rotate`
rotates the role password atomically, with rollback.

## Durability, honestly

The pageserver uploads layers and the safekeeper offloads closed WAL segments
to R2 under `<profile>/data/`. Commit acknowledgement still requires the
host's disk, uploads are asynchronous, and a fresh safekeeper cannot serve
offloaded WAL back — so a full host loss recovers what the pageserver had
uploaded: the single-node RPO is the activity since its last checkpoint
upload. A wiped storage tier on a surviving host loses nothing (rehearsed).
This is a demo-tier deployment and says so. Never configure R2 lifecycle
rules on the bucket: they would delete live layers and WAL.

## Reference

`references/configuration.md` documents every `colors.yml` key, every
credential, and the recovery procedure.
