#!/usr/bin/env npx tsx
/**
 * Room-shell voice honesty at 390 and 768.
 * not-configured / permission-denied / connection-failed must never say 已連線.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { start as startMock } from "./mock-supabase.mjs";
import { voiceUnavailableReason } from "../../src/features/collaboration/voice.ts";
import { voicePhaseMessage as phaseMessage } from "../../src/features/voice/voiceState.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = Number(process.env.DUIGAO_VOICE_MOCK_PORT || 54448);
const APP_PORT = Number(process.env.DUIGAO_VOICE_APP_PORT || 4218);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const ARTIFACTS = process.env.DUIGAO_VOICE_ARTIFACTS || "/opt/cursor/artifacts";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed.");
  process.exit(2);
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function browserOptions() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  return {};
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
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

function deniedDockHtml() {
  const notConfigured = voiceUnavailableReason();
  const permission = phaseMessage("permission-denied");
  const failed = phaseMessage("connection-failed");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>voice honesty dock</title>
  <style>
    :root { --panel:#fff; --ink:#192237; --ink-faint:#8c94a6; --ink-soft:#70798d; --danger:#d74f68; --line:rgba(0,0,0,.15); --line-faint:rgba(0,0,0,.08); --bg:#f7f8fc; }
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--ink); }
    .label { font-size:11px; color:var(--ink-faint); padding:8px 12px 0; }
    .rd-voice-note { margin:0 0 10px; padding:8px 12px; border-radius:10px; background:var(--panel); color:var(--ink-faint); font-size:12px; }
    .rd-voice-dock { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 12px; font-size:13px; color:var(--ink-soft); border-bottom:1px solid var(--line-faint); background:var(--panel); }
    .rd-voice-btn { min-height:32px; padding:4px 12px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; }
    .rd-voice-error { color:var(--danger); width:100%; }
  </style>
</head>
<body>
  <p class="label">not-configured</p>
  <div class="rd-voice-note" data-testid="voice-boundary">${notConfigured}</div>
  <p class="label">permission-denied</p>
  <div class="rd-voice-dock" data-testid="voice-dock-permission">
    <span>語音房間</span>
    <button type="button" class="rd-voice-btn" data-testid="voice-join">開始語音</button>
    <span class="rd-voice-error" role="alert">${permission}</span>
  </div>
  <p class="label">connection-failed</p>
  <div class="rd-voice-dock" data-testid="voice-dock-failed">
    <span>語音房間</span>
    <button type="button" class="rd-voice-btn" data-testid="voice-join-failed">開始語音</button>
    <span class="rd-voice-error" role="alert">${failed}</span>
  </div>
</body>
</html>`;
}

async function openRoom(browser, width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: width < 768,
    hasTouch: true,
    userAgent: ANDROID_UA,
  });
  const page = await context.newPage();
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", "語音誠實");
  await page.click("button.btn-primary");
  await page.waitForSelector(".home-picks", { timeout: 20000 });
  await page.getByRole("button", { name: /建立活動房/ }).click();
  await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 15000 });
  return { context, page };
}

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-voice-honesty-"));
const dist = join(tempRoot, "cloud");
let mock;
let app;
let browser;

try {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(join(ARTIFACTS, "voice-honesty-dock.html"), deniedDockHtml(), "utf8");

  console.log("building the app against the mock…");
  execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], {
    cwd: ROOT,
    stdio: "pipe",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_mock_key_000000",
    },
  });
  writeFileSync(join(dist, "voice-honesty-dock.html"), deniedDockHtml(), "utf8");

  mock = await startMock(MOCK_PORT);
  app = await serveStatic(dist, APP_PORT);
  browser = await chromium.launch(browserOptions());

  for (const { width, height } of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
  ]) {
    const { context, page } = await openRoom(browser, width, height);
    await page.waitForSelector('[data-testid="voice-boundary"]', { timeout: 15000 });
    const boundary = await page.getByTestId("voice-boundary").innerText();
    check(`${width} not-configured boundary has 尚未設定`, /尚未設定/.test(boundary), boundary.slice(0, 80));
    check(`${width} not-configured does not say 已連線`, !/已連線/.test(boundary), boundary.slice(0, 80));
    await page.screenshot({
      path: join(ARTIFACTS, `voice-honesty-not-configured-${width}.png`),
      fullPage: false,
    });
    await context.close();
  }

  await new Promise((resolve, reject) => mock.close((err) => (err ? reject(err) : resolve())));
  mock = await startMock(MOCK_PORT, { voiceToken: true });

  for (const { width, height } of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
  ]) {
    const { context, page } = await openRoom(browser, width, height);
    await page.waitForSelector('[data-testid="voice-dock"]', { timeout: 20000 });
    await page.getByTestId("voice-join").click();
    const errShown = await page
      .waitForFunction(
        () => document.querySelector(".rd-voice-error")?.textContent?.includes("失敗") ?? false,
        null,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    const errText = await page.locator(".rd-voice-error").innerText().catch(() => "");
    const bodyText = await page.locator("body").innerText();
    check(`${width} connection-failed shows 失敗`, errShown && /失敗/.test(errText), errText.slice(0, 80));
    check(`${width} connection-failed does not say 已連線`, !/已連線/.test(bodyText));
    check(`${width} connection-failed has no Leave`, (await page.getByTestId("voice-leave").count()) === 0);
    await page.screenshot({
      path: join(ARTIFACTS, `voice-honesty-connection-failed-${width}.png`),
      fullPage: false,
    });
    await page.locator(".rd-voice-error").evaluate((el, msg) => {
      el.textContent = msg;
    }, phaseMessage("permission-denied"));
    const deniedText = await page.locator("body").innerText();
    check(`${width} permission-denied copy in room dock never 已連線`, !/已連線/.test(deniedText));
    check(`${width} permission-denied room dock shows 權限被拒`, /權限被拒/.test(deniedText));
    await page.screenshot({
      path: join(ARTIFACTS, `voice-honesty-permission-denied-room-${width}.png`),
      fullPage: false,
    });
    await context.close();
  }

  for (const { width, height } of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: width < 768,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.goto(`${APP}voice-honesty-dock.html`, { waitUntil: "domcontentloaded" });
    const text = await page.locator("body").innerText();
    check(`${width} dock fixture permission-denied is distinct`, text.includes(phaseMessage("permission-denied")));
    check(`${width} dock fixture never says 已連線`, !/已連線/.test(text));
    check(`${width} dock fixture not-configured`, text.includes(voiceUnavailableReason()));
    await page.screenshot({
      path: join(ARTIFACTS, `voice-honesty-permission-denied-${width}.png`),
      fullPage: false,
    });
    await context.close();
  }

  check("permission-denied copy never 已連線", !/已連線/.test(phaseMessage("permission-denied")));
  check("service-not-configured copy never 已連線", !/已連線/.test(phaseMessage("service-not-configured")));
} catch (error) {
  check("voice honesty journey", false, error instanceof Error ? error.stack?.slice(0, 500) : String(error));
} finally {
  await browser?.close();
  if (app) await new Promise((resolve) => app.close(resolve));
  if (mock) await new Promise((resolve) => mock.close(() => resolve()));
  rmSync(tempRoot, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
