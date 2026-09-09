import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { providers } from "package-once-red";
import {plan_deployment,registry} from "colors-compute-red";
import * as compute from "./compute.ts";

export const profilePar = parName("profile");

// Every key desired state must carry.
//
// Two deliberate absences. `vultr-ssh-keys` selects opt-out mode by being
// present (SSH Keypair Standard), so requiring it would make every conforming
// keygen deployment invalid. `vultr-name` is the Compute Name Standard's
// optional override: a fresh colors.yml that omits it is complete and names
// the machine after the profile. There is likewise no `provider-dns`: nothing
// in this package is reachable by name — the firewall opens 22 only and the
// client path is an SSH tunnel — so a DNS provider would be a key with
// nothing to configure.
export const required = [
  "profile", "workdir", "provider-compute", "provider-backend",
  "compute-prevent-destroy",
  "neon-image", "neon-compute-image", "neon-pg-version",
  "neon-tenant-id", "neon-timeline-id",
  "neon-database", "neon-role",
  "neon-r2-bucket", "neon-r2-endpoint", "neon-r2-region",
];

export const imageKeys = ["neon-image", "neon-compute-image"];

// `tag@sha256:...` — the shape both image keys actually carry — pins both the
// human-readable release and the exact bytes. Upstream also publishes floating
// tags, which is why the digest is required rather than the suffix denied.
const imageRe = /^[^\s:@]+(?:\/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})$/;
const hex32Re = /^[0-9a-f]{32}$/;
const identRe = /^[a-z_][a-z0-9_]*$/;
const urlRe = /^https:\/\/[^\s]+$/;

export function missing(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

// Whether the compute-name override is effectively absent (Compute Name
// Standard §2: presence is the only switch).
export function placeholder(value: unknown): boolean {
  return missing(value) || String(value).trim() === "REPLACE_ME";
}

// What this deployment calls its machine. The one function that answers it —
// every label, including the firewall's, derives from this and never from the
// raw override key or a second copy of the profile (§3).
export function computeName(opts: Opts): string {
  return plan_deployment(opts,compute.topology,compute.requirements(opts)).cluster.nodes[0].name;
}

// Whether this deployment owns its machine keypair. Delegates to ONCE, the
// standard's reference implementation, so one rule decides it everywhere.
export function keygen(opts: Opts): boolean {
  return plan_deployment(opts,compute.topology,compute.requirements(opts)).key.mode === 'managed';
}

export function envErrors(env: Record<string, string | undefined>): string[] {
  return String(env[profilePar] ?? "").length
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }
  errors.push(...compute.errors(opts));
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }
  for (const key of imageKeys) {
    const value = opts[key];
    if (!missing(value) && !imageRe.test(String(value))) {
      errors.push(`:${key} must carry an explicit image tag or digest`);
    }
  }
  // Upstream also publishes floating tags, and the two release trains move
  // independently, so the one thing that can be checked is that neither
  // floats: a digest is required, not merely a tag.
  for (const key of imageKeys) {
    const value = String(opts[key] ?? "");
    if (!missing(opts[key]) && !value.includes("@sha256:")) {
      errors.push(`:${key} must be pinned by digest (tag@sha256:...)`);
    }
  }
  const pgVersion = opts["neon-pg-version"];
  if (!(missing(pgVersion) || [14, 15, 16, 17].includes(pgVersion as number))) {
    errors.push(":neon-pg-version must be 14, 15, 16, or 17");
  }
  // Tenant and timeline identities are desired state: fixing them is what
  // makes convergence reconcilable and recovery describable. Pageserver ids
  // are 16-byte hex strings.
  for (const key of ["neon-tenant-id", "neon-timeline-id"]) {
    const value = opts[key];
    if (!missing(value) && !hex32Re.test(String(value))) {
      errors.push(`:${key} must be 32 lowercase hex characters`);
    }
  }
  for (const key of ["neon-database", "neon-role"]) {
    const value = opts[key];
    if (!missing(value) && !identRe.test(String(value))) {
      errors.push(`:${key} must be a lowercase identifier`);
    }
  }
  // cloud_admin is the superuser compute_ctl itself connects as; a desired
  // state that names it would collide with the generated credential.
  if (String(opts["neon-role"]) === "cloud_admin") {
    errors.push(":neon-role must not be cloud_admin");
  }
  if (!missing(opts["neon-r2-endpoint"]) &&
      !urlRe.test(String(opts["neon-r2-endpoint"]))) {
    errors.push(":neon-r2-endpoint must be an https URL");
  }
  return errors;
}

export function backendSecrets(opts: Opts): string[] {
  return (registry.backend as Record<string,any>)?.[String(opts["provider-backend"])]?.secrets ?? [];
}

// What talking to the provider needs, on any real event.
export const providerSecrets: string[] = [];

// What converging the machine needs, and therefore only a create: the R2 pair
// the pageserver and safekeeper write remote storage with. The database role
// passwords are deliberately absent — they are generated on the server, once,
// and are never supplied by the operator.
export const applicationSecrets = [
  "neon-r2-access-key-id",
  "neon-r2-secret-access-key",
];

// Credentials a real event needs. A delete tears down infrastructure and never
// converges anything, so it asks for the provider credentials only.
export function secretErrors(opts: Opts, event: string): string[] {
  const keys = [...new Set([
    ...providerSecrets,
    ...(event === "create" ? applicationSecrets : []),
    ...backendSecrets(opts),
  ])];
  return keys.filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  switch (slot) {
    case "provider-compute":
      return {};
    case "provider-backend":
      return (registry.backend as Record<string,any>)?.[String(opts["provider-backend"])]?.["tofu-env"] ?? {};
    default:
      return {};
  }
}
