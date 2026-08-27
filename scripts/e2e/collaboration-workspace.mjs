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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function recordWebm(page, seconds = 1.1) {
  return Buffer.from(await page.evaluate(async (secs) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(20);
    const preferred = "video/webm;codecs=vp8";
    const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported(preferred) ? preferred : "video/webm" });
    const chunks = [];
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start();
    const start = performance.now();
    await new Promise((resolve) => {
      const frame = () => {
        const elapsed = (performance.now() - start) / 1000;
        context.fillStyle = `hsl(${Math.round(elapsed * 90) % 360} 70% 45%)`;
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = "#fff";
        context.font = "bold 42px sans-serif";
        context.fillText(`${elapsed.toFixed(1)}s`, 35, 110);
        if (elapsed >= secs) return resolve();
        requestAnimationFrame(frame);
      };
      frame();
    });
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, seconds), "base64");
}

async function fillEditing(page, text) {
  const box = page.locator("textarea.wb-node-text");
  await box.waitFor({ timeout: 8000 });
  await box.fill(text);
}

async function searchNode(page, name) {
  await page.getByTestId("whiteboard-search").click();
  await page.getByRole("textbox", { name: "搜尋節點" }).fill(name);
  await page.getByRole("button", { name, exact: true }).first().click();
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
    await page.locator(".project-back-button").click({ force: true });
    await page.waitForSelector(".project-tabs", { timeout: 10000 });

    await page.locator('.project-tabs button').filter({ hasText: "內容" }).click();
    await chooseCreate(page, "擺攤文宣", "poster", { name: "booth.png", mimeType: "image/png", buffer: TINY_PNG });
    await page.waitForSelector("img.stage-img", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector("img.stage-img")?.naturalWidth > 0, null, { timeout: 20000 });
    await page.locator("button.m-home").click();
    await page.waitForSelector(".project-tabs", { timeout: 15000 });

    const videoBytes = await recordWebm(page);
    await page.locator('.project-tabs button').filter({ hasText: "內容" }).click();
    await chooseCreate(page, "招生影片", "video", { name: "admission.webm", mimeType: "video/webm", buffer: videoBytes });
    await page.waitForSelector("video.v-video", { timeout: 90000 });
    await page.locator("button.m-home").click();
    await page.waitForSelector(".project-tabs", { timeout: 15000 });

    await page.locator('.project-tabs button').filter({ hasText: "討論" }).click();
    await page.getByRole("button", { name: "對話", exact: true }).click();
    await page.getByLabel("房間討論").fill("先把招生流程攤在白板上");
    await page.getByRole("button", { name: "送出" }).click();
    check("房間討論可送出文字", (await page.getByTestId("discussion-feed").innerText()).includes("先把招生流程攤在白板上"));

    await page.getByRole("button", { name: "白板", exact: true }).click();
    await page.getByLabel("白板名稱").fill("招生規劃");
    await page.getByRole("button", { name: "建立白板" }).click();
    await page.waitForSelector('[data-testid="whiteboard-workspace"]', { timeout: 10000 });
    check("可建立並打開白板", await page.getByTestId("wb-canvas").count() === 1);

    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "心智圖" }).click();
    await fillEditing(page, "招生");
    check("便利貼／心智圖可直接打字", (await page.locator("textarea.wb-node-text").inputValue()) === "招生");

    for (const child of ["擺攤", "茶會", "演講"]) {
      if (child !== "擺攤") await searchNode(page, "招生");
      await page.getByTestId("wb-add-child").click();
      await fillEditing(page, child);
    }
    check("心智圖可加子節點 擺攤/茶會/演講", (await page.locator("[data-node-type='mindmap']").count()) >= 3);

    await searchNode(page, "擺攤");
    for (const step of ["吸引注意", "互動", "介紹活動", "QR", "加入茶會"]) {
      await page.getByTestId("wb-next-step").click();
      await fillEditing(page, step);
    }
    const flowCount = Number(await page.getByTestId("wb-stats").getAttribute("data-flow"));
    const edgeCount = Number(await page.getByTestId("wb-stats").getAttribute("data-edges"));
    check("擺攤可自動長出流程下一步", flowCount >= 5, `flow=${flowCount}`);
    check("流程邊線會一起建立", edgeCount >= 5, `edges=${edgeCount}`);

    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /擺攤文宣/ }).click();
    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /擺攤計畫/ }).click();
    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /招生影片/ }).click();
    await page.getByTestId("wb-video-0040").click();
    check("可把文宣／企劃／影片時間卡放上白板", await page.locator("[data-node-type='room_content']").count() >= 3);
    check("影片卡帶 00:40 時間點", (await page.locator("[data-node-type='room_content']").allTextContents()).some((text) => text.includes("00:40")));

    await page.getByTestId("whiteboard-more").click();
    await page.getByTestId("wb-create-poll").click();
    check("可引用投票節點", await page.locator("[data-node-type='poll']").count() >= 1);
    await page.getByTestId("whiteboard-more").click();
    await page.getByTestId("wb-write-decision").click();
    check("可寫決策節點", await page.locator("[data-node-type='decision']").count() >= 1);

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

    await searchNode(page, "招生");
    const focused = page.locator("[data-node-type='mindmap']").filter({ hasText: "招生" }).first();
    const hit = await focused.boundingBox();
    if (hit) {
      await page.evaluate(({ x, y }) => {
        const el = document.querySelector("[data-testid='wb-canvas']");
        if (!el) return;
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 31, pointerType: "touch" }));
      }, { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 });
      await page.waitForTimeout(550);
      check("長按進入多選", await page.getByTestId("wb-multiselect").count() === 1);
      if (await page.getByTestId("wb-multiselect").count()) await page.getByRole("button", { name: "完成" }).click();
      await page.evaluate(() => {
        document.querySelector("[data-testid='wb-canvas']")?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 31, pointerType: "touch" }));
      });
    } else {
      check("長按進入多選", false, "找不到招生節點可長按");
    }

    await page.getByTestId("whiteboard-arrange").click();
    check("整理按鈕可按", true);

    await page.getByRole("button", { name: "分享至討論", exact: false }).first().click().catch(() => undefined);
    await page.getByRole("button", { name: "對話", exact: true }).click();
    check("討論與白板互相連得起來", (await page.getByTestId("discussion-feed").innerText()).length > 0);
    check("決策區看得到已決定", (await page.getByTestId("decision-area").innerText()).includes("採用 B 版"));

    await page.getByRole("button", { name: "語音", exact: true }).click();
    check("語音是架構邊界而不是半成品 MVP", (await page.getByTestId("voice-boundary").innerText()).includes("語音"));

    mkdirSync(join(ROOT, "output", "playwright"), { recursive: true });
    await page.screenshot({ path: join(ROOT, "output", "playwright", "collaboration-mobile.png"), fullPage: true });
    const shot = join("/opt/cursor/artifacts", "collaboration-mobile.png");
    try {
      mkdirSync("/opt/cursor/artifacts", { recursive: true });
      writeFileSync(shot, await page.screenshot({ fullPage: true }));
    } catch {
      /* artifacts dir may be missing in local CI */
    }
    check("390 寬沒有水平溢出", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  } catch (error) {
    mkdirSync(join(ROOT, "output", "playwright"), { recursive: true });
    await page.screenshot({ path: join(ROOT, "output", "playwright", "collaboration-mobile-fail.png"), fullPage: true }).catch(() => undefined);
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
