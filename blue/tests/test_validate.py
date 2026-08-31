from conftest import fixture, optout
from package_neon_blue import validate


def test_fixture_is_valid():
    assert validate.state_errors(fixture()) == []


def test_optout_fixture_is_valid():
    assert validate.state_errors(optout()) == []


def test_machine_key_is_not_required():
    # The standard makes absence meaningful: requiring vultr-ssh-keys would
    # make every conforming deployment invalid.
    assert not any("vultr-ssh-keys" in e for e in validate.state_errors(fixture()))


def test_absent_machine_key_selects_keygen():
    assert validate.keygen(fixture()) is True
    assert validate.keygen(optout()) is False


def test_the_machine_is_named_after_the_profile():
    # Compute Name Standard: no name key required, the profile is the name,
    # and the optional override wins only when it is genuinely present.
    assert validate.compute_name(fixture()) == "neon-fixture"
    assert validate.compute_name(fixture({"vultr-name": "REPLACE_ME"})) == "neon-fixture"
    assert validate.compute_name(fixture({"vultr-name": "custom"})) == "custom"


def test_reports_all_errors():
    errors = validate.state_errors(fixture({
        "neon-image": "neondatabase/neon:latest",
        "provider-compute": "digitalocean",
        "neon-pg-version": 13,
        "neon-tenant-id": "xyz",
        "neon-role": "Not-An-Identifier",
        "neon-r2-endpoint": "ftp://example",
        "vultr-os-id": "2284"}))
    assert len(errors) >= 6
    for part in ["digest", "vultr", "pg-version", "tenant-id", "role",
                 "endpoint", "os-id"]:
        assert any(part in e for e in errors), part


def test_accepts_a_digest_pin():
    assert validate.state_errors(fixture(
        {"neon-image":
         "ghcr.io/neondatabase/neon:release-9129@sha256:" + "a" * 64})) == []


def test_the_images_may_not_float():
    # Upstream publishes floating tags and the two release trains move
    # independently, so nothing can check the pair is compatible. What can be
    # checked is that neither moves on its own between converges: the digest
    # is required.
    for k in ["neon-image", "neon-compute-image"]:
        errors = validate.state_errors(fixture({k: "neondatabase/neon:release-9129"}))
        assert any("digest" in e for e in errors), k


def test_the_application_role_may_not_be_cloud_admin():
    # cloud_admin is the superuser compute_ctl itself connects as; naming it
    # would collide with the generated credential.
    errors = validate.state_errors(fixture({"neon-role": "cloud_admin"}))
    assert any("cloud_admin" in e for e in errors)


def test_tenant_and_timeline_are_32_hex():
    for k in ["neon-tenant-id", "neon-timeline-id"]:
        errors = validate.state_errors(fixture({k: "UPPERCASE-and-short"}))
        assert any("hex" in e for e in errors), k
        assert validate.state_errors(fixture({k: "b" * 32})) == []


def test_profile_overlay_is_refused():
    assert validate.env_errors({"COLORS_PAR_PROFILE": "other"})
    assert not validate.env_errors({})


def test_a_create_names_every_package_secret():
    errors = "\n".join(validate.secret_errors(fixture(), "create"))
    for name in ["COLORS_PAR_VULTR_API_KEY",
                 "COLORS_PAR_NEON_R2_ACCESS_KEY_ID",
                 "COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY"]:
        assert name in errors, name
    # The database role passwords are generated on the server and never
    # supplied by the operator; there is likewise no DNS provider to
    # credential.
    assert "PASSWORD" not in errors
    assert "CLOUDFLARE" not in errors


def test_a_delete_asks_only_for_the_providers():
    # Destroying a machine must not require the credentials needed to converge
    # one; the R2 data pair should not be a lock on the exit.
    errors = "\n".join(validate.secret_errors(fixture(), "delete"))
    assert "COLORS_PAR_VULTR_API_KEY" in errors
    assert "COLORS_PAR_NEON_R2_ACCESS_KEY_ID" not in errors
