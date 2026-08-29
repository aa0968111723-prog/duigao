#!/usr/bin/env node
/**
 * Honest session-entry screenshots: empty-room + permission-denied at 390 and 768.
 * Same mock-supabase + production-bundle stack as mobile-tablet-ux e2e. No PII.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { requestLog, start as startMock } from "./mock-supabase.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = Number(process.env.DUIGAO_SESSION_MOCK_PORT || 54438);
const APP_PORT = Number(process.env.DUIGAO_SESSION_APP_PORT || 4199);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const ARTIFACTS = process.env.SESSION_ENTRY_ARTIFACT_DIR || "/opt/cursor/artifacts";
const ANON = "sb_publishable_e2e_mock_key_000000";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed.");
  process.exit(2);
}

function serveStatic(root, port) {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const file = join(root, normalize(pathname === "/" ? "/index.html" : pathname));
    try {
      const buffer = await read(file);
      res.writeHead(200, {
        "content-type": {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".webmanifest": "application/manifest+json",
        }[extname(file)] ?? "application/octet-stream",
      });
      res.end(buffer);
    } catch {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await read(join(root, "index.html")));
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function browserOptions() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  return {};
}

async function signUpAndCreateEmptyRoom() {
  const signup = await fetch(`${MOCK}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON },
    body: JSON.stringify({ email: "owner-session-entry@example.test", password: "password-ok" }),
  });
  const auth = await signup.json();
  if (!signup.ok) throw new Error(`signup failed: ${JSON.stringify(auth)}`);
  const roomId = crypto.randomUUID();
  const inviteToken = `invite-${crypto.randomUUID().replaceAll("-", "")}`;
  const created = await fetch(`${MOCK}/rest/v1/rpc/create_room_with_invite`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      apikey: ANON,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_room_id: roomId,
      p_title: "空房間對稿",
      p_invite_token: inviteToken,
    }),
  });
  const body = await created.json();
  if (!created.ok) throw new Error(`create room failed: ${JSON.stringify(body)}`);
  return { roomId, inviteToken };
}

async function enterAsGuest(page, url) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("duigao.chrome-first-run.v1", JSON.stringify({ dismissedAt: Date.now() }));
    } catch {
      /* ignore */
    }
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", "訪客甲");
  await page.click("button.btn-primary");
}

async function waitForKind(page, kind) {
  const card = page.locator(`[data-testid="session-entry-status"][data-kind="${kind}"]`);
  await card.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(500);
  const drifted = await page.locator("[data-testid=\"session-entry-status\"]").getAttribute("data-kind");
  if (drifted !== kind) {
    await card.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(400);
  }
  const finalKind = await page.locator("[data-testid=\"session-entry-status\"]").getAttribute("data-kind");
  if (finalKind !== kind) throw new Error(`session-entry kind drifted to ${finalKind}, wanted ${kind}`);
  return card;
}

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-session-"));
const dist = join(tempRoot, "cloud");
let mock;
let app;
let browser;

try {
  mkdirSync(ARTIFACTS, { recursive: true });
  execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], {
    cwd: ROOT,
    stdio: "pipe",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VITE_SUPABASE_URL: MOCK,
      VITE_SUPABASE_PUBLISHABLE_KEY: ANON,
    },
  });
  mock = await startMock(MOCK_PORT);
  app = await serveStatic(dist, APP_PORT);
  const { roomId, inviteToken } = await signUpAndCreateEmptyRoom();
  const guestUrl = `${APP}#room=${roomId}&invite=${inviteToken}`;
  browser = await chromium.launch({ headless: true, ...browserOptions() });
  const results = [];

  for (const width of [390, 768]) {
    const height = width === 390 ? 844 : 1024;
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      isMobile: width < 768,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") console.error("page", msg.type(), msg.text());
    });
    page.on("pageerror", (err) => console.error("pageerror", err.message));
    page.on("requestfailed", (req) => console.error("requestfailed", req.method(), req.url(), req.failure()?.errorText));
    await enterAsGuest(page, guestUrl);
    let card;
    try {
      card = await waitForKind(page, "empty-room");
    } catch (err) {
      const seen = await page.locator("[data-testid=\"session-entry-status\"]").evaluateAll((els) =>
        els.map((el) => ({ kind: el.getAttribute("data-kind"), text: el.textContent })),
      );
      await page.screenshot({ path: join(ARTIFACTS, `session_entry_debug_empty_${width}.png`), fullPage: false });
      console.error("empty-room wait failed", { width, seen, requestLog: requestLog.slice(-40) });
      throw err;
    }
    const text = (await card.innerText()).replace(/\s+/g, " ").trim();
    if (!text.includes("這個房間還沒有文宣或影片")) {
      throw new Error(`empty-room copy missing at ${width}: ${text}`);
    }
    const path = join(ARTIFACTS, `session_entry_empty_room_${width}_honest.png`);
    await page.screenshot({ path, fullPage: false });
    results.push({ kind: "empty-room", width, text, path });
    await ctx.close();
  }

  for (const width of [390, 768]) {
    const height = width === 390 ? 844 : 1024;
    const ctx = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      isMobile: width < 768,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.route("**/rest/v1/rooms*", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          code: "42501",
          message: "new row violates row-level security policy",
        }),
      });
    });
    await enterAsGuest(page, guestUrl);
    const card = await waitForKind(page, "permission-denied");
    const text = (await card.innerText()).replace(/\s+/g, " ").trim();
    if (!text.includes("沒有權限進入這個房間")) {
      throw new Error(`permission-denied copy missing at ${width}: ${text}`);
    }
    if (/invalid invite|邀請連結無效|分享連結無效/.test(text)) {
      throw new Error(`permission-denied leaked invite copy at ${width}: ${text}`);
    }
    const path = join(ARTIFACTS, `session_entry_permission_denied_${width}_honest.png`);
    await page.screenshot({ path, fullPage: false });
    results.push({ kind: "permission-denied", width, text, path });
    await ctx.close();
  }

  writeFileSync(
    join(ARTIFACTS, "session-entry-shots.json"),
    `${JSON.stringify({ roomIdPrefix: roomId.slice(0, 8), results }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => app?.close(() => resolve()));
  await mock?.close?.();
  rmSync(tempRoot, { recursive: true, force: true });
}
