import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isAppOriginApiPath, shouldSpaFallback } from "../../src/cloud/spaFallback.ts";
import {
  isAppOriginApiPath as originIsApiPath,
  listenOrigin,
  ORIGIN_API_NOT_FOUND,
} from "../serve-origin.mjs";

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

test("zbpack must start the origin server, not static dist (Vite would SPA-fallback)", () => {
  const zbpack = JSON.parse(readFileSync(resolve(ROOT, "zbpack.json"), "utf8")) as {
    output_dir?: string;
    start_command?: string;
  };
  assert.equal(zbpack.output_dir, undefined, "output_dir makes Zeabur ignore start_command and catch-all HTML");
  assert.equal(zbpack.start_command, "node scripts/serve-origin.mjs");
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.start, "node scripts/serve-origin.mjs");
});

test("origin server and client spaFallback agree on API prefixes", () => {
  for (const path of API_PATHS) {
    assert.equal(originIsApiPath(path), isAppOriginApiPath(path), path);
  }
  for (const path of SPA_PATHS) {
    assert.equal(originIsApiPath(path), isAppOriginApiPath(path), path);
  }
});

test("origin server returns JSON 404 for /functions /api /rest; SPA for client routes", async () => {
  const fixture = resolve(ROOT, "output", "origin-fixture");
  rmSync(fixture, { recursive: true, force: true });
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "index.html"), "<!doctype html><title>spa</title>");
  writeFileSync(join(fixture, "ok.js"), "export default 1");
  const server = await listenOrigin({ root: fixture, port: 0, host: "127.0.0.1" });
  const port = (server.address() as { port: number }).port;
  try {
    const get = async (path: string, method = "GET") => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
      return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
    };
    for (const path of API_PATHS) {
      const jsonGet = await get(path);
      assert.equal(jsonGet.status, 404, path);
      assert.match(jsonGet.type, /application\/json/);
      assert.equal(jsonGet.body, ORIGIN_API_NOT_FOUND);
      assert.doesNotMatch(jsonGet.body, /<!doctype html>/i);
      const jsonPost = await get(path, "POST");
      assert.equal(jsonPost.status, 404, `POST ${path}`);
      assert.match(jsonPost.type, /application\/json/);
    }
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.match(home.type, /text\/html/);
    assert.match(home.body, /<!doctype html>/i);
    const login = await get("/login");
    assert.equal(login.status, 200);
    assert.match(login.body, /<!doctype html>/i);
    const asset = await get("/ok.js");
    assert.equal(asset.status, 200);
    assert.match(asset.type, /javascript/);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("public/_redirects is a static-host fallback for the same prefixes", () => {
  const redirects = readFileSync(resolve(ROOT, "public/_redirects"), "utf8");
  const json = readFileSync(resolve(ROOT, "public/app-origin-api-404.json"), "utf8");
  assert.match(redirects, /\/functions/);
  assert.match(redirects, /\/api/);
  assert.match(redirects, /\/rest/);
  assert.match(redirects, / 404/);
  assert.equal(JSON.parse(json).ok, false);
  assert.equal(JSON.parse(json).code, "NOT_FOUND");
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
