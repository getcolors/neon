import { readPars, parName } from "red/cli";
import * as dryRun from "red/dry-run";
import { preflight } from "red/lifecycle";
import * as progress from "red/progress";
import * as tofu from "red/tofu";
import { adviceAdd, failed, workflow, type Opts, type WireDecl } from "red/workflow";
import * as compute from "./compute.ts";
import * as sshConfig from "./ssh-config.ts";
import * as tools from "./tools.ts";
import * as validate from "./validate.ts";

export const defaults: Opts = {
  "provider-compute": "vultr",
  "provider-backend": "r2", "compute-prevent-destroy": true,
  workdir: ".colors",
};

export async function startStep(
  opts: Opts,
  env: Record<string, string | undefined> = process.env,
): Promise<Opts> {
  return preflight(opts, {
    defaults,
    overlay: readPars,
    validators: [
      (_opts, environment) => validate.envErrors(environment),
      (current) => validate.stateErrors(current),
      (current, _environment, { event, real }) =>
        real && (event === "create" || event === "delete")
          ? validate.secretErrors(current, event)
          : [],
      (current, _environment, { event, real }) =>
        real && event === "delete" && current["compute-prevent-destroy"]
          ? [`compute destruction is protected; set ${parName("compute-prevent-destroy")}=false to delete`]
          : [],
    ],
    afterValidate: (current, _environment, {event,real}) => real && event==='create' ? sshConfig.preflight({...current,'red/exit':0}) : {...current,'red/exit':0},
  }, env);
}

export function wireFn(step: string, runOpts: Opts): WireDecl | undefined {
  if (runOpts["red/event"] === "delete") {
    const graph: Record<string, WireDecl> = {
      "neon/start": [startStep, "neon/load"],
      "neon/load": [compute.loadStep, "neon/ansible"],
      // The `~/.ssh/config` block goes before the destroy, the opposite of the
      // keypair below. A block that outlives its host is stale but harmless; a
      // key that predeceases its host locks the operator out of a machine that
      // still exists. Both orders are deliberate; see standards/ssh-config.md.
      "neon/ansible": [tools.ansibleStep, "neon/ssh-config"],
      "neon/ssh-config": [tools.ansibleLocalStep, "neon/infrastructure"],
      "neon/infrastructure": [tools.infrastructureStep],
    };
    return graph[step];
  }
  const graph: Record<string, WireDecl> = {
    "neon/start": [startStep, "neon/infrastructure"],
    // After compute, which is where the address first exists, and before the
    // stage that converges the machine — the converge and the acceptance
    // both ride the alias this stage writes.
    "neon/infrastructure": [tools.infrastructureStep, "neon/ssh-config"],
    "neon/ssh-config": [tools.ansibleLocalStep, "neon/ansible"],
    "neon/ansible": [tools.ansibleStep, "neon/acceptance"],
    "neon/acceptance": [tools.acceptanceStep],
  };
  return graph[step];
}

export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => tools.toolDir(opts, tool),
    key: (opts) => `${opts.profile ?? ""}/${tool}.tfstate`,
  });
}

export const sideEffecting = [
  "neon/infrastructure", "neon/ssh-config",
  "neon/ansible", "neon/acceptance", "neon/load",
];

function create() {
  let wf = workflow({ start: "neon/start", wireFn });
  return dryRun.advise(progress.advise(wf), sideEffecting);
}

export const neonWorkflow = create();
