from conftest import fixture, optout
from package_neon_blue import tools


def spec_for(opts, file):
    return next(s for s in tools.ansible_specs(opts)
                if str(s["target"]).endswith(file))


def test_firewall_sources_parse():
    data = tools.infrastructure_data(fixture())
    assert tools.cidrs(data, "vultr-ssh-sources") == ["0.0.0.0/0", "::/0"]


def test_infrastructure_data_carries_the_ssh_mode():
    assert tools.infrastructure_data(fixture())["ssh-keygen"] is True
    assert tools.infrastructure_data(optout())["ssh-keygen"] is False


def test_infrastructure_data_resolves_the_compute_name():
    # Compute Name Standard §3: every label derives from the one resolved name.
    assert tools.infrastructure_data(fixture())["compute-name"] == "neon-fixture"


def test_the_r2_prefix_is_namespaced_by_profile():
    # Two deployments sharing a bucket must never share a prefix: the profile
    # is the namespace, and the tofu state at <profile>/<stage>.tfstate is a
    # sibling key space that never collides with <profile>/data/.
    assert tools.r2_prefix(fixture()) == "neon-fixture/data"


def test_inventory_keeps_one_target():
    inventory = tools.inventory({**fixture(), "ip": "192.0.2.10"})
    assert "192.0.2.10" in inventory
    assert "neon-fixture" in inventory


def test_ansible_renders_the_whole_stack():
    targets = [str(s["target"]) for s in tools.ansible_specs(fixture())]
    for file in ["ansible.cfg", "main.yml", "cleanup.yml", "compose.yml",
                 "pageserver.toml", "identity.toml", "config.json", "scramgen.py",
                 "bootstrap.sh", "smoke.sh", "status.sh", "rotate.sh",
                 "inventory.json"]:
        assert any(t.endswith(file) for t in targets), file


def test_operator_secrets_reach_the_host_as_lookups_not_values():
    # `.colors/` is generated output and the goldens are committed, so the
    # secret must never be the thing that lands on disk — the expression is.
    # The lookups live literally in the template rather than in the data map,
    # because the template engine HTML-escapes a value it interpolates and
    # Ansible would receive `&#39;` instead of a quote.
    template = (tools.ROOT / "tools" / "ansible" / "main.yml").read_text()
    for par in ["COLORS_PAR_NEON_R2_ACCESS_KEY_ID",
                "COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY"]:
        assert f"lookup('env','{par}')" in template, par


def test_the_spec_template_carries_verifier_placeholders_not_values():
    # The role verifiers are generated on the host and injected there; the
    # rendered spec in .colors/ must carry only the placeholders.
    template = (tools.ROOT / "tools" / "ansible" / "config.json").read_text()
    for placeholder in ["@CLOUD_ADMIN_VERIFIER@", "@NEON_ROLE_VERIFIER@",
                        "@JWKS_KID@", "@JWKS_X@"]:
        assert placeholder in template, placeholder


def test_the_data_map_carries_no_operator_secret():
    data = spec_for(fixture(), "main.yml")["data"]
    assert data["neon-r2-prefix"] == "neon-fixture/data"
    for k in ["neon-r2-access-key-id", "neon-r2-secret-access-key"]:
        assert data.get(k) is None, k


async def test_a_delete_without_compute_skips_the_host_entirely():
    # There is no machine to stop, and the cleanup play would only fail
    # against the placeholder address.
    result = await tools.ansible_step({**fixture(), "blue/event": "delete"})
    assert result["blue/exit"] == 0


async def test_acceptance_is_skipped_outside_a_real_create():
    for event in ["build", "delete"]:
        result = await tools.acceptance_step({**fixture(), "blue/event": event})
        assert result["blue/exit"] == 0
