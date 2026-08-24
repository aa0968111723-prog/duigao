import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArchitecture, buildInvariants, buildManifest, buildSchema } from "./agent-architecture.mjs";
import { queryFeature, scanFeatures } from "./agent-feature-scan.mjs";
import { evaluateGate } from "./agent-release-gate.mjs";
import { GENERATED_NOTICE, SCHEMA_VERSION, configuredEnvironment, inspectGit, inspectOpenPrs, migrationState, stableGeneratedAt, validateAgentData } from "./agent-lib.mjs";

function packageTests(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  return {
    requiredCommands: Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith("test:")).sort().map((name) => `npm run ${name}`),
    buildCommands: ["npm run build", "npm run build:local"],
    releaseGateCommand: "npm run agent:gate",
    latestResults: "not_run",
    note: "Context generation discovers thresholds; agent:gate and CI execute them.",
  };
}

export function generateAgentContext(root, options = {}) {
  const env = options.env ?? process.env;
  const architecture = buildArchitecture(root);
  const manifest = buildManifest(root, architecture);
  const invariants = buildInvariants();
  const featureMap = scanFeatures(root, options.featureDefinitions);
  const schema = buildSchema();
  const git = inspectGit(root);
  const database = migrationState(root);
  const openPrs = inspectOpenPrs(root, env);
  const structuralGate = evaluateGate(root, { runBuild: false, changedFiles: options.changedFiles, claim: options.claim });
  const gaps = featureMap.features
    .filter((feature) => !["implemented", "deprecated"].includes(feature.status))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((feature) => ({ id: feature.id, status: feature.status, priority: feature.priority, missing: feature.missing, relatedFiles: feature.relatedFiles }));
  const warnings = featureMap.features
    .filter((feature) => feature.status === "spec_only")
    .map((feature) => ({ code: "FEATURE_CLAIM_MISMATCH", feature: feature.id, message: "Docs exist, but executable evidence is absent; status is SPEC_ONLY." }));
  if (openPrs.status === "unknown") warnings.push({ code: "OPEN_PRS_UNKNOWN", message: openPrs.reason ?? "Live PR check unavailable." });
  const state = {
    schemaVersion: SCHEMA_VERSION,
    generated: GENERATED_NOTICE,
    generatedAt: stableGeneratedAt(root, env),
    git,
    project: {
      name: manifest.project,
      product: manifest.product,
      positioning: "手機優先、只標記不改原稿的圖片／影片對稿協作工具",
      primaryLanguage: manifest.primaryLanguage,
      architectureComponents: architecture.components.map((component) => component.name),
      openPrs,
      environment: configuredEnvironment(env),
    },
    features: Object.fromEntries(featureMap.features.map((feature) => [feature.id, {
      status: feature.status,
      confidence: feature.confidence,
      evidence: feature.evidence,
      relatedFiles: feature.relatedFiles,
      missing: feature.missing,
    }])),
    database,
    tests: packageTests(root),
    knownGaps: gaps,
    warnings,
    releaseReadiness: {
      status: structuralGate.status === "PASS" ? "structurally_ready_tests_not_run" : "blocked",
      automergeAllowed: false,
      rule: structuralGate.rule,
      structuralChecks: structuralGate.checks.map(({ code, ok, message }) => ({ code, ok, message })),
      requiredAction: "Run npm run agent:gate and all CI/E2E checks on the final diff.",
    },
    nextRecommendedWork: gaps.slice(0, 5).map((gap, index) => ({ rank: index + 1, feature: gap.id, status: gap.status, reason: gap.missing.join("; ") || "No executable evidence." })),
    forbiddenActions: [
      "Modify original image/video bytes.",
      "Put invite secrets in query strings, logs, state files, or database plaintext.",
      "Make room-assets public.",
      "Grant reviewers upload, replace, archive, or delete media capabilities.",
      "Merge a feature/fix/security implementation that changes only docs.",
      "Auto-merge unless npm run agent:gate passes.",
    ],
  };
  const documents = { manifest, architecture, invariants, featureMap, schema, state };
  const validation = [
    ...validateAgentData("manifest", manifest), ...validateAgentData("architecture", architecture),
    ...validateAgentData("invariants", invariants), ...validateAgentData("featureMap", featureMap),
    ...validateAgentData("state", state),
  ];
  if (validation.length) throw new Error(`Agent context validation failed:\n${validation.join("\n")}`);
  if (options.write !== false) writeDocuments(root, documents);
  return documents;
}

function writeDocuments(root, documents) {
  const directory = resolve(root, ".agent");
  mkdirSync(directory, { recursive: true });
  const files = {
    "manifest.json": documents.manifest, "architecture.json": documents.architecture,
    "invariants.json": documents.invariants, "feature-map.json": documents.featureMap,
    "schema.json": documents.schema, "state.json": documents.state,
  };
  for (const [name, value] of Object.entries(files)) writeFileSync(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function featurePayload(feature) {
  if (!feature || feature.matches) return feature;
  return {
    feature: feature.id, status: feature.status, implemented: feature.implemented, missing: feature.missing,
    relatedFiles: feature.relatedFiles, tests: feature.evidence.tests, migrations: feature.evidence.migrations,
    evidence: feature.evidence, confidence: feature.confidence, notes: feature.notes,
  };
}

function parseMode(args) {
  const featureIndex = args.findIndex((arg) => arg === "--feature" || arg === "feature");
  if (featureIndex >= 0) return { kind: "feature", value: args[featureIndex + 1] ?? "" };
  if (args.includes("--architecture") || args.includes("architecture")) return { kind: "architecture" };
  if (args.includes("--gaps") || args.includes("gaps")) return { kind: "gaps" };
  if (args.includes("--release") || args.includes("release")) return { kind: "release" };
  if (args.includes("--json") || args.includes("json")) return { kind: "json" };
  return { kind: "human" };
}

function printHuman({ state, architecture, featureMap, invariants }) {
  console.log("=== DUIGAO AGENT CONTEXT ===\n");
  console.log("Git");
  console.log(`✓ branch: ${state.git.branch}`);
  console.log(`✓ sha: ${state.git.sha}`);
  console.log(`✓ main: ${state.git.mainSha}`);
  console.log(`${state.git.dirty ? "!" : "✓"} dirty: ${state.git.dirty}`);
  console.log("\nArchitecture");
  for (const component of architecture.components) console.log(`✓ ${component.name}: ${component.path.join(", ")}`);
  console.log("\nFeatures");
  const symbol = { implemented: "✓", partial: "△", spec_only: "□", missing: "✗", deprecated: "-" };
  for (const feature of featureMap.features) console.log(`${symbol[feature.status]} ${feature.id}: ${feature.status.toUpperCase()}`);
  console.log("\nDatabase");
  console.log(`✓ repo migration head: ${state.database.repoMigrationHead}`);
  console.log(`? production migration: ${state.database.productionMigrationHead} (live check required)`);
  console.log("\nCritical invariants");
  for (const invariant of invariants.invariants.filter((item) => item.severity === "critical")) console.log(`✓ ${invariant.id}: ${invariant.rule}`);
  console.log("\nOpen PRs");
  if (state.project.openPrs.status === "available") console.log(state.project.openPrs.items.length ? state.project.openPrs.items.map((pr) => `#${pr.number} ${pr.title}`).join("\n") : "✓ none");
  else console.log(`? ${state.project.openPrs.reason}`);
  console.log("\nWarnings");
  if (!state.warnings.length) console.log("✓ none");
  for (const warning of state.warnings) console.log(`! ${warning.code}: ${warning.feature ? `${warning.feature}: ` : ""}${warning.message}`);
  console.log("\nRecommended next work");
  if (!state.nextRecommendedWork.length) console.log("✓ no known feature gaps");
  for (const item of state.nextRecommendedWork) console.log(`${item.rank}. ${item.feature} (${item.status}) — ${item.reason}`);
  console.log(`\nRelease readiness: ${state.releaseReadiness.status}`);
  console.log(state.releaseReadiness.rule);
  console.log("\nMachine files written to .agent/*.json");
  console.log("================================");
}

const direct = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (direct) {
  try {
    const documents = generateAgentContext(process.cwd());
    const mode = parseMode(process.argv.slice(2));
    if (mode.kind === "feature") {
      const found = queryFeature(documents.featureMap, mode.value);
      if (!found) { console.error(JSON.stringify({ error: "FEATURE_NOT_FOUND", feature: mode.value }, null, 2)); process.exitCode = 2; }
      else console.log(JSON.stringify(featurePayload(found), null, 2));
    } else if (mode.kind === "architecture") console.log(JSON.stringify(documents.architecture, null, 2));
    else if (mode.kind === "gaps") console.log(JSON.stringify(documents.state.knownGaps, null, 2));
    else if (mode.kind === "release") console.log(JSON.stringify(documents.state.releaseReadiness, null, 2));
    else if (mode.kind === "json") console.log(JSON.stringify(documents.state, null, 2));
    else printHuman(documents);
  } catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; }
}
