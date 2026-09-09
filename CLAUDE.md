# CLAUDE.md

## Repository

`neon` is a tri-colour Package Skill (green, red, blue) for self-hosted Neon —
serverless Postgres with storage/compute separation — on one Vultr instance.
`colors-compute` owns VM, firewall, SSH keypair, and remote-state lifecycle. The package requests **22 only** and Ansible
converges a Docker Compose stack of the storage broker, the pageserver, one
safekeeper, and a compute node running Postgres under `compute_ctl`, with
Cloudflare R2 as the remote storage for pageserver layers and safekeeper WAL.
The first consumer is `../neon-vultr`.

There is no DNS provider and no public database port: every Neon service
binds to loopback on the host and the supported client path is an SSH tunnel
(`ssh -L 55433:127.0.0.1:55433 <profile>`). That is why validation has no
`provider-dns`, the workflow has no dns stage, and a real create demands no
Cloudflare token.

## Why this package owns its Compose templates

Upstream's `docker-compose/` is a development fixture: MinIO for storage,
three colocated safekeepers, trust auth, floating `latest` tags, and a
committed JWKS keypair. This package derives its templates from the
`release-9129` tree and maintains them as its own, with the image pins lifted
into desired state. The cost is deliberate: when upstream changes the compose
shape, nothing here follows automatically — re-read `docker-compose/` *at the
pinned tag, not main* (a year of drift separates them) when bumping
`neon-image` or `neon-compute-image`. Upstream cut its last versioned
releases in July 2025 and then moved to untagged continuous deployment;
`release-9129` (storage) + `release-compute-9073` (compute) are the final
deliberate release pairing, and the two trains version independently — which
is why validation requires digests rather than trusting tags.

## The identity model

The tenant id, timeline id, database, and role live in `colors.yml`: the R2
prefix plus those ids *are* the database, and fixing them is what makes
convergence reconcilable (read-before-write, conflict-tolerant, postcondition
reads) and recovery describable. The R2 prefix `<profile>/data/` is guarded
by two-phase ownership markers — `.colors-init` before any data can exist,
`.colors-ready` only after the smoke gates pass — so a foreign or
half-initialized prefix fails the converge instead of being attached. A
`.colors-generation` counter keeps re-attach generations monotonic across
host rebuilds; regenerating it would break the next re-attach.

## What fails silently here, and the traps already paid for

- **The compute container is recreate-only.** Postgres writes its lock under
  the container's `/tmp`; a stop/start keeps the writable layer, and the
  stale `.s.PGSQL.55433.lock` then crash-loops every subsequent boot. The
  compose mounts a tmpfs on `/tmp` so unattended restarts survive, and the
  converge handler uses `--force-recreate` — which is also how a spec change
  (and `neon-rotate`) takes effect, because compute_ctl applies roles at
  startup only.
- **No volume on the compute pgdata path.** compute_ctl insists on creating
  pgdata itself; a root-owned mountpoint there fails the boot with `File
  exists (os error 17)`. Compute local state is a disposable projection of
  the storage tier, on purpose.
- **The pageserver runs as uid 1000** and must own its bind-mounted data
  directory or it dies with `Failed to create tenants root dir … Permission
  denied`.
- **The release images have no testing APIs**: the `/v1/.../checkpoint`
  endpoint answers "compiled without testing APIs". Upload evidence comes
  from `pg_switch_wal()` plus R2 object listings, never from that endpoint.
- **Exit codes are not evidence.** `neon-smoke` asks the system what it has:
  the SQL round-trip, a wrong password refused, a passwordless connection
  refused, a privilege escalation refused, pageserver objects listed in R2,
  and a WAL segment offloaded after `pg_switch_wal()`. Only then does the
  ready marker land. The launcher-side acceptance then proves the operator
  path — the tunnel through the generated `~/.ssh/config` alias — from the
  workstation, which the playbook cannot do.

## The SSH keypair and `~/.ssh/config`

This package is born conforming to three workspace standards. Read
`../workspace/standards/ssh-keypair.md` before touching `ssh.clj` (or its
red/blue counterparts), `../workspace/standards/ssh-config.md` before
touching `ssh_config.clj`, and `../workspace/standards/compute-name.md` for
why there is no required `vultr-name` (the machine is named after the
profile; the key is only the optional override).

The keypair and its registration are owned by `colors-compute`. The package owns the locked `~/.ssh/config` updater. It removes the profile alias before compute deletion; library cleanup removes managed keys only after cloud destruction succeeds. External private paths are passed explicitly to Ansible and acceptance SSH; external mode never adds IdentityFile to the managed alias.

Build and dry-run render deterministic library plans and never inspect local SSH files. Both keygen and external-key fixtures remain covered by parity and goldens.

## Secrets

One operator credential pair reaches the host: `COLORS_PAR_NEON_R2_*`, as
literal `{{ lookup('env', ...) }}` expressions in `main.yml`, which
`preserve-jinja-delimiters` passes through untouched — routing them through
the Selmer data map would HTML-escape the quotes and hand Ansible `&#39;`.
`scripts/golden.sh` fails if those expressions stop appearing.

Everything else is generated on the host, create-once, and exists nowhere
else: the `cloud_admin` and application-role passwords, their SCRAM verifiers
(the verifier files are what make the rendered compute spec deterministic
across converges — `scramgen.py` salts randomly, so regenerating them would
recreate compute every run), and the compute JWKS keypair. The spec template
carries `@..._VERIFIER@` placeholders; the values are injected on the host
into `/etc/neon/config.json` (0600) via tmpfile+rename. `neon-rotate` rotates
the role password atomically and updates the stored verifier so the next
converge does not silently un-rotate.

## Commands

The three implementations live in the tri-colour layout, matching `signoz`
and `clickstack`: canonical Clojure in `green/`, TypeScript/Bun in `red/`,
Python/uv in `blue/`. Green is canonical: a behavioural change lands in all
three colours in the same commit and passes `scripts/parity.sh`, which
renders both fixtures through every colour and diffs the trees — and the
colour template trees (`red/resources`, blue's embedded `resources/`) — byte
for byte. Fixtures and goldens are shared at the repository root
(`test/fixtures/`, `test/resources/golden/`) with symlinks from
`green/test/`. Each colour dir holds a launcher symlink to its skill payload.

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, two fixtures, byte for byte
./scripts/launcher.sh          # from the repository root
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create     # requires explicit authorization
cd green && ./green delete     # guarded and destructive
```

Never read `.envrc.private`, edit `.colors/`, export `COLORS_PAR_PROFILE`, or
weaken `compute-prevent-destroy`. Build and dry-run are credential-free and
must not touch `~/.ssh`.

## Coupling

The package pins Green and ONCE in `green/deps.edn`, the Red SDK and
`package-once-red` in `red/package.json`, and the Blue SDK and
`package-once-blue` in `blue/pyproject.toml`. All three colours pin ONCE at
the **same rev**; the ONCE pin can never go below `bc06f2f`, the commit that
moved the machine keypair into the operator's `~/.ssh`. Use `GREEN_LIB_ROOT`,
`ONCE_LIB_ROOT`, and `NEON_LIB_ROOT` for working-tree development
(`NEON_LIB_ROOT` names the repository root for every colour; red also accepts
the `red/` dir directly). Final launchers use a pushed SHA managed by
`bb pin`, which stamps all three payloads from their unpinned birth forms;
deployment launchers are copies, not symlinks.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.

When used as an application-template dependency, the Red facade accepts the consumer's `colors-compute-red` peer. The native development manifest and standalone launcher pin the tested library revision. This avoids duplicate Git dependency resolution while letting consumers upgrade the compute library independently of Neon templates.

Blue declares a normal library requirement when consumed; its development group and standalone launcher carry the immutable tested library pin. Green consumers override the library coordinate through their top-level dependency map.
