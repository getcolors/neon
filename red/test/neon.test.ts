import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Opts } from "red/workflow";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const optoutFile = join(import.meta.dir, "../../test/fixtures/optout.yml");

function readFixture(path: string, overrides: Opts): Opts {
  const text = readFileSync(path, "utf8").replaceAll("WORKDIR", ".colors");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const optout = (overrides: Opts = {}) => readFixture(optoutFile, overrides);

// ~/.ssh redirection: ONCE's ssh module and this package's ssh-config both
// read $HOME at call time, exactly so tests can point them at a fresh
// temporary home.
let savedHome: string | undefined;
let home: string;
beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "neon-red-test"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// --- desired state -----------------------------------------------------------

describe("validate", () => {
  test("both fixtures are valid", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
    expect(validate.stateErrors(optout())).toEqual([]);
  });

  test("the machine key is not required", () => {
    // The standard makes absence meaningful: requiring vultr-ssh-keys would
    // make every conforming keygen deployment invalid.
    expect(validate.stateErrors(fixture()).some((e) => e.includes("vultr-ssh-keys"))).toBe(false);
  });

  test("absent machine key selects keygen", () => {
    expect(validate.keygen(fixture())).toBe(true);
    expect(validate.keygen(optout())).toBe(false);
  });

  test("the machine is named after the profile", () => {
    // Compute Name Standard: no name key required, the profile is the name,
    // and the optional override wins only when it is genuinely present.
    expect(validate.computeName(fixture())).toBe("neon-fixture");
    expect(validate.computeName(fixture({ "vultr-name": "REPLACE_ME" }))).toBe("neon-fixture");
    expect(validate.computeName(fixture({ "vultr-name": "custom" }))).toBe("custom");
  });

  test("reports all errors at once", () => {
    const errors = validate.stateErrors(fixture({
      "neon-image": "neondatabase/neon:latest",
      "provider-compute": "digitalocean",
      "neon-pg-version": 13,
      "neon-tenant-id": "xyz",
      "neon-role": "Not-An-Identifier",
      "neon-r2-endpoint": "ftp://example",
      "vultr-os-id": "2284",
    }));
    expect(errors.length).toBeGreaterThanOrEqual(6);
    for (const part of ["digest", "digitalocean", "pg-version", "tenant-id", "role",
                        "endpoint"]) {
      expect(errors.some((e) => e.includes(part))).toBe(true);
    }
  });

  test("accepts a digest pin", () => {
    expect(validate.stateErrors(
      fixture({ "neon-image":
        `ghcr.io/neondatabase/neon:release-9129@sha256:${"a".repeat(64)}` }))).toEqual([]);
  });

  test("the images may not float", () => {
    // Upstream publishes floating tags and the two release trains move
    // independently, so nothing can check the pair is compatible. What can be
    // checked is that neither moves on its own between converges: the digest
    // is required.
    for (const key of ["neon-image", "neon-compute-image"]) {
      const errors = validate.stateErrors(fixture({ [key]: "neondatabase/neon:release-9129" }));
      expect(errors.some((e) => e.includes("digest"))).toBe(true);
    }
  });

  test("the application role may not be cloud_admin", () => {
    // cloud_admin is the superuser compute_ctl itself connects as; naming it
    // would collide with the generated credential.
    const errors = validate.stateErrors(fixture({ "neon-role": "cloud_admin" }));
    expect(errors.some((e) => e.includes("cloud_admin"))).toBe(true);
  });

  test("tenant and timeline are 32 hex", () => {
    for (const key of ["neon-tenant-id", "neon-timeline-id"]) {
      expect(validate.stateErrors(fixture({ [key]: "UPPERCASE-and-short" }))
        .some((e) => e.includes("hex"))).toBe(true);
      expect(validate.stateErrors(fixture({ [key]: "b".repeat(32) }))).toEqual([]);
    }
  });

  test("profile overlay is refused", () => {
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "other" }).length).toBe(1);
    expect(validate.envErrors({})).toEqual([]);
  });

  test("a create names every package secret", () => {
    const errors = validate.secretErrors(fixture(), "create").join("\n");
    for (const name of [
                        "COLORS_PAR_NEON_R2_ACCESS_KEY_ID",
                        "COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY"]) {
      expect(errors).toContain(name);
    }
    // The database role passwords are generated on the server and never
    // supplied by the operator; there is likewise no DNS provider to
    // credential.
    expect(errors).not.toContain("PASSWORD");
    expect(errors).not.toContain("CLOUDFLARE");
  });

  test("a delete asks only for the providers", () => {
    // Destroying a machine must not require the credentials needed to converge
    // one; the R2 data pair should not be a lock on the exit.
    const errors = validate.secretErrors(fixture(), "delete").join("\n");
    expect(errors).not.toContain("COLORS_PAR_VULTR_API_KEY");
    expect(errors).not.toContain("COLORS_PAR_NEON_R2_ACCESS_KEY_ID");
  });
});

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("cidrs accept overlay strings", () => {
    expect(tools.cidrs({ x: "10.0.0.0/8, 20.0.0.0/8" }, "x"))
      .toEqual(["10.0.0.0/8", "20.0.0.0/8"]);
  });

  test("the r2 prefix is namespaced by profile", () => {
    // Two deployments sharing a bucket must never share a prefix: the profile
    // is the namespace, and the tofu state at <profile>/<stage>.tfstate is a
    // sibling key space that never collides with <profile>/data/.
    expect(tools.r2Prefix(fixture())).toBe("neon-fixture/data");
  });

  test("the inventory keeps one target", () => {
    const inventory = tools.inventory(fixture({ ip: "192.0.2.10" }));
    expect(inventory).toContain("192.0.2.10");
    expect(inventory).toContain("neon-fixture");
  });

  test("the ansible stage renders the whole stack", () => {
    const targets = tools.ansibleSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["ansible.cfg", "main.yml", "cleanup.yml", "compose.yml",
                        "pageserver.toml", "identity.toml", "config.json", "scramgen.py",
                        "bootstrap.sh", "smoke.sh", "status.sh", "rotate.sh",
                        "inventory.json"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
  });

  test("operator secrets reach the host as lookups, not values", () => {
    // `.colors/` is generated output and the goldens are committed, so the
    // secret must never be the thing that lands on disk — the expression is.
    // The lookups live literally in the template rather than in the data map,
    // because the template engine HTML-escapes a value it interpolates and
    // Ansible would receive `&#39;` instead of a quote.
    const template = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible/main.yml"), "utf8");
    for (const par of ["COLORS_PAR_NEON_R2_ACCESS_KEY_ID",
                       "COLORS_PAR_NEON_R2_SECRET_ACCESS_KEY"]) {
      expect(template).toContain(`lookup('env','${par}')`);
    }
  });

  test("the spec template carries verifier placeholders, not values", () => {
    // The role verifiers are generated on the host and injected there; the
    // rendered spec in .colors/ must carry only the placeholders.
    const template = readFileSync(
      join(import.meta.dir, "../resources/tools/ansible/config.json"), "utf8");
    for (const placeholder of ["@CLOUD_ADMIN_VERIFIER@", "@NEON_ROLE_VERIFIER@",
                               "@JWKS_KID@", "@JWKS_X@"]) {
      expect(template).toContain(placeholder);
    }
  });

  test("the data map carries no operator secret", () => {
    const spec = tools.ansibleSpecs(fixture())
      .find((s) => String(s.target).endsWith("main.yml"));
    const data = (spec?.data ?? {}) as Opts;
    expect(data["neon-r2-prefix"]).toBe("neon-fixture/data");
    for (const key of ["neon-r2-access-key-id", "neon-r2-secret-access-key"]) {
      expect(data[key]).toBeUndefined();
    }
  });

  test("a delete without compute skips the host entirely", async () => {
    // There is no machine to stop, and the cleanup play would only fail
    // against the placeholder address.
    const result = await tools.ansibleStep(fixture({ "red/event": "delete" }));
    expect(result["red/exit"]).toBe(0);
  });

  test("acceptance is skipped outside a real create", async () => {
    for (const event of ["build", "delete"]) {
      const result = await tools.acceptanceStep(fixture({ "red/event": event }));
      expect(result["red/exit"]).toBe(0);
    }
  });

  test("tool dirs live under <workdir>/<profile>", () => {
    const opts = { workdir: "/work", profile: "neon-fixture" };
    expect(tools.toolDir(opts, tools.infrastructureTool))
      .toBe("/work/neon-fixture/neon-infrastructure");
    expect(tools.toolDir(opts, tools.ansibleLocalTool))
      .toBe("/work/neon-fixture/neon-ansible-local");
  });

  test("backend advice writes the conventional state address", () => {
    const work = mkdtempSync(join(tmpdir(), "neon-red-backend"));
    try {
      const opts = fixture({ workdir: work, "provider-backend": "r2" });
      workflow.backendAdvice(tools.infrastructureTool)(opts);
      const backend = JSON.parse(readFileSync(
        join(work, "neon-fixture", "neon-infrastructure", "backend.tf.json"), "utf8"));
      const s3 = backend.terraform.backend.s3;
      expect(s3.bucket).toBe("tofu-state-example");
      expect(s3.key).toBe("neon-fixture/neon-infrastructure.tfstate");
      expect(s3.endpoints.s3).toBe("https://example.eu.r2.cloudflarestorage.com");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

// --- ~/.ssh/config (SSH Config Standard) -------------------------------------

describe("ssh-config", () => {
  test("the alias is the profile and the identity file keeps the tilde", () => {
    expect(sshConfig.hostAlias(fixture())).toBe("neon-fixture");
    expect(sshConfig.identityFile(fixture())).toBe("~/.ssh/neon-fixture");
    expect(sshConfig.identityFile(fixture())).not.toContain(home);
  });

  test("the marker is the alias alone", () => {
    expect(sshConfig.beginMarker("neon-vultr")).toBe("# BEGIN neon-vultr ANSIBLE MANAGED BLOCK");
    expect(sshConfig.endMarker("neon-vultr")).toBe("# END neon-vultr ANSIBLE MANAGED BLOCK");
  });

  test("a foreign stanza is found; our own block is not foreign", () => {
    expect(sshConfig.foreignStanzaLine(
      ["Host other", "    HostName 192.0.2.1", "", "Host neon-fixture"],
      "neon-fixture")).toBe(4);
    const alias = "neon-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, "    HostName 192.0.2.1",
       sshConfig.endMarker(alias)], alias)).toBeUndefined();
  });

  test("a stanza after our block is still foreign", () => {
    const alias = "neon-fixture";
    expect(sshConfig.foreignStanzaLine(
      [sshConfig.beginMarker(alias), `Host ${alias}`, sshConfig.endMarker(alias),
       `Host ${alias}`], alias)).toBe(4);
  });

  test("a block under a retired marker is foreign", () => {
    const alias = "neon-vultr";
    expect(sshConfig.foreignStanzaLine(
      [`# BEGIN neon ${alias} ANSIBLE MANAGED BLOCK`, `Host ${alias}`,
       `# END neon ${alias} ANSIBLE MANAGED BLOCK`], alias)).toBe(2);
  });

  test("multi-pattern host lines count; unrelated files are left alone", () => {
    expect(sshConfig.foreignStanzaLine(["Host web neon-fixture db"], "neon-fixture")).toBe(1);
    expect(sshConfig.foreignStanzaLine(["Host build", "Host neon-other"], "neon-fixture"))
      .toBeUndefined();
  });

  test("an option above the first Host is refused; comments and Host openers are fine", () => {
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host a"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# comment", "", "IdentitiesOnly yes", "Host a"])).toBe(3);
    expect(sshConfig.leadingOptionLine(["Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# lead comment", "", "Host a", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["Match host b", "    User root"])).toBeUndefined();
    expect(sshConfig.leadingOptionLine(["# nothing here", ""])).toBeUndefined();
  });

  test("preflight refuses rather than overwrites", () => {
    const refused = sshConfig.preflight(fixture(), {
      adoptError: () => "already declares `Host x`",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(String(refused["red/err"])).toContain("already declares");
    const clean = sshConfig.preflight(fixture(), {
      adoptError: () => undefined,
      placementError: () => undefined,
    });
    expect(clean["red/exit"]).toBeUndefined();
  });

  test("adopt and placement errors read the real file and mention the recovery", () => {
    write(join(home, ".ssh", "config"), "ServerAliveInterval 60\nHost neon-fixture\n");
    expect(String(sshConfig.adoptError(fixture()))).toContain("Host neon-fixture");
    expect(String(sshConfig.placementError(fixture()))).toContain("Host *");
  });

  test("the local play renders no address and follows keygen mode", () => {
    const data = tools.ansibleLocalData(fixture({ ip: "203.0.113.7" }));
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/neon-fixture");
    expect(data["ssh-keygen"]).toBe(true);
    expect(tools.ansibleLocalData(optout())["ssh-keygen"]).toBe(false);
  });

  test("the local stage renders three files", () => {
    const targets = tools.ansibleLocalSpecs(fixture()).map((s) => String(s.target));
    for (const file of ["/ansible.cfg", "/inventory.ini", "/main.yml"]) {
      expect(targets.some((t) => t.endsWith(file))).toBe(true);
    }
    expect(targets.every((t) => t.includes("neon-ansible-local"))).toBe(true);
  });
});

// --- workflow ----------------------------------------------------------------

describe("workflow", () => {
  test("build and dry-run need no credentials and never touch ~/.ssh", async () => {
    // The standard forbids reading, creating, or requiring anything under
    // ~/.ssh on a build or dry-run: they render from desired state alone.
    // A poisoned config proves nothing in the build path reads it.
    write(join(home, ".ssh", "config"), "ServerAliveInterval 60\nHost neon-fixture\n");
    for (const overrides of [{ "red/event": "build" },
                             { "red/event": "create", "red/dry-run": true }]) {
      const result = await workflow.startStep(fixture(overrides), {});
      expect(result["red/exit"]).toBe(0);
      expect(result["ssh-public-key-path"]).toBeUndefined();
    }
  });

  test("a real create requires credentials", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "create" }), {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).not.toContain("COLORS_PAR_VULTR_API_KEY");
    expect(String(result["red/err"])).toContain("COLORS_PAR_NEON_R2_ACCESS_KEY_ID");
    // No DNS provider in this package: nothing is reachable by name, so no
    // Cloudflare token may be demanded.
    expect(String(result["red/err"])).not.toContain("CLOUDFLARE");
  });

  test("delete is protected", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "delete" }), {});
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
  });

  test("the create graph orders the stack", () => {
    const next = (step: string) =>
      (workflow.wireFn(step, { "red/event": "create" }) ?? []).slice(1);
    expect(next("neon/start")).toEqual(["neon/infrastructure"]);
    // The ssh-config block goes before the converge: both the converge and
    // the acceptance ride the alias it writes.
    expect(next("neon/infrastructure")).toEqual(["neon/ssh-config"]);
    expect(next("neon/ssh-config")).toEqual(["neon/ansible"]);
    expect(next("neon/ansible")).toEqual(["neon/acceptance"]);
  });

  test("delete removes the config block before the destroy and the key after it", () => {
    const next = (step: string) =>
      (workflow.wireFn(step, { "red/event": "delete" }) ?? []).slice(1);
    expect(next("neon/start")).toEqual(["neon/load"]);
    expect(next("neon/ansible")).toEqual(["neon/ssh-config"]);
    expect(next("neon/ssh-config")).toEqual(["neon/infrastructure"]);
    expect(next("neon/infrastructure")).toEqual([]);
  });
});
