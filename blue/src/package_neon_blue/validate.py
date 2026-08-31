"""Validation over desired state, the port of io.github.getcolors.neon.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from package_once_blue import ssh as once_ssh
from package_once_blue.validate import providers as once_providers

profile_par = par_name("profile")

# Every key desired state must carry.
#
# Two deliberate absences. `vultr-ssh-keys` selects opt-out mode by being
# present (SSH Keypair Standard), so requiring it would make every conforming
# keygen deployment invalid. `vultr-name` is the Compute Name Standard's
# optional override: a fresh colors.yml that omits it is complete and names
# the machine after the profile. There is likewise no `provider-dns`: nothing
# in this package is reachable by name — the firewall opens 22 only and the
# client path is an SSH tunnel — so a DNS provider would be a key with
# nothing to configure.
required = [
    "profile", "workdir", "provider-compute", "provider-backend",
    "compute-prevent-destroy",
    "neon-image", "neon-compute-image", "neon-pg-version",
    "neon-tenant-id", "neon-timeline-id",
    "neon-database", "neon-role",
    "neon-r2-bucket", "neon-r2-endpoint", "neon-r2-region",
    "vultr-region", "vultr-plan", "vultr-os-id",
    "vultr-ssh-sources",
    "r2-bucket", "r2-endpoint",
]

image_keys = ["neon-image", "neon-compute-image"]

# `tag@sha256:...` — the shape both image keys actually carry — pins both the
# human-readable release and the exact bytes. Upstream also publishes floating
# tags, which is why the digest is required rather than the suffix denied.
image_re = re.compile(r"[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})")
hex32_re = re.compile(r"[0-9a-f]{32}")
ident_re = re.compile(r"[a-z_][a-z0-9_]*")
url_re = re.compile(r"https://[^\s]+")


def _s(value) -> str:
    """Clojure's `str`: nil renders empty, booleans lowercase."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def missing(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def placeholder(value) -> bool:
    """Whether the compute-name override is effectively absent (Compute Name
    Standard §2: presence is the only switch)."""
    return missing(value) or _s(value).strip() == "REPLACE_ME"


def compute_name(opts: dict) -> str:
    """What this deployment calls its machine. The one function that answers
    it — every label, including the firewall's, derives from this and never
    from the raw override key or a second copy of the profile (§3)."""
    override = opts.get("vultr-name")
    return _s(opts.get("profile")) if placeholder(override) else _s(override).strip()


def keygen(opts: dict) -> bool:
    """Whether this deployment owns its machine keypair. Delegates to ONCE, the
    standard's reference implementation, so one rule decides it everywhere."""
    return once_ssh.keygen(opts)


def env_errors(env: dict) -> list[str]:
    if _s(env.get(profile_par)):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


def state_errors(opts: dict) -> list[str]:
    errors: list[str] = []
    errors += [f":{k} is required" for k in required if missing(opts.get(k))]
    if opts.get("provider-compute") != "vultr":
        errors.append(":provider-compute must be vultr")
    if opts.get("provider-backend") not in ("local", "s3", "r2"):
        errors.append(":provider-backend must be local, s3, or r2")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")
    for k in image_keys:
        v = opts.get(k)
        if not missing(v) and not image_re.fullmatch(_s(v)):
            errors.append(f":{k} must carry an explicit image tag or digest")
    # Upstream also publishes floating tags, and the two release trains move
    # independently, so the one thing that can be checked is that neither
    # floats: a digest is required, not merely a tag.
    for k in image_keys:
        v = _s(opts.get(k))
        if not missing(opts.get(k)) and "@sha256:" not in v:
            errors.append(f":{k} must be pinned by digest (tag@sha256:...)")
    pg_version = opts.get("neon-pg-version")
    if not (missing(pg_version)
            or (isinstance(pg_version, int) and not isinstance(pg_version, bool)
                and pg_version in (14, 15, 16, 17))):
        errors.append(":neon-pg-version must be 14, 15, 16, or 17")
    # Tenant and timeline identities are desired state: fixing them is what
    # makes convergence reconcilable and recovery describable. Pageserver ids
    # are 16-byte hex strings.
    for k in ["neon-tenant-id", "neon-timeline-id"]:
        v = opts.get(k)
        if not missing(v) and not hex32_re.fullmatch(_s(v)):
            errors.append(f":{k} must be 32 lowercase hex characters")
    for k in ["neon-database", "neon-role"]:
        v = opts.get(k)
        if not missing(v) and not ident_re.fullmatch(_s(v)):
            errors.append(f":{k} must be a lowercase identifier")
    # cloud_admin is the superuser compute_ctl itself connects as; a desired
    # state that names it would collide with the generated credential.
    if _s(opts.get("neon-role")) == "cloud_admin":
        errors.append(":neon-role must not be cloud_admin")
    if not (missing(opts.get("neon-r2-endpoint"))
            or url_re.fullmatch(_s(opts.get("neon-r2-endpoint")))):
        errors.append(":neon-r2-endpoint must be an https URL")
    os_id = opts.get("vultr-os-id")
    if not (missing(os_id) or (isinstance(os_id, int) and not isinstance(os_id, bool))):
        errors.append(":vultr-os-id must be Vultr's numeric operating-system id")
    return errors


def backend_secrets(opts: dict) -> list[str]:
    entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
    return entry.get("secrets", [])


# What talking to the provider needs, on any real event.
provider_secrets = ["vultr-api-key"]

# What converging the machine needs, and therefore only a create: the R2 pair
# the pageserver and safekeeper write remote storage with. The database role
# passwords are deliberately absent — they are generated on the server, once,
# and are never supplied by the operator.
application_secrets = [
    "neon-r2-access-key-id",
    "neon-r2-secret-access-key",
]


def secret_errors(opts: dict, event: str) -> list[str]:
    """Credentials a real event needs. A delete tears down infrastructure and
    never converges anything, so it asks for the provider credentials only."""
    keys = [*provider_secrets,
            *(application_secrets if event == "create" else []),
            *backend_secrets(opts)]
    return [f"required credential is not set: {par_name(k)}"
            for k in dict.fromkeys(keys) if missing(opts.get(k))]


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return {"vultr-api-key": "VULTR_API_KEY"}
    if slot == "provider-backend":
        entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
        return entry.get("tofu-env", {})
    return {}
