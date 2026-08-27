import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { architectureDefinitions, featureDefinitions } from "./agent-config.mjs";
import { GENERATED_NOTICE, SCHEMA_VERSION, buildImportGraph, matchingPaths, normalizePath } from "./agent-lib.mjs";

function requiredEvidence(definition, evidence) {
  const minimum = definition.minimum ?? {};
  return Object.entries(minimum).map(([kind, count]) => ({
    kind,
    required: count,
    found: evidence[kind]?.length ?? 0,
    satisfied: (evidence[kind]?.length ?? 0) >= count,
  }));
}

export function classifyFeature(definition, root, importGraph = null) {
  const graph = importGraph ?? buildImportGraph(root);
  const allSource = matchingPaths(root, definition.source);
  // 掛載證據：src/ 底下的 source 只有「從 src/main.tsx 走得到」才算數。
  // 存在但未掛載的檔案（原型、孤兒）進 unmountedSource — 這正是 PR-00
  // audit 抓到的 scanner 誤報（apply-back/library 指向從未 mount 的檔案
  // 也標 implemented）。src/ 之外（supabase/functions、鄰倉）不受此限。
  const unmountedSource = allSource.filter((path) => path.startsWith("src/") && !graph.has(path));
  const evidence = {
    source: allSource.filter((path) => !unmountedSource.includes(path)),
    unmountedSource,
    migrations: matchingPaths(root, definition.migrations),
    tests: matchingPaths(root, definition.tests),
    docs: matchingPaths(root, definition.docs),
  };
  const requirements = requiredEvidence(definition, evidence);
  const executableCount = evidence.source.length + evidence.migrations.length + evidence.tests.length;
  let status;
  if (definition.deprecated) status = "deprecated";
  else if (requirements.length > 0 && requirements.every((item) => item.satisfied)) status = "implemented";
  else if (executableCount > 0) status = "partial";
  else if (evidence.docs.length > 0) status = "spec_only";
  else status = "missing";

  const requiredTotal = requirements.reduce((sum, item) => sum + item.required, 0);
  const satisfiedTotal = requirements.reduce((sum, item) => sum + Math.min(item.found, item.required), 0);
  const confidence = status === "implemented"
    ? Math.min(0.99, 0.82 + Math.min(0.17, executableCount * 0.025))
    : status === "spec_only"
      ? 0.95
      : status === "missing"
        ? 0.9
        : Math.max(0.35, Math.min(0.79, requiredTotal ? satisfiedTotal / requiredTotal : 0.5));
  const missing = requirements.filter((item) => !item.satisfied).map((item) => `${item.kind}: need ${item.required}, found ${item.found}`);
  const notes = [];
  if (status === "spec_only") notes.push("Documentation exists, but executable source/migration/test evidence does not.");
  if (status === "partial") notes.push(`Executable evidence is incomplete: ${missing.join("; ")}.`);
  if (status === "implemented" && evidence.docs.length > 0) notes.push("Status is based on executable evidence, not documentation or PR metadata.");
  if (evidence.unmountedSource.length > 0) notes.push(`Unmounted source (present but unreachable from src/main.tsx): ${evidence.unmountedSource.join(", ")}.`);
  return {
    id: definition.id,
    name: definition.name,
    status,
    evidence,
    requirements,
    confidence: Number(confidence.toFixed(2)),
    implemented: requirements.filter((item) => item.satisfied).map((item) => item.kind),
    missing,
    relatedFiles: [...new Set(Object.values(evidence).flat())].sort(),
    priority: definition.priority ?? 3,
    notes,
  };
}

export function scanFeatures(root, definitions = featureDefinitions) {
  const importGraph = buildImportGraph(root);
  return {
    schemaVersion: SCHEMA_VERSION,
    generated: GENERATED_NOTICE,
    evidenceModel: {
      implemented: "All feature-specific executable evidence thresholds are met (normally source+test or source+migration+test).",
      partial: "Some executable evidence exists, but a required integration, migration, route, or test is absent.",
      spec_only: "Documentation exists and no executable evidence exists.",
      missing: "No source, migration, test, or documentation evidence exists.",
      precedence: ["source", "migrations", "tests", "git_diff", "deployment", "pr_metadata", "docs"],
    },
    features: definitions.map((definition) => classifyFeature(definition, root, importGraph)).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function queryFeature(featureMap, id) {
  const normalized = id.toLowerCase();
  const exact = featureMap.features.find((feature) => feature.id === normalized);
  if (exact) return exact;
  const matches = featureMap.features.filter((feature) => feature.id.includes(normalized) || feature.name.toLowerCase().includes(normalized));
  if (matches.length === 1) return matches[0];
  return matches.length ? { query: id, matches } : null;
}

function isDirectRun() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  const root = process.cwd();
  const result = scanFeatures(root);
  const featureIndex = process.argv.findIndex((arg) => arg === "--feature" || arg === "feature");
  if (featureIndex >= 0) {
    const found = queryFeature(result, normalizePath(process.argv[featureIndex + 1] ?? ""));
    if (!found) {
      console.error(JSON.stringify({ error: "FEATURE_NOT_FOUND", feature: process.argv[featureIndex + 1] ?? "" }, null, 2));
      process.exitCode = 2;
    } else console.log(JSON.stringify(found, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
}
