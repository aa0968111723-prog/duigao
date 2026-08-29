#!/usr/bin/env node
/**
 * Two Playwright contexts: offline discussion enqueue then online flush
 * lands exactly one row (no duplicate replay).
 *
 * Usage: npm run test:realtime-offline-e2e
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { rows, start as startMock } from "./mock-supabase.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = 54428;
const APP_PORT = 4198;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed. Run: npm install && npx playwright install chromium");
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
      res.writeHead(200, { "content-type": {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json",
      }[extname(file)] ?? "application/octet-stream" });
      res.end(buffer);
    } catch {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await read(join(root, "index.html")));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-rt-"));
const dist = join(tempRoot, "cloud");
let mock;
let app;
let browser;

try {
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
  mock = await startMock(MOCK_PORT);
  app = await serveStatic(dist, APP_PORT);
  browser = await chromium.launch(browserOptions());

  const ctxA = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
  });
  const ctxB = await browser.newContext({
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
  });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto(APP, { waitUntil: "domcontentloaded" });
  await pageA.fill("input.text-input", "A 編輯");
  await pageA.click("button.btn-primary");
  await pageA.waitForSelector(".home-picks", { timeout: 20000 });
  await pageA.getByRole("button", { name: /建立活動房/ }).click();
  await pageA.waitForSelector('[data-testid="discussion-feed"]', { timeout: 15000 });

  const roomUrl = pageA.url();
  await pageB.goto(roomUrl, { waitUntil: "domcontentloaded" });
  if (await pageB.locator("input.text-input").count()) {
    await pageB.fill("input.text-input", "B 檢視");
    await pageB.click("button.btn-primary");
  }
  await pageB.waitForSelector('[data-testid="discussion-feed"]', { timeout: 20000 });

  await ctxA.setOffline(true);
  await pageA.getByLabel("房間討論").fill("離線只該落地一次");
  await pageA.locator(".rd-composer").getByRole("button", { name: "送出" }).click();
  const ghost = await pageA.waitForFunction(
    () => document.querySelector('[data-testid="discussion-feed"]')?.textContent?.includes("離線只該落地一次") ?? false,
    null,
    { timeout: 15000 },
  ).then(() => true).catch(() => false);
  check("A 離線：訊息以 ghost 顯示", ghost);

  await ctxA.setOffline(false);
  const landDeadline = Date.now() + 40000;
  let msgRows = 0;
  while (Date.now() < landDeadline) {
    msgRows = rows.room_discussion_messages.filter((row) => row.body === "離線只該落地一次").length;
    if (msgRows >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check("回網 flush：恰好一列（無重複 replay）", msgRows === 1, `rows=${msgRows}`);

  const bSees = await pageB.waitForFunction(
    () => document.querySelector('[data-testid="discussion-feed"]')?.textContent?.includes("離線只該落地一次") ?? false,
    null,
    { timeout: 20000 },
  ).then(() => true).catch(() => false);
  check("B 不重開就看到 A 回網後的那一則", bSees);

  await ctxA.setOffline(true);
  await pageA.getByLabel("房間討論").fill("第二則離線");
  await pageA.locator(".rd-composer").getByRole("button", { name: "送出" }).click();
  await pageA.waitForTimeout(400);
  await ctxA.setOffline(false);
  const secondDeadline = Date.now() + 40000;
  let second = 0;
  while (Date.now() < secondDeadline) {
    second = rows.room_discussion_messages.filter((row) => row.body === "第二則離線").length;
    if (second >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const firstStill = rows.room_discussion_messages.filter((row) => row.body === "離線只該落地一次").length;
  check("第二則回網也恰好一列", second === 1, `rows=${second}`);
  check("第一則不會因第二次 flush 再寫一次", firstStill === 1, `first=${firstStill}`);
} catch (error) {
  console.error(error);
  results.push({ name: "harness", pass: false });
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve, reject) => app?.close((err) => (err ? reject(err) : resolve())) ?? resolve());
  await mock?.close?.().catch(() => undefined);
}

const failed = results.filter((item) => !item.pass).length;
console.log(`\n${results.filter((item) => item.pass).length}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
