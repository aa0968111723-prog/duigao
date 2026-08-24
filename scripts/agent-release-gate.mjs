import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, listFiles, normalizePath, packageManagerCommand, run } from "./agent-lib.mjs";
import { scanFeatures } from "./agent-feature-scan.mjs";

const EXECUTABLE_PREFIXES = ["src/", "scripts/", "supabase/", ".github/"];
const DOC_PATTERN = /(^docs\/|\.md$)/i;
const CLAIM_PATTERN = /\b(feature|feat|fix|security|implementation|implement|功能|修復|安全|實作)\b/i;
const DATABASE_CLAIM = /\b(database|schema|migration|rls|postgres|supabase|資料庫|遷移|權限)\b/i;
const UI_CLAIM = /\b(ui|ux|component|screen|workspace|介面|畫面|元件|工作區)\b/i;
const SECURITY_CLAIM = /\b(security|secure|rls|policy|acl|auth|安全|權限)\b/i;

function result(code, ok, message, details = []) {
  return { code, ok, message, details };
}

export function inspectChangedFiles(root, override) {
  if (override) return [...new Set(override.map(normalizePath))].sort();
  if (process.env.AGENT_CHANGED_FILES) {
    try {
      const parsed = JSON.parse(process.env.AGENT_CHANGED_FILES);
      if (Array.isArray(parsed)) return [...new Set(parsed.map(normalizePath))].sort();
    } catch {
      return [...new Set(process.env.AGENT_CHANGED_FILES.split(/\r?\n/).filter(Boolean).map(normalizePath))].sort();
    }
  }
  const committed = git(root, ["diff", "--name-only", "origin/main...HEAD"]);
  const working = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  const paths = committed.ok ? committed.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (working.ok) {
    for (const line of working.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const raw = line.slice(3).trim();
      paths.push(raw.includes(" -> ") ? raw.split(" -> ").at(-1) : raw);
    }
  }
  return [...new Set(paths.map(normalizePath))].sort();
}

export function checkClaimedChange({ changedFiles, claim }) {
  const checks = [];
  const claimedImplementation = CLAIM_PATTERN.test(claim);
  const docsOnly = changedFiles.length > 0 && changedFiles.every((path) => DOC_PATTERN.test(path));
  if (claimedImplementation && docsOnly) {
    checks.push(result("FEATURE_IMPLEMENTATION_REQUIRED", false, "This change claims to implement functionality, but no executable source / migration / test files changed.", changedFiles));
  } else checks.push(result("DOCS_ONLY_PROTECTION", true, "Implementation claims include executable evidence or the change is documentation-only by intent."));

  if (DATABASE_CLAIM.test(claim) && !changedFiles.some((path) => path.startsWith("supabase/migrations/") && path.endsWith(".sql"))) {
    checks.push(result("MIGRATION_REQUIRED", false, "A database feature claim requires a Supabase migration."));
  }
  if (UI_CLAIM.test(claim) && !changedFiles.some((path) => path.startsWith("src/"))) {
    checks.push(result("SOURCE_IMPLEMENTATION_REQUIRED", false, "A UI feature claim requires an executable src/** change."));
  }
  if (SECURITY_CLAIM.test(claim)) {
    const securityEvidence = changedFiles.some((path) => /(^|\/)(test|tests|e2e)(\/|\.)|supabase\/migrations\/|policy|acl/i.test(path));
    if (!securityEvidence) checks.push(result("SECURITY_EVIDENCE_REQUIRED", false, "A security fix requires test, migration, policy, or ACL evidence."));
  }
  return checks;
}

export function checkMigrationOrder(root) {
  const directory = resolve(root, "supabase/migrations");
  if (!existsSync(directory)) return result("MIGRATION_ORDER", false, "supabase/migrations is missing.");
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const invalid = files.filter((name) => !/^\d{4}_[a-z0-9_]+\.sql$/i.test(name));
  const numbers = files.map((name) => Number(name.slice(0, 4)));
  const duplicates = numbers.filter((number, index) => numbers.indexOf(number) !== index);
  const outOfOrder = numbers.some((number, index) => index > 0 && number <= numbers[index - 1]);
  const gaps = numbers.filter((number, index) => index > 0 && number !== numbers[index - 1] + 1);
  const details = [
    ...invalid.map((name) => `invalid name: ${name}`),
    ...duplicates.map((number) => `duplicate prefix: ${String(number).padStart(4, "0")}`),
    ...(outOfOrder ? ["numeric migration order is not strictly increasing"] : []),
    ...gaps.map((number) => `gap before ${String(number).padStart(4, "0")}`),
  ];
  return result("MIGRATION_ORDER", details.length === 0, details.length ? "Migration naming/order is invalid." : `Migration order is contiguous through ${files.at(-1) ?? "none"}.`, details);
}

export function checkRequiredScripts(root) {
  const packagePath = resolve(root, "package.json");
  if (!existsSync(packagePath)) return result("REQUIRED_TEST_SCRIPTS", false, "package.json is missing.");
  const scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts ?? {};
  const required = ["build", "build:local", "test:share-e2e", "test:share-preview", "test:video", "test:migrations", "test:agent", "agent:context", "agent:query", "agent:gate", "agent:state"];
  const missing = required.filter((name) => !scripts[name]);
  return result("REQUIRED_TEST_SCRIPTS", missing.length === 0, missing.length ? "Required build/test/agent scripts are missing." : "Required build, E2E, migration, and agent scripts exist.", missing);
}

export function checkCriticalInvariants(root) {
  const checks = [];
  const invite = existsSync(resolve(root, "src/cloud/invite.ts")) ? readFileSync(resolve(root, "src/cloud/invite.ts"), "utf8") : "";
  const fragmentOnly = /const\s+inviteSource\s*=\s*location\.hash/.test(invite)
    && /invite[^\n]*exec\(inviteSource\)/.test(invite)
    && !/invite[^\n]*exec\([^)]*location\.search/.test(invite);
  checks.push(result("INVITE_FRAGMENT_ONLY", fragmentOnly, fragmentOnly ? "Invite secrets are built and parsed from the URL fragment only." : "Invite parsing can read a secret outside location.hash."));

  const migrations = listFiles(root, ["supabase/migrations"], [".sql"]).map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
  const privateInsert = /insert\s+into\s+storage\.buckets[\s\S]{0,180}values\s*\(\s*'room-assets'\s*,\s*'room-assets'\s*,\s*false/i.test(migrations);
  const widened = /update\s+storage\.buckets\s+set\s+public\s*=\s*true\s+where\s+id\s*=\s*'room-assets'/i.test(migrations);
  checks.push(result("ROOM_ASSETS_PRIVATE", privateInsert && !widened, privateInsert && !widened ? "room-assets is created private and no migration widens it." : "room-assets private-bucket expectation is absent or contradicted."));

  const capability = existsSync(resolve(root, "supabase/migrations/0007_room_capabilities.sql")) ? readFileSync(resolve(root, "supabase/migrations/0007_room_capabilities.sql"), "utf8") : "";
  const migrationTest = existsSync(resolve(root, "scripts/e2e/migrations.mjs")) ? readFileSync(resolve(root, "scripts/e2e/migrations.mjs"), "utf8") : "";
  const reviewerBlocked = /can_manage_media/i.test(capability) && /reviewer/i.test(capability) && /reviewer/i.test(migrationTest) && /delete|upload|archive/i.test(migrationTest);
  checks.push(result("REVIEWER_NO_MEDIA_MANAGEMENT", reviewerBlocked, reviewerBlocked ? "Capability policy and migration E2E cover reviewer media denial." : "Reviewer media-management denial lacks policy or test evidence."));

  const productSource = listFiles(root, ["src"], [".ts", ".tsx"]).map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
  const explicitMutation = /MUTATE_ORIGINAL_MEDIA|\.move\([^)]*original\.|\.update\([^)]*original\./i.test(productSource);
  const versionedOriginals = /original\.\$\{ext\}/.test(productSource) && /crypto\.randomUUID\(\)/.test(productSource);
  checks.push(result("ORIGINAL_MEDIA_IMMUTABLE", versionedOriginals && !explicitMutation, versionedOriginals && !explicitMutation ? "Uploads create version-addressed originals and no original mutation API was detected." : "Original-media immutability evidence is missing or contradicted."));
  return checks;
}

export function findSecretLeaks(root, changedFiles) {
  const candidates = [...new Set([
    ...listFiles(root, [".agent"], [".json"]),
    ...changedFiles.filter((path) => /\.(json|mjs|js|ts|tsx|yml|yaml|md|sql)$/i.test(path) && existsSync(resolve(root, path))),
  ])];
  const patterns = [
    { name: "Supabase secret key", regex: /sb_secret_[A-Za-z0-9_-]{12,}/g },
    { name: "GitHub token", regex: /(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/g },
    { name: "OpenAI key", regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
    { name: "JWT value", regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { name: "invite token value", regex: /["']invite["']\s*:\s*["'][A-Za-z0-9_-]{24,}["']/gi },
  ];
  const leaks = [];
  for (const path of candidates) {
    const text = readFileSync(resolve(root, path), "utf8");
    for (const pattern of patterns) if (pattern.regex.test(text)) leaks.push(`${path}: ${pattern.name}`);
  }
  return result("SECRETS_NOT_EMITTED", leaks.length === 0, leaks.length ? "Secret-like values were found in agent output or changed files." : "No secret, access token, JWT, or invite-token value was emitted.", leaks);
}

export function checkFeatureEvidence(root, changedFiles) {
  const map = scanFeatures(root);
  const failures = map.features.filter((feature) => feature.status === "partial" && feature.evidence.source.some((path) => changedFiles.includes(path)) && feature.evidence.tests.length === 0);
  return result("SOURCE_TEST_EVIDENCE", failures.length === 0, failures.length ? "Changed feature source lacks corresponding test evidence." : "Changed feature source/test evidence is consistent.", failures.map((feature) => feature.id));
}

export function evaluateGate(root, options = {}) {
  const changedFiles = inspectChangedFiles(root, options.changedFiles);
  const branch = git(root, ["branch", "--show-current"]);
  const claim = [options.claim, process.env.AGENT_CHANGE_TYPE, process.env.AGENT_PR_TITLE, branch.stdout]
    .filter(Boolean)
    .join(" ");
  const checks = [
    ...checkClaimedChange({ changedFiles, claim }),
    checkRequiredScripts(root),
    checkMigrationOrder(root),
    ...checkCriticalInvariants(root),
    findSecretLeaks(root, changedFiles),
    checkFeatureEvidence(root, changedFiles),
  ];
  if (options.runBuild !== false) {
    const build = process.platform === "win32"
      ? run(root, process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm run build:local"])
      : run(root, packageManagerCommand(), ["run", "build:local"]);
    checks.push(result("TYPESCRIPT_AND_BUILD", build.ok, build.ok ? "TypeScript compile and Vite build passed." : "TypeScript compile or Vite build failed.", [build.stdout, build.stderr, build.error].filter(Boolean)));
  } else checks.push(result("TYPESCRIPT_AND_BUILD", true, "Build execution skipped for structural evaluation.", ["not_run"]));
  const failed = checks.filter((check) => !check.ok);
  return {
    status: failed.length ? "FAIL" : "PASS",
    automergeAllowed: failed.length === 0,
    rule: "AUTOMERGE REQUIRES AGENT_GATE_PASS",
    claim,
    changedFiles,
    checks,
    failures: failed.map((check) => check.code),
  };
}

function printGate(gate) {
  console.log("=== DUIGAO AGENT RELEASE GATE ===");
  for (const check of gate.checks) {
    console.log(`${check.ok ? "✓" : "✗"} ${check.code}: ${check.message}`);
    for (const detail of check.details ?? []) if (detail) console.log(`  ${detail}`);
  }
  console.log(`\n${gate.status}: ${gate.rule}`);
}

const direct = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (direct) {
  const gate = evaluateGate(process.cwd());
  printGate(gate);
  if (gate.status !== "PASS") process.exitCode = 1;
}
