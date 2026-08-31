"""The steps and every template spec, the port of io.github.getcolors.neon.tools."""

from __future__ import annotations

import json
import random
from pathlib import Path
import re

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec

from . import ssh_config, validate

infrastructure_tool = "neon-infrastructure"
ansible_tool = "neon-ansible"
ansible_local_tool = "neon-ansible-local"
ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="neon")


def template(path: str, file: str) -> dict:
    name = f"tools/{path}/{file}"
    return {"name": name, "content": (ROOT / name).read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


def cidrs(opts: dict, key: str) -> list[str]:
    value = opts.get(key)
    xs = value if isinstance(value, list) else re.split(
        r"[,\s]+", "" if value is None else str(value))
    return [s for s in (str(x).strip() for x in xs) if s]


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    merged: dict[str, str] = {}
    for slot in [*slots, "provider-backend"]:
        merged.update(validate.tofu_env(opts, slot))
    result = {}
    for key, env_var in merged.items():
        value = "" if opts.get(key) is None else str(opts.get(key))
        if value:
            result[env_var] = value
    return result or None


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


def fallback_params(opts: dict) -> dict:
    return {"ip": "192.0.2.10", "user": "root", "sudoer": "root",
            "name": validate.compute_name(opts)}


def output_params(result: dict) -> dict | None:
    return (result.get("tofu/outputs") or {}).get("params")


def r2_prefix(opts: dict) -> str:
    """The Neon data prefix inside the R2 bucket. Everything the pageserver
    and safekeeper write — and the ownership markers guarding adoption — lives
    under `<profile>/data/`. The tofu state for the same deployment lives at
    `<profile>/<stage>.tfstate` in the same bucket, a sibling key space that
    never collides with this one."""
    return f"{opts.get('profile')}/data"


# ---------------------------------------------------------------- compute


def infrastructure_data(opts: dict) -> dict:
    return {**opts,
            "compute-name": validate.compute_name(opts),
            "ssh-keygen": validate.keygen(opts),
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, "vultr-ssh-sources"))}


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    specs = [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf",
                  infrastructure_data(opts))]
    result = await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-compute"))
    if (result.get("blue/exit") or 0) > 0:
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_params(opts)}
    if opts.get("blue/event") == "delete":
        return result
    return {**result, **fallback_params(opts), **(output_params(result) or {})}


# ---------------------------------------------------------- ansible (local)


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. The address, the user and the alias
    are run-time facts and reach the play as extra-vars instead, so the
    rendered playbook carries no IP and is identical on every workstation (SSH
    Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    return [spec(template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves both
    events; `block_state` is what distinguishes them."""
    dir = tool_dir(opts, ansible_local_tool)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=dir, inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ip": opts.get("ip") or fallback_params(opts)["ip"],
                    "user": opts.get("user") or "root",
                    "block_state": "absent" if delete else "present"})


# ---------------------------------------------------------------- ansible


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    return json.dumps(value)


def inventory(opts: dict) -> str:
    return _pretty(
        {"all": {"children": {"neon": {"hosts": {
            opts.get("profile"): {"ansible_host": opts.get("ip") or "192.0.2.10",
                                  "ansible_user": "root"}}}}}})


def ansible_data(opts: dict) -> dict:
    """Template values for the Ansible stage.

    Deliberately carries neither operator secret. The R2 pair reaches the
    host as Ansible `lookup('env', ...)` expressions written literally into
    main.yml, where `preserve-jinja-delimiters` passes them through untouched —
    routing them through this map instead would let the template engine
    HTML-escape the quotes and hand Ansible `&#39;`. The secret therefore
    exists only in the process that needs it: not in `.colors/`, not in a
    golden, not in this map."""
    return {**opts,
            "ip": opts.get("ip") or "192.0.2.10",
            "ssh-keygen": validate.keygen(opts),
            "neon-r2-prefix": r2_prefix(opts)}


ANSIBLE_FILES = [
    "ansible.cfg", "main.yml", "cleanup.yml", "compose.yml",
    "pageserver.toml", "identity.toml", "config.json", "scramgen.py",
    "bootstrap.sh", "smoke.sh", "status.sh", "rotate.sh",
]


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = ansible_data(opts)
    return [*[spec(template("ansible", name), f"{dir}/{name}", data)
              for name in ANSIBLE_FILES],
            raw_spec(f"{dir}/inventory.json", inventory(data))]


async def ansible_step(opts: dict) -> dict:
    dir = tool_dir(opts, ansible_tool)
    if opts.get("blue/event") == "delete" and not opts.get("ip"):
        # No compute in state: there is no host to stop, and the cleanup play
        # would only fail against the placeholder address.
        return {**opts, "blue/exit": 0}
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        dir=dir, inventory="inventory.json",
        playbooks={"create": "main.yml", "delete": "cleanup.yml"},
        host_key_checking=False)


# ------------------------------------------------------------- acceptance


async def run_quiet(args: list[str], env: dict[str, str], timeout_ms: int):
    """Run `args` with `env` overlaid, returning the result. Nothing from the
    child is echoed; callers decide what becomes an error message, so a secret
    passed through `env` can never leak into output by default."""
    return await runtime.exec(args, env=env, timeout_ms=timeout_ms)


def psql_args(opts: dict, port: int, sql: str) -> list[str]:
    """A psql invocation with an explicit everything: host, port, role,
    database, and `-w` so a missing password fails instead of prompting. The
    environment is what run_quiet passes, so no ambient PG* variable or
    ~/.pgpass can leak into the probe."""
    return ["psql",
            (f"postgresql://{opts.get('neon-role')}@127.0.0.1:{port}"
             f"/{opts.get('neon-database')}?connect_timeout=10"),
            "-w", "-v", "ON_ERROR_STOP=1", "-tAc", sql]


def tunnel_args(opts: dict, port: int) -> list[str]:
    """An ssh tunnel through the generated `~/.ssh/config` alias — the
    supported client path, exercised end to end: the alias, the identity file,
    and the forward. `-f` returns once the forward is up; the remote `sleep`
    bounds its lifetime so nothing needs killing on the way out. The bash
    wrapper exists for the streams: the daemonized child inherits
    stdout/stderr, and a runner that waits for the pipes to close would
    otherwise block until the sleep expires — returning exactly when the
    tunnel dies."""
    return ["bash", "-c",
            "ssh -f -o ExitOnForwardFailure=yes -o BatchMode=yes"
            f" -L {port}:127.0.0.1:55433 "
            f"{ssh_config.host_alias(opts)} sleep 45 >/dev/null 2>&1"]


# One deployment-scoped row, updated deterministically: the same statement on
# every converge, so a second create reconciles instead of accumulating.
SMOKE_SQL = (
    "INSERT INTO colors_smoke (id, note, at) VALUES (1, 'operator-path', now())"
    " ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at;"
    " SELECT count(*) FROM colors_smoke;")


async def read_remote_password(opts: dict) -> str | None:
    """The generated application-role password, read over SSH and held only in
    this process. Never merged into opts, never printed."""
    result = await run_quiet(
        ["ssh", "-o", "BatchMode=yes", ssh_config.host_alias(opts),
         "cat", "/etc/neon/secrets/neon_role_password"], {}, 20000)
    if result.exit != 0:
        return None
    password = str(result.out or "").strip()
    return password or None


async def acceptance_step(opts: dict) -> dict:
    """The operator-path gate, after a real create.

    The server-side gates already ran inside the playbook (health, the SQL
    round-trip, the auth negatives, the R2 object listings). What is checked
    from here is the one thing only this side can check: that an operator on
    this workstation reaches the database through the generated SSH config and
    a tunnel — the supported client path — with the generated password, and
    not without it."""
    if opts.get("blue/event") != "create":
        return {**opts, "blue/exit": 0}
    password = await read_remote_password(opts)
    if not password:
        return {**opts, "blue/exit": 1,
                "blue/err": "acceptance: could not read the generated role password over ssh"}
    for _attempt in range(3):
        port = 20000 + random.randrange(40000)
        tunnel = await run_quiet(tunnel_args(opts, port), {}, 30000)
        if tunnel.exit != 0:
            continue
        ok = await run_quiet(psql_args(opts, port, SMOKE_SQL),
                             {"PGPASSWORD": password}, 30000)
        denied = await run_quiet(psql_args(opts, port, "SELECT 1;"),
                                 {"PGPASSWORD": "not-the-password"}, 30000)
        if ok.exit != 0:
            return {**opts, "blue/exit": 1,
                    "blue/err": ("acceptance: the tunnelled smoke round-trip failed: "
                                 + str(ok.err or "").strip())}
        # psql prints the INSERT command tag before the count; the count is
        # the last line.
        if str(ok.out or "").strip().splitlines()[-1:] != ["1"]:
            return {**opts, "blue/exit": 1,
                    "blue/err": ("acceptance: colors_smoke should hold exactly one row, got "
                                 + str(ok.out or "").strip())}
        if denied.exit == 0:
            return {**opts, "blue/exit": 1,
                    "blue/err": "acceptance: a wrong password was accepted through the tunnel"}
        return {**opts, "blue/exit": 0,
                "neon/acceptance": {"tunnel": "ok", "smoke-rows": "1",
                                    "wrong-password": "refused"}}
    return {**opts, "blue/exit": 1,
            "blue/err": "acceptance: no local port could carry the ssh tunnel after three attempts"}
