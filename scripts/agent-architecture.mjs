import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { architectureDefinitions } from "./agent-config.mjs";
import { GENERATED_NOTICE, SCHEMA_VERSION, listFiles, normalizePath } from "./agent-lib.mjs";

function existingPaths(root, candidates) {
  return candidates.filter((path) => existsSync(resolve(root, path))).map(normalizePath);
}

export function buildArchitecture(root) {
  const components = architectureDefinitions
    .map((definition) => ({
      name: definition.name,
      path: existingPaths(root, definition.paths),
      responsibility: definition.responsibility,
      dependsOn: definition.dependsOn,
    }))
    .filter((component) => component.path.length > 0);
  return { schemaVersion: SCHEMA_VERSION, generated: GENERATED_NOTICE, components };
}

export function buildManifest(root, architecture = buildArchitecture(root)) {
  const packagePath = resolve(root, "package.json");
  const pkg = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")) : { scripts: {} };
  const testCommands = Object.keys(pkg.scripts ?? {}).filter((name) => name.startsWith("test:")).sort().map((name) => `npm run ${name}`);
  const paths = architecture.components.flatMap((component) => component.path);
  return {
    schemaVersion: SCHEMA_VERSION,
    project: "duigao",
    product: "圖片與影片對稿協作工具",
    primaryLanguage: "zh-Hant",
    frontend: { framework: "React", build: "Vite", language: "TypeScript" },
    cloud: { provider: "Supabase", sourceOfTruth: "Postgres", cache: "IndexedDB", realtime: true },
    workspaces: {
      image: paths.includes("src/features/image-review") ? "src/features/image-review" : null,
      video: paths.includes("src/features/video-review") ? "src/features/video-review" : null,
      discussion: paths.includes("src/features/discussion") ? "src/features/discussion" : null,
    },
    criticalPaths: [...new Set(paths)].sort(),
    testCommands,
    packageScripts: Object.keys(pkg.scripts ?? {}).sort(),
    agentContextCommand: "npm run agent:context",
  };
}

export function buildInvariants() {
  return {
    schemaVersion: SCHEMA_VERSION,
    invariants: [
      { id: "original-media-immutable", severity: "critical", rule: "Original image/video must never be modified.", enforcement: ["source review", "E2E", "agent gate"] },
      { id: "invite-fragment-only", severity: "critical", rule: "Invite secret may only exist in URL fragment.", enforcement: ["src/cloud/invite.ts", "agent gate"] },
      { id: "room-assets-private", severity: "critical", rule: "room-assets must remain private.", enforcement: ["Supabase migration", "RLS E2E", "agent gate"] },
      { id: "reviewer-no-media-management", severity: "critical", rule: "Reviewer cannot upload/replace/delete versions.", enforcement: ["room capability RLS", "migration E2E", "agent gate"] },
      { id: "feature-pr-not-docs-only", severity: "critical", rule: "Feature implementation PR cannot contain only docs.", enforcement: ["agent gate", "GitHub Actions"] },
      { id: "cloud-source-of-truth", severity: "high", rule: "Supabase is the cloud source of truth; IndexedDB is cache/offline only.", enforcement: ["architecture review"] },
      { id: "reviewer-progressive-disclosure", severity: "high", rule: "Reviewer UX stays minimal; deep features use progressive disclosure.", enforcement: ["UI review", "browser E2E"] },
      { id: "workspaces-separated", severity: "high", rule: "Image and video workspaces remain separate.", enforcement: ["architecture scan", "browser E2E"] },
    ],
  };
}

export function buildSchema() {
  const evidence = { type: "object", required: ["source", "migrations", "tests", "docs"], properties: Object.fromEntries(["source", "migrations", "tests", "docs"].map((key) => [key, { type: "array", items: { type: "string" } }])) };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://duigao.local/.agent/schema.json",
    title: "duigao Agent Read Layer",
    schemaVersion: SCHEMA_VERSION,
    definitions: {
      featureStatus: { enum: ["implemented", "partial", "spec_only", "missing", "deprecated"] },
      feature: { type: "object", required: ["id", "status", "evidence", "confidence", "notes"], properties: { id: { type: "string" }, status: { $ref: "#/definitions/featureStatus" }, evidence, confidence: { type: "number", minimum: 0, maximum: 1 }, notes: { type: "array", items: { type: "string" } } } },
      state: { type: "object", required: ["schemaVersion", "generatedAt", "git", "project", "features", "database", "tests", "knownGaps", "warnings", "releaseReadiness", "nextRecommendedWork"] },
    },
    mcpCompatibility: [
      "project.get_overview", "project.get_feature_status", "project.get_architecture", "project.get_database_state",
      "project.get_open_work", "project.get_invariants", "project.get_related_files", "project.get_test_requirements", "project.get_release_readiness",
    ],
  };
}

function isDirectRun() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isDirectRun()) console.log(JSON.stringify(buildArchitecture(process.cwd()), null, 2));
