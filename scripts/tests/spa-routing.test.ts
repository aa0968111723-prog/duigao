import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isAppOriginApiPath, shouldSpaFallback } from "../../src/cloud/spaFallback.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const API_PATHS = [
  "/functions/v1/voice-token",
  "/functions/v1/canva-bridge",
  "/api/voice-token",
  "/api/health",
  "/rest/v1/rooms",
];

const SPA_PATHS = ["/", "/login", "/room/test"];

test("API prefixes on the app origin are not SPA pages", () => {
  for (const path of API_PATHS) {
    assert.equal(isAppOriginApiPath(path), true, path);
    assert.equal(shouldSpaFallback(path), false, path);
  }
  for (const path of SPA_PATHS) {
    assert.equal(isAppOriginApiPath(path), false, path);
    assert.equal(shouldSpaFallback(path), true, path);
  }
});

test("vercel.json must not rewrite API prefixes to index.html", () => {
  const vercel = JSON.parse(readFileSync(resolve(ROOT, "vercel.json"), "utf8")) as {
    rewrites?: Array<{ source: string; destination: string }>;
  };
  const rewrites = vercel.rewrites ?? [];
  assert.ok(rewrites.length > 0, "SPA client routes still need a rewrite");
  for (const rule of rewrites) {
    assert.notEqual(
      rule.source,
      "/(.*)",
      "unconditional /(.*) rewrite turns /functions/v1/voice-token into 200 HTML",
    );
    if (rule.destination === "/index.html") {
      assert.match(
        rule.source,
        /api|functions|rest/,
        "SPA rewrite must explicitly exclude backend prefixes",
      );
    }
  }
  const blob = JSON.stringify(vercel);
  assert.doesNotMatch(blob, /"\/\(\.\*\)"/);
});

test("Caddyfile returns JSON 404 for app-origin API prefixes, not index.html", () => {
  const caddy = readFileSync(resolve(ROOT, "Caddyfile"), "utf8");
  assert.match(caddy, /\/functions/);
  assert.match(caddy, /\/api/);
  assert.match(caddy, /\/rest/);
  assert.match(caddy, /404/);
  assert.match(caddy, /application\/json/);
  const backendBlock = caddy.slice(caddy.search(/@backend|handle @backend/), caddy.search(/handle \{/));
  assert.doesNotMatch(backendBlock, /index\.html/);
});
