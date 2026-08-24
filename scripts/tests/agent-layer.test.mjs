import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyFeature, queryFeature, scanFeatures } from "../agent-feature-scan.mjs";
import { generateAgentContext } from "../agent-context.mjs";
import { checkClaimedChange, checkCriticalInvariants, checkMigrationOrder, evaluateGate, findSecretLeaks } from "../agent-release-gate.mjs";
import { inspectGit, validateAgentData } from "../agent-lib.mjs";

function fixture() {
  return mkdtempSync(resolve(tmpdir(), "duigao-agent-"));
}

function put(root, path, content = "evidence") {
  const absolute = resolve(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function definition() {
  return {
    id: "demo", name: "Demo", source: [{ path: "src/demo.ts", contains: ["execute"] }],
    tests: [{ path: "tests/demo.test.mjs", contains: ["assert"] }],
    docs: [{ path: "docs/demo.md" }], minimum: { source: 1, tests: 1 },
  };
}

function minimalPackage(root) {
  put(root, "package.json", JSON.stringify({
    name: "duigao-fixture", type: "module", scripts: {
      build: "echo build", "build:local": "echo build", "test:share-e2e": "echo test",
      "test:share-preview": "echo test", "test:video": "echo test", "test:migrations": "echo test",
      "test:agent": "echo test", "agent:context": "echo context", "agent:query": "echo query",
      "agent:gate": "echo gate", "agent:state": "echo state",
    },
  }));
}

test("docs-only feature implementation is rejected", () => {
  const checks = checkClaimedChange({ changedFiles: ["docs/plan.md", "README.md"], claim: "feature: implement review" });
  assert.equal(checks.find((check) => check.code === "FEATURE_IMPLEMENTATION_REQUIRED")?.ok, false);
});

test("source plus tests is implemented", () => {
  const root = fixture();
  put(root, "src/demo.ts", "export const execute = true;");
  put(root, "tests/demo.test.mjs", "assert(true);");
  assert.equal(classifyFeature(definition(), root).status, "implemented");
});

test("docs only is spec_only", () => {
  const root = fixture();
  put(root, "docs/demo.md", "# specification");
  assert.equal(classifyFeature(definition(), root).status, "spec_only");
});

test("source only is partial", () => {
  const root = fixture();
  put(root, "src/demo.ts", "export const execute = true;");
  assert.equal(classifyFeature(definition(), root).status, "partial");
});

test("absent evidence is missing", () => {
  assert.equal(classifyFeature(definition(), fixture()).status, "missing");
});

test("migration order detects gaps and invalid names", () => {
  const root = fixture();
  put(root, "supabase/migrations/0001_first.sql");
  put(root, "supabase/migrations/0003_third.sql");
  put(root, "supabase/migrations/not_ordered.sql");
  const check = checkMigrationOrder(root);
  assert.equal(check.ok, false);
  assert.match(check.details.join(" "), /gap|invalid name/);
});

test("agent context emits environment status but never secret values or invite tokens", () => {
  const root = fixture();
  minimalPackage(root);
  const env = {
    SOURCE_DATE_EPOCH: "1700000000", AGENT_OFFLINE: "1",
    VITE_SUPABASE_URL: "https://private-project.supabase.co",
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_" + "secret_NOT_ALLOWED_1234567890",
    INVITE_TOKEN: "invite-" + "secret-abcdefghijklmnopqrstuvwxyz",
  };
  const documents = generateAgentContext(root, { write: false, env, featureDefinitions: [definition()], changedFiles: [], claim: "docs" });
  const serialized = JSON.stringify(documents);
  assert.equal(documents.state.project.environment.VITE_SUPABASE_URL, "configured");
  assert.equal(documents.state.project.environment.VITE_SUPABASE_PUBLISHABLE_KEY, "configured");
  assert.doesNotMatch(serialized, /private-project|sb_secret_NOT_ALLOWED|invite-secret/);
});

test("JSON documents satisfy the stable read-layer shape", () => {
  const root = fixture();
  minimalPackage(root);
  const documents = generateAgentContext(root, { write: false, env: { SOURCE_DATE_EPOCH: "1700000000", AGENT_OFFLINE: "1" }, featureDefinitions: [definition()], changedFiles: [], claim: "docs" });
  for (const [kind, value] of [["manifest", documents.manifest], ["architecture", documents.architecture], ["invariants", documents.invariants], ["featureMap", documents.featureMap], ["state", documents.state]]) {
    assert.deepEqual(validateAgentData(kind, value), []);
  }
  assert.ok(documents.schema.mcpCompatibility.includes("project.get_feature_status"));
});

test("state generation is deterministic for a revision clock", () => {
  const root = fixture();
  minimalPackage(root);
  const options = { write: false, env: { SOURCE_DATE_EPOCH: "1700000000", AGENT_OFFLINE: "1" }, featureDefinitions: [definition()], changedFiles: [], claim: "docs" };
  const first = generateAgentContext(root, options).state;
  const second = generateAgentContext(root, options).state;
  assert.deepEqual(second, first);
  assert.equal(first.generatedAt, "2023-11-14T22:13:20.000Z");
});

test("production migration state stays unknown without a live check", () => {
  const root = fixture();
  minimalPackage(root);
  put(root, "supabase/migrations/0001_first.sql");
  const { state } = generateAgentContext(root, { write: false, env: { SOURCE_DATE_EPOCH: "1700000000", AGENT_OFFLINE: "1" }, featureDefinitions: [], changedFiles: [], claim: "docs" });
  assert.equal(state.database.productionMigrationHead, "unknown");
  assert.equal(state.database.requiresLiveCheck, true);
  assert.equal(state.database.productionMigrationExpectation, "0001");
});

test("feature query returns evidence and missing requirements", () => {
  const root = fixture();
  put(root, "src/demo.ts", "execute");
  const map = scanFeatures(root, [definition()]);
  const found = queryFeature(map, "demo");
  assert.equal(found.status, "partial");
  assert.deepEqual(found.evidence.source, ["src/demo.ts"]);
  assert.match(found.missing.join(" "), /tests/);
});

test("real CLI feature query emits machine-readable JSON", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const execution = spawnSync(process.execPath, ["scripts/agent-context.mjs", "--feature", "video-review"], {
    cwd: root, encoding: "utf8", env: { ...process.env, AGENT_OPEN_PRS_JSON: "[]" }, windowsHide: true,
  });
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.feature, "video-review");
  assert.ok(Array.isArray(result.relatedFiles));
  assert.ok(Array.isArray(result.tests));
});

test("git clean and dirty state are recognized", () => {
  const root = fixture();
  const invoke = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(invoke(["init"]).status, 0);
  assert.equal(invoke(["config", "user.email", "agent@example.invalid"]).status, 0);
  assert.equal(invoke(["config", "user.name", "Agent Test"]).status, 0);
  put(root, "tracked.txt", "one");
  assert.equal(invoke(["add", "tracked.txt"]).status, 0);
  assert.equal(invoke(["commit", "-m", "initial"]).status, 0);
  assert.equal(inspectGit(root).dirty, false);
  put(root, "tracked.txt", "two");
  assert.equal(inspectGit(root).dirty, true);
});

test("critical invariant violations fail the gate", () => {
  const root = fixture();
  minimalPackage(root);
  put(root, "src/cloud/invite.ts", "const source = location.hash + location.search; const invite = /invite/.exec(source);");
  put(root, "src/cloud/videoAssets.ts", "MUTATE_ORIGINAL_MEDIA");
  put(root, "supabase/migrations/0001_bad.sql", "insert into storage.buckets (id,name,public) values ('room-assets','room-assets',true);");
  put(root, "supabase/migrations/0007_room_capabilities.sql", "reviewer can_manage_media");
  put(root, "scripts/e2e/migrations.mjs", "reviewer delete");
  const checks = checkCriticalInvariants(root);
  assert.equal(checks.find((check) => check.code === "INVITE_FRAGMENT_ONLY")?.ok, false);
  assert.equal(checks.find((check) => check.code === "ROOM_ASSETS_PRIVATE")?.ok, false);
  assert.equal(checks.find((check) => check.code === "ORIGINAL_MEDIA_IMMUTABLE")?.ok, false);
  const gate = evaluateGate(root, { runBuild: false, changedFiles: ["src/cloud/invite.ts"], claim: "security fix" });
  assert.equal(gate.status, "FAIL");
  assert.equal(gate.automergeAllowed, false);
});

test("secret scan rejects materialized token values", () => {
  const root = fixture();
  put(root, ".agent/state.json", JSON.stringify({ leaked: "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890" }));
  const check = findSecretLeaks(root, []);
  assert.equal(check.ok, false);
  assert.match(check.details.join(" "), /GitHub token/);
});
