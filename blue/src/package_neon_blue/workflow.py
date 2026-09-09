"""The graph, the port of io.github.getcolors.neon.workflow."""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow

from . import compute, ssh_config, tools, validate

DEFAULTS = {"provider-compute": "vultr",
            "provider-backend": "r2", "compute-prevent-destroy": True,
            "workdir": ".colors"}


async def start_step(original: dict, env: dict | None = None) -> dict:
    def after(opts, _env, context):
        current = {**opts, 'blue/exit':0}
        return ssh_config.preflight(current) if context['real'] and context['event']=='create' else current

    return await preflight(
        original, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            lambda o, _e, c: (validate.secret_errors(o, c["event"])
                              if c["real"] and c["event"] in ("create", "delete") else []),
            lambda o, _e, c: ([f"compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false to delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ],
        after_validate=after)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "neon/start": (start_step, "neon/load"),
            "neon/load": (compute.load_step, "neon/ansible"),
            # The `~/.ssh/config` block goes before the destroy, the opposite
            # of the keypair below. A block that outlives its host is stale but
            # harmless; a key that predeceases its host locks the operator out
            # of a machine that still exists. Both orders are deliberate; see
            # standards/ssh-config.md.
            "neon/ansible": (tools.ansible_step, "neon/ssh-config"),
            "neon/ssh-config": (tools.ansible_local_step, "neon/infrastructure"),
            "neon/infrastructure": (tools.infrastructure_step,),
        }.get(step)
    return {
        "neon/start": (start_step, "neon/infrastructure"),
        # After compute, which is where the address first exists, and before
        # the stage that converges the machine — the converge and the
        # acceptance both ride the alias this stage writes.
        "neon/infrastructure": (tools.infrastructure_step, "neon/ssh-config"),
        "neon/ssh-config": (tools.ansible_local_step, "neon/ansible"),
        "neon/ansible": (tools.ansible_step, "neon/acceptance"),
        "neon/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile') or ''}/{tool}.tfstate")


side_effecting = ["neon/infrastructure", "neon/ssh-config",
                  "neon/ansible", "neon/acceptance", "neon/load"]


def create_workflow():
    wf = workflow(start="neon/start", wire_fn=wire_fn)
    return dry_run.advise(progress.advise(wf), side_effecting)


neon_workflow = create_workflow()
