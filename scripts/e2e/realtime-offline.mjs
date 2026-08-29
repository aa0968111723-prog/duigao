#!/usr/bin/env node
/** Two-client discussion sync + offline replay. No second sync system. */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { start as startMock } from "./mock-supabase.mjs";
import { ensureRoomMore } from "./room-more.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = Number(process.env.DUIGAO_RT_MOCK_PORT || 54430);
const APP_PORT = Number(process.env.DUIGAO_RT_APP_PORT || 4200);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const ARTIFACTS = process.env.DUIGAO_UX_ARTIFACTS || "/opt/cursor/artifacts";

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
  mkdirSync(ARTIFACTS, { recursive: true });
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
  const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const A = await ctxA.newPage();
  await A.goto(APP, { waitUntil: "domcontentloaded" });
  await A.fill("input.text-input", "同步甲");
  await A.click("button.btn-primary");
  await A.waitForSelector(".home-picks", { timeout: 20000 });
  await A.getByRole("button", { name: /建立活動房/ }).click();
  await A.waitForSelector('[data-testid="discussion-composer"]', { timeout: 15000 });
  await A.getByTestId("discussion-composer").getByLabel("房間討論").fill("甲先說一句");
  await A.getByTestId("discussion-composer").getByRole("button", { name: "送出" }).click();
  await A.waitForFunction(() => document.querySelector('[data-testid="discussion-feed"]')?.textContent?.includes("甲先說一句"), null, { timeout: 10000 });

  await ensureRoomMore(A);
  await A.locator(".project-share-button").click();
  await A.waitForSelector("input.m-share-url", { timeout: 20000 });
  const shareUrl = await A.locator("input.m-share-url").inputValue();
  await A.locator(".m-modal").getByRole("button", { name: "關閉", exact: true }).click().catch(() => undefined);

  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const B = await ctxB.newPage();
  await B.goto(`${APP}${new URL(shareUrl).hash}`, { waitUntil: "domcontentloaded" });
  await B.fill("input.text-input", "同步乙");
  await B.click("button.btn-primary");
  await B.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 20000 });
  await B.getByRole("button", { name: "對話", exact: true }).click().catch(() => undefined);
  const seenOnB = await B.waitForFunction(
    () => (document.querySelector('[data-testid="discussion-feed"]')?.textContent ?? "").includes("甲先說一句"),
    null,
    { timeout: 20000 },
  ).then(() => true).catch(() => false);
  check("第二個瀏覽器看到第一則討論", seenOnB);
  const countOnB = await B.evaluate(() => [...document.querySelectorAll('[data-testid="discussion-feed"] [data-testid^="discussion-"]')].filter((el) => el.textContent?.includes("甲先說一句")).length);
  check("同一則討論在乙只出現一次", countOnB === 1, `count=${countOnB}`);

  await ctxA.setOffline(true);
  await A.getByTestId("discussion-composer").getByLabel("房間討論").fill("離線後補的一句");
  await A.getByTestId("discussion-composer").getByRole("button", { name: "送出" }).click();
  await A.waitForTimeout(800);
  check("離線送出在甲仍看得到（ghost / failed）", (await A.getByTestId("discussion-feed").innerText()).includes("離線後補的一句"));
  await ctxA.setOffline(false);
  const replayed = await B.waitForFunction(
    () => (document.querySelector('[data-testid="discussion-feed"]')?.textContent ?? "").includes("離線後補的一句"),
    null,
    { timeout: 20000 },
  ).then(() => true).catch(() => false);
  check("回網後乙看到甲離線補送的那則", replayed);
  const replayCount = await B.evaluate(() => [...document.querySelectorAll('[data-testid="discussion-feed"] [data-testid^="discussion-"]')].filter((el) => el.textContent?.includes("離線後補的一句")).length);
  check("離線補送回放不重複", replayCount === 1, `count=${replayCount}`);

  await A.screenshot({ path: join(ARTIFACTS, "gap05-client-a.png"), fullPage: false });
  await B.screenshot({ path: join(ARTIFACTS, "gap05-client-b.png"), fullPage: false });

  const failed = results.filter((item) => !item.pass);
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n${results.length} checks passed`);
  }
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => app?.close(() => resolve()));
  await mock?.close?.();
  rmSync(tempRoot, { recursive: true, force: true });
}
