import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const SCHEMA_VERSION = "1.0.0";
export const GENERATED_NOTICE = "GENERATED FILE. Run npm run agent:context; do not edit by hand.";

export function normalizePath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readText(root, path) {
  const absolute = resolve(root, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
}

export function fileMatches(root, probe) {
  const text = readText(root, probe.path);
  if (!text) return false;
  const lowered = text.toLowerCase();
  const terms = (probe.contains ?? []).map((term) => term.toLowerCase());
  if (terms.length === 0) return true;
  return probe.match === "any" ? terms.some((term) => lowered.includes(term)) : terms.every((term) => lowered.includes(term));
}

export function matchingPaths(root, probes = []) {
  return [...new Set(probes.filter((probe) => fileMatches(root, probe)).map((probe) => normalizePath(probe.path)))].sort();
}

export function listFiles(root, directories, extensions = null) {
  const output = [];
  for (const directory of directories) {
    const start = resolve(root, directory);
    if (!existsSync(start)) continue;
    const visit = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
        const absolute = resolve(current, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
          output.push(normalizePath(relative(root, absolute)));
        }
      }
    };
    visit(start);
  }
  return [...new Set(output)].sort();
}

export function run(root, command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error?.message ?? null,
  };
}

export function git(root, args) {
  return run(root, "git", args);
}

export function packageManagerCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function stableGeneratedAt(root, env = process.env) {
  if (env.AGENT_GENERATED_AT) return new Date(env.AGENT_GENERATED_AT).toISOString();
  if (env.SOURCE_DATE_EPOCH) return new Date(Number(env.SOURCE_DATE_EPOCH) * 1000).toISOString();
  const committed = git(root, ["show", "-s", "--format=%cI", "HEAD"]);
  return committed.ok && committed.stdout ? new Date(committed.stdout).toISOString() : new Date(0).toISOString();
}

export function inspectGit(root) {
  const branch = git(root, ["branch", "--show-current"]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  const main = git(root, ["rev-parse", "origin/main"]);
  const status = git(root, ["status", "--porcelain"]);
  return {
    branch: branch.ok ? branch.stdout || "detached" : "unknown",
    sha: sha.ok ? sha.stdout : "unknown",
    mainSha: main.ok ? main.stdout : "unknown",
    dirty: status.ok ? Boolean(status.stdout) : null,
  };
}

export function configuredEnvironment(env = process.env) {
  const names = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"];
  return Object.fromEntries(names.map((name) => [name, env[name] ? "configured" : "missing"]));
}

export function inspectOpenPrs(root, env = process.env) {
  if (env.AGENT_OPEN_PRS_JSON) {
    try {
      return { status: "available", items: JSON.parse(env.AGENT_OPEN_PRS_JSON) };
    } catch {
      return { status: "unknown", items: [], reason: "AGENT_OPEN_PRS_JSON is invalid" };
    }
  }
  if (env.AGENT_OFFLINE === "1") return { status: "unknown", items: [], reason: "offline mode" };
  const result = run(root, "gh", ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,headRefName,baseRefName,isDraft,url"]);
  if (!result.ok) return { status: "unknown", items: [], reason: result.error ?? (result.stderr || "gh unavailable") };
  try {
    return { status: "available", items: JSON.parse(result.stdout || "[]") };
  } catch {
    return { status: "unknown", items: [], reason: "gh returned invalid JSON" };
  }
}

export function migrationState(root) {
  const directory = resolve(root, "supabase/migrations");
  const files = existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => `supabase/migrations/${name}`)
    : [];
  const heads = files.map((path) => /^supabase\/migrations\/(\d+)/.exec(path)?.[1]).filter(Boolean);
  return {
    repoMigrationHead: heads.at(-1) ?? "none",
    migrationFiles: files,
    productionMigrationHead: "unknown",
    productionMigrationExpectation: heads.at(-1) ?? "none",
    requiresLiveCheck: true,
  };
}

export function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function redactForDisplay(value) {
  if (Array.isArray(value)) return value.map(redactForDisplay);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, /token|secret|key|password/i.test(key) ? redactStatus(child) : redactForDisplay(child)]));
  }
  return value;
}

function redactStatus(value) {
  if (value === "configured" || value === "missing" || value === "unknown") return value;
  return value == null ? value : "redacted";
}

export function validateAgentData(kind, value) {
  const failures = [];
  const required = {
    manifest: ["schemaVersion", "project", "product", "frontend", "cloud", "workspaces", "criticalPaths", "testCommands", "agentContextCommand"],
    architecture: ["schemaVersion", "generated", "components"],
    invariants: ["schemaVersion", "invariants"],
    featureMap: ["schemaVersion", "generated", "features"],
    state: ["schemaVersion", "generatedAt", "git", "project", "features", "database", "tests", "knownGaps", "warnings", "releaseReadiness", "nextRecommendedWork"],
  }[kind] ?? [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${kind} must be an object`];
  for (const key of required) if (!(key in value)) failures.push(`${kind}.${key} is required`);
  if (kind === "featureMap" && Array.isArray(value.features)) {
    const allowed = new Set(["implemented", "partial", "spec_only", "missing", "deprecated"]);
    value.features.forEach((feature, index) => {
      if (!feature.id) failures.push(`featureMap.features[${index}].id is required`);
      if (!allowed.has(feature.status)) failures.push(`featureMap.features[${index}].status is invalid`);
      for (const key of ["source", "migrations", "tests", "docs"]) {
        if (!Array.isArray(feature.evidence?.[key])) failures.push(`featureMap.features[${index}].evidence.${key} must be an array`);
      }
    });
  }
  return failures;
}
