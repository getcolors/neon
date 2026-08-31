import * as ansible from "red/ansible";
import { stageDir } from "red/cli";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { failed } from "red/workflow";
import * as sshConfig from "./ssh-config.ts";
import * as validate from "./validate.ts";

import ansibleLocalCfg from "../resources/tools/ansible-local/ansible.cfg" with { type: "text" };
import ansibleLocalInventory from "../resources/tools/ansible-local/inventory.ini" with { type: "text" };
import ansibleLocalMain from "../resources/tools/ansible-local/main.yml" with { type: "text" };
import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleMain from "../resources/tools/ansible/main.yml" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import ansibleCompose from "../resources/tools/ansible/compose.yml" with { type: "text" };
import ansiblePageserverToml from "../resources/tools/ansible/pageserver.toml" with { type: "text" };
import ansibleIdentityToml from "../resources/tools/ansible/identity.toml" with { type: "text" };
import ansibleConfigJson from "../resources/tools/ansible/config.json" with { type: "text" };
import ansibleScramgen from "../resources/tools/ansible/scramgen.py" with { type: "text" };
import ansibleBootstrap from "../resources/tools/ansible/bootstrap.sh" with { type: "text" };
import ansibleSmoke from "../resources/tools/ansible/smoke.sh" with { type: "text" };
import ansibleStatus from "../resources/tools/ansible/status.sh" with { type: "text" };
import ansibleRotate from "../resources/tools/ansible/rotate.sh" with { type: "text" };
import infrastructureMainTf from "../resources/tools/infrastructure/main.tf" with { type: "text" };

export const infrastructureTool = "neon-infrastructure";
export const ansibleTool = "neon-ansible";
export const ansibleLocalTool = "neon-ansible-local";
export const templateOpts = PRESERVE_JINJA_DELIMITERS;

export function toolDir(opts: Opts, tool: string): string {
  return stageDir(opts, tool, { defaultProfile: "neon" });
}

const template = (name: string, content: string): Template => ({ name, content });

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

export function cidrs(opts: Opts, key: string): string[] {
  const value = opts[key];
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  return parts.map((part) => String(part).trim()).filter((part) => part.length > 0);
}

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  const mapping: Record<string, string> = Object.assign(
    {},
    ...[...slots, "provider-backend"].map((slot) => validate.tofuEnv(opts, slot)),
  );
  const env: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(mapping)) {
    const value = String(opts[key] ?? "");
    if (value.length > 0) env[envVar] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export const backendCredentialEnv = (opts: Opts) => credentialEnv(opts);

export function fallbackParams(opts: Opts): Record<string, unknown> {
  return { ip: "192.0.2.10", user: "root", sudoer: "root", name: validate.computeName(opts) };
}

export function outputParams(result: Opts): Record<string, unknown> | undefined {
  const params = (result["tofu/outputs"] as Record<string, unknown> | undefined)?.params;
  return params && typeof params === "object" ? params as Record<string, unknown> : undefined;
}

// The Neon data prefix inside the R2 bucket. Everything the pageserver and
// safekeeper write — and the ownership markers guarding adoption — lives
// under `<profile>/data/`. The tofu state for the same deployment lives at
// `<profile>/<stage>.tfstate` in the same bucket, a sibling key space that
// never collides with this one.
export function r2Prefix(opts: Opts): string {
  return `${opts.profile}/data`;
}

// ---------------------------------------------------------------- compute

export function infrastructureData(opts: Opts): Opts {
  return {
    ...opts,
    "compute-name": validate.computeName(opts),
    "ssh-keygen": validate.keygen(opts),
    "ssh-sources-hcl": tofu.hclList(cidrs(opts, "vultr-ssh-sources")),
  };
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const specs = [spec(template("infrastructure/main.tf", infrastructureMainTf),
                      `${dir}/main.tf`, infrastructureData(opts))];
  const result = await tofu.tofuWithSpec(opts, specs,
    { dir, env: credentialEnv(opts, "provider-compute") });
  if (failed(result)) return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackParams(opts) };
  if (opts["red/event"] === "delete") return result;
  return { ...result, ...fallbackParams(opts), ...outputParams(result) };
}

// ---------------------------------------------------------- ansible (local)

// Only what a `build` genuinely knows. The address, the user and the alias are
// run-time facts and reach the play as extra-vars instead, so the rendered
// playbook carries no IP and is identical on every workstation (SSH Config
// Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": sshConfig.identityFile(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  return [
    spec(template("ansible-local/ansible.cfg", ansibleLocalCfg), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local/inventory.ini", ansibleLocalInventory), `${dir}/inventory.ini`, data),
    spec(template("ansible-local/main.yml", ansibleLocalMain), `${dir}/main.yml`, data),
  ];
}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleLocalTool);
  const isDelete = opts["red/event"] === "delete";
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ip: opts.ip ?? fallbackParams(opts).ip,
      user: opts.user ?? "root",
      block_state: isDelete ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
}

// ---------------------------------------------------------------- ansible

function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  return JSON.stringify(value ?? null);
}

export function inventory(opts: Opts): string {
  return pretty({
    all: {
      children: {
        neon: {
          hosts: {
            [String(opts.profile)]: {
              ansible_host: opts.ip ?? "192.0.2.10",
              ansible_user: "root",
            },
          },
        },
      },
    },
  });
}

// Template values for the Ansible stage.
//
// Deliberately carries neither operator secret. The R2 pair reaches the host
// as Ansible `lookup('env', ...)` expressions written literally into main.yml,
// where `preserve-jinja-delimiters` passes them through untouched — routing
// them through this map instead would let the template engine HTML-escape the
// quotes and hand Ansible `&#39;`. The secret therefore exists only in the
// process that needs it: not in `.colors/`, not in a golden, not in this map.
export function ansibleData(opts: Opts): Opts {
  return {
    ...opts,
    ip: opts.ip ?? "192.0.2.10",
    "ssh-keygen": validate.keygen(opts),
    "neon-r2-prefix": r2Prefix(opts),
  };
}

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = ansibleData(opts);
  const files: Array<[string, string]> = [
    ["ansible.cfg", ansibleCfg],
    ["main.yml", ansibleMain],
    ["cleanup.yml", ansibleCleanup],
    ["compose.yml", ansibleCompose],
    ["pageserver.toml", ansiblePageserverToml],
    ["identity.toml", ansibleIdentityToml],
    ["config.json", ansibleConfigJson],
    ["scramgen.py", ansibleScramgen],
    ["bootstrap.sh", ansibleBootstrap],
    ["smoke.sh", ansibleSmoke],
    ["status.sh", ansibleStatus],
    ["rotate.sh", ansibleRotate],
  ];
  return [
    ...files.map(([name, content]) =>
      spec(template(`ansible/${name}`, content), `${dir}/${name}`, data)),
    rawSpec(`${dir}/inventory.json`, inventory(data)),
  ];
}

export async function ansibleStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, ansibleTool);
  if (opts["red/event"] === "delete" && !opts.ip) {
    // No compute in state: there is no host to stop, and the cleanup play
    // would only fail against the placeholder address.
    return { ...opts, "red/exit": 0 };
  }
  return ansible.ansibleWithSpec(opts, {
    dir,
    inventory: "inventory.json",
    playbooks: { create: "main.yml", delete: "cleanup.yml" },
    hostKeyChecking: false,
  }, ansibleSpecs(opts));
}

// ------------------------------------------------------------- acceptance

// Run `args` with `env` overlaid, returning the result map. Nothing from the
// child is echoed; callers decide what becomes an error message, so a secret
// passed through `env` can never leak into output by default.
async function runQuiet(args: string[], env: Record<string, string>, timeoutMs: number) {
  return runtime.exec(args, { env, timeoutMs });
}

// A psql invocation with an explicit everything: host, port, role, database,
// and `-w` so a missing password fails instead of prompting. `env -i` clears
// the environment and re-admits only PATH, the password handed over through
// the runner, and a dead PGPASSFILE — so no ambient PG* variable, service
// file, or ~/.pgpass can alter what the probe proves.
export function psqlArgs(opts: Opts, port: number, sql: string): string[] {
  const quoted = `'${sql.replaceAll("'", `'\\''`)}'`;
  return ["bash", "-c",
    'exec env -i PATH="$PATH" PGPASSFILE=/dev/null PGPASSWORD="$PGPASSWORD" psql' +
    ` 'postgresql://${opts["neon-role"]}@127.0.0.1:${port}/${opts["neon-database"]}?connect_timeout=10'` +
    ` -w -v ON_ERROR_STOP=1 -tAc ${quoted}`];
}

// An ssh tunnel through the generated `~/.ssh/config` alias — the supported
// client path, exercised end to end: the alias, the identity file, and the
// forward. `-f` returns once the forward is up; the remote `sleep` bounds its
// lifetime so nothing needs killing on the way out.
// The bash wrapper exists for the streams: the daemonized child inherits
// stdout/stderr, and a runner that waits for the pipes to close would
// otherwise block until the sleep expires — returning exactly when the
// tunnel dies.
export function tunnelArgs(opts: Opts, port: number): string[] {
  return ["bash", "-c",
    "ssh -f -o ExitOnForwardFailure=yes -o BatchMode=yes" +
    ` -L ${port}:127.0.0.1:55433 ` +
    `${sshConfig.hostAlias(opts)} sleep 45 >/dev/null 2>&1`];
}

// One deployment-scoped row, updated deterministically: the same statement on
// every converge, so a second create reconciles instead of accumulating.
export const smokeSql =
  "INSERT INTO colors_smoke (id, note, at) VALUES (1, 'operator-path', now())" +
  " ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at;" +
  " SELECT count(*) FROM colors_smoke;";

// The generated application-role password, read over SSH and held only in this
// process. Never merged into opts, never printed.
export async function readRemotePassword(opts: Opts): Promise<string | undefined> {
  const result = await runQuiet(["ssh", "-o", "BatchMode=yes", sshConfig.hostAlias(opts),
    "cat", "/etc/neon/secrets/neon_role_password"], {}, 20000);
  if (result.exit !== 0) return undefined;
  const password = String(result.out ?? "").trim();
  return password.length > 0 ? password : undefined;
}

// The operator-path gate, after a real create.
//
// The server-side gates already ran inside the playbook (health, the SQL
// round-trip, the auth negatives, the R2 object listings). What is checked
// from here is the one thing only this side can check: that an operator on
// this workstation reaches the database through the generated SSH config and
// a tunnel — the supported client path — with the generated password, and
// not without it.
export async function acceptanceStep(opts: Opts): Promise<Opts> {
  if (opts["red/event"] !== "create") return { ...opts, "red/exit": 0 };
  const password = await readRemotePassword(opts);
  if (!password) {
    return { ...opts, "red/exit": 1,
      "red/err": "acceptance: could not read the generated role password over ssh" };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const tunnel = await runQuiet(tunnelArgs(opts, port), {}, 30000);
    if (tunnel.exit !== 0) continue;
    const ok = await runQuiet(psqlArgs(opts, port, smokeSql), { PGPASSWORD: password }, 30000);
    const denied = await runQuiet(psqlArgs(opts, port, "SELECT 1;"),
      { PGPASSWORD: "not-the-password" }, 30000);
    if (ok.exit !== 0) {
      return { ...opts, "red/exit": 1,
        "red/err": "acceptance: the tunnelled smoke round-trip failed: " +
          String(ok.err ?? "").trim() };
    }
    // psql prints the INSERT command tag before the count; the count is the
    // last line.
    const rows = String(ok.out ?? "").trim().split("\n").at(-1);
    if (rows !== "1") {
      return { ...opts, "red/exit": 1,
        "red/err": "acceptance: colors_smoke should hold exactly one row, got " +
          String(ok.out ?? "").trim() };
    }
    if (denied.exit === 0) {
      return { ...opts, "red/exit": 1,
        "red/err": "acceptance: a wrong password was accepted through the tunnel" };
    }
    return { ...opts, "red/exit": 0,
      "neon/acceptance": { tunnel: "ok", "smoke-rows": "1", "wrong-password": "refused" } };
  }
  return { ...opts, "red/exit": 1,
    "red/err": "acceptance: no local port could carry the ssh tunnel after three attempts" };
}
