#!/usr/bin/env node
/**
 * Cloud deployment readiness check (PR #16).
 *
 * A production build without VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY
 * cannot create permanent share links — the exact failure that shipped legacy
 * `#room=<6碼>` URLs to real phones. `npm run build` prints a loud warning in
 * that case; deployment pipelines should run this with `--strict` so the build
 * fails instead of shipping a share-less app.
 *
 * Values are read the same way Vite reads them (process env + .env files) and
 * are never printed: only a masked fingerprint, so logs stay safe to paste.
 */
import { loadEnv } from "vite";

const strict = process.argv.includes("--strict") || process.env.REQUIRE_CLOUD_ENV === "1";
const mode = process.env.NODE_ENV === "development" ? "development" : "production";
const env = loadEnv(mode, process.cwd(), "VITE_");

const url = (env.VITE_SUPABASE_URL ?? "").trim();
const key = (env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

const PLACEHOLDER = /^(your|<|change[-_]?me|todo|example|placeholder|xxx)/i;
const issues = [];

if (!url) issues.push("VITE_SUPABASE_URL is not set");
else if (PLACEHOLDER.test(url)) issues.push("VITE_SUPABASE_URL is still a template placeholder");
else {
  try {
    const parsed = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !local)
      issues.push("VITE_SUPABASE_URL must use https (http is only allowed for a local Supabase stack)");
  } catch {
    issues.push("VITE_SUPABASE_URL is not a valid URL");
  }
}

if (!key) issues.push("VITE_SUPABASE_PUBLISHABLE_KEY is not set");
else if (PLACEHOLDER.test(key)) issues.push("VITE_SUPABASE_PUBLISHABLE_KEY is still a template placeholder");
else if (key.length < 20 || /\s/.test(key)) issues.push("VITE_SUPABASE_PUBLISHABLE_KEY does not look like a publishable key");
else if (key.startsWith("sb_secret_") || key.includes("service_role"))
  issues.push("VITE_SUPABASE_PUBLISHABLE_KEY looks like a service-role key — never ship that to the browser");

/** Enough to tell two keys apart in a log, not enough to be a key. */
const mask = (v) => (v ? `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)` : "(unset)");

if (issues.length === 0) {
  console.log(`✔ cloud env ready — url=${url} key=${mask(key)}`);
  process.exit(0);
}

const lines = [
  "",
  "  Cloud env is NOT ready. Permanent share links (#room=<uuid>&invite=<token>)",
  "  cannot be created by this build; the app will tell users sharing is unavailable.",
  "",
  ...issues.map((i) => `  ✖ ${i}`),
  "",
  `  url=${url || "(unset)"}  key=${mask(key)}`,
  "  Set both in the deployment platform's env (Zeabur / Vercel / CI) and rebuild.",
  "",
];

if (strict) {
  console.error(lines.join("\n"));
  process.exit(1);
}
console.warn(lines.join("\n"));
process.exit(0);
