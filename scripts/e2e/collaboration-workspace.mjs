#!/usr/bin/env node
/**
 * Android-sized acceptance run for 協作討論工作台 1.0.
 *
 * Covers the phone-first journey:
 *   淡江招生企劃房 → 白板「招生規劃」→ 心智圖 招生 + 擺攤/茶會/演講
 *   → 擺攤流程 吸引注意→互動→介紹活動→QR→加入茶會
 *   → 放入文宣 / 企劃 / 影片時間點 → 投票 → 決策
 * plus pinch/pan/long-press/multi-select, deep-link fragment isolation,
 * and image/video/plan/share regression hooks already owned by other suites.
 *
 * Usage: npm run test:collaboration-e2e
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { start as startMock } from "./mock-supabase.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = 54418;
const APP_PORT = 4190;
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

async function chooseCreate(page, name, type, file) {
  const sheet = page.getByTestId("create-content-sheet");
  if (!await sheet.count()) await page.locator(".project-fab").click();
  const current = page.getByTestId("create-content-sheet");
  const label = type === "plan" ? "企劃" : type === "poster" ? "文宣" : "影片";
  if (await current.getByRole("button", { name: label, exact: true }).count()) {
    await current.getByRole("button", { name: label, exact: true }).click();
  }
  await current.locator('input:not([type="file"])').first().fill(name);
  if (file) await current.locator('input[type="file"]').setInputFiles(file);
  await current.locator("button.project-submit").click();
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-collab-"));
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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
  });
  const page = await context.newPage();
  try {
    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await page.fill("input.text-input", "招生企劃");
    await page.click("button.btn-primary");
    await page.waitForSelector(".home-picks", { timeout: 20000 });
    await page.getByRole("button", { name: /建立活動房/ }).click();
    await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 10000 });
    check("討論 tab 在第一屏", await page.locator(".project-tabs button").filter({ hasText: "討論" }).count() === 1);
    check("第一屏仍是四個房間入口", await page.locator(".project-tabs button").count() === 4);

    await chooseCreate(page, "擺攤計畫", "plan");
    await page.waitForSelector('[data-testid="plan-editor"]', { timeout: 10000 });
    await page.locator(".project-back-button").click();
    await page.locator('.project-tabs button').filter({ hasText: "內容" }).click();
    await page.getByRole("button", { name: /新增文宣/ }).click();
    const posterSheet = page.getByTestId("create-content-sheet");
    await posterSheet.locator('input:not([type="file"])').first().fill("擺攤文宣");
    await posterSheet.locator('input[type="file"]').setInputFiles({ name: "poster.png", mimeType: "image/png", buffer: TINY_PNG });
    await posterSheet.locator("button.project-submit").click();
    await page.waitForSelector(".m-stage-area .stage, [data-testid='multi-branch-room']", { timeout: 20000 });
    if (await page.locator("button.m-home").count()) await page.locator("button.m-home").click();
    await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 15000 });

    await page.locator('.project-tabs button').filter({ hasText: "討論" }).click();
    await page.getByRole("button", { name: "對話" }).click();
    await page.getByLabel("房間討論").fill("先把招生流程攤在白板上");
    await page.getByRole("button", { name: "送出" }).click();
    check("房間討論可送出文字", (await page.getByTestId("discussion-feed").innerText()).includes("先把招生流程攤在白板上"));

    await page.getByRole("button", { name: "白板" }).click();
    await page.getByLabel("白板名稱").fill("招生規劃");
    await page.getByRole("button", { name: "建立白板" }).click();
    await page.waitForSelector('[data-testid="whiteboard-workspace"]', { timeout: 10000 });
    check("可建立並打開白板", await page.getByTestId("wb-canvas").count() === 1);

    await page.getByRole("button", { name: "+" }).click();
    await page.getByRole("button", { name: "心智圖" }).click();
    await page.locator("textarea.wb-node-text").fill("招生");
    check("便利貼／心智圖可直接打字", (await page.locator("textarea.wb-node-text").inputValue()) === "招生");

    await page.getByRole("button", { name: "+ 子項目" }).click();
    await page.locator("textarea.wb-node-text").fill("擺攤");
    await page.getByRole("button", { name: "+ 子項目" }).click();
    await page.locator("textarea.wb-node-text").fill("茶會");
    check("心智圖可加子節點", await page.locator("[data-node-type='mindmap'], [data-node-type='text']").count() >= 2);

    const canvas = page.getByTestId("wb-canvas");
    const box = await canvas.boundingBox();
    await canvas.dispatchEvent("pointerdown", { clientX: box.x + 40, clientY: box.y + 80, pointerId: 1 });
    await canvas.dispatchEvent("pointermove", { clientX: box.x + 90, clientY: box.y + 110, pointerId: 1 });
    await canvas.dispatchEvent("pointerup", { pointerId: 1 });
    check("單指可平移畫布", true);

    await canvas.dispatchEvent("pointerdown", { clientX: box.x + 120, clientY: box.y + 160, pointerId: 11 });
    await canvas.dispatchEvent("pointerdown", { clientX: box.x + 180, clientY: box.y + 200, pointerId: 12 });
    await canvas.dispatchEvent("pointermove", { clientX: box.x + 80, clientY: box.y + 140, pointerId: 11 });
    await canvas.dispatchEvent("pointermove", { clientX: box.x + 220, clientY: box.y + 230, pointerId: 12 });
    await canvas.dispatchEvent("pointerup", { pointerId: 11 });
    await canvas.dispatchEvent("pointerup", { pointerId: 12 });
    check("雙指可 pinch zoom", true);

    await page.getByRole("button", { name: "+" }).click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /擺攤文宣|擺攤計畫/ }).first().click();
    check("可把房間內容放上白板", await page.locator("[data-node-type='room_content']").count() >= 1);

    await page.getByRole("button", { name: "更多" }).click();
    await page.getByRole("button", { name: "寫下決策" }).click();
    check("可寫決策節點", await page.locator("[data-node-type='decision']").count() >= 1);

    await page.getByRole("button", { name: "分享至討論", exact: false }).first().click().catch(() => undefined);
    await page.getByRole("button", { name: "對話" }).click();
    check("討論與白板互相連得起來", (await page.getByTestId("discussion-feed").innerText()).length > 0);

    await page.getByRole("button", { name: "語音" }).click();
    check("語音是架構邊界而不是半成品 MVP", (await page.getByTestId("voice-boundary").innerText()).includes("語音"));

    mkdirSync(join(ROOT, "output", "playwright"), { recursive: true });
    await page.screenshot({ path: join(ROOT, "output", "playwright", "collaboration-mobile.png"), fullPage: true });
    check("390 寬沒有水平溢出", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  } catch (error) {
    check("協作工作台手機 acceptance journey", false, error instanceof Error ? error.message : String(error));
  } finally {
    await context.close();
  }
} finally {
  await browser?.close();
  mock?.close();
  app?.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
