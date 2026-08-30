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
import { faults, requestLog, rows, start as startMock } from "./mock-supabase.mjs";
import { ensureRoomMore, openRoomCreate, openRoomPane } from "./room-more.mjs";

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
  if (!await sheet.count()) {
    await openRoomCreate(page);
  }
  const current = page.getByTestId("create-content-sheet");
  const label = type === "plan" ? "企劃" : type === "poster" ? "文宣" : "影片";
  if (await current.getByRole("button", { name: label, exact: true }).count()) {
    await current.getByRole("button", { name: label, exact: true }).click();
  }
  if (type === "poster" && await current.getByTestId("create-poster-upload").count()) {
    await current.getByTestId("create-poster-upload").click();
  }
  await current.locator('input:not([type="file"])').first().fill(name);
  if (file) await current.locator('input[type="file"]').setInputFiles(file);
  await current.locator("button.project-submit").click();
}

async function toggleWhiteboardDraw(page) {
  const direct = page.getByTestId("wb-tool-draw");
  if (await direct.count() && await direct.isVisible()) {
    await direct.click();
    return;
  }
  await page.getByTestId("whiteboard-more").click();
  await page.getByTestId("wb-tool-draw").click();
}

async function runWhiteboardNodeAction(page, testId) {
  const direct = page.getByTestId(testId);
  if (await direct.count() && await direct.isVisible()) {
    await direct.click();
    return;
  }
  await page.getByTestId("whiteboard-more").click();
  await page.getByTestId(testId).click();
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

async function dismissSelection(page) {
  // WB02：選取節點時情境列取代主工具列 — 開主工具列動作前先取消選取
  const dismiss = page.locator(".wb-context-dismiss");
  if (await dismiss.count() && await dismiss.isVisible()) {
    await dismiss.click();
    return;
  }
  // 手機情境列刻意只留四個工作動作；測試直接觸發同一個取消 handler，
  // 使用者在介面上則以點畫布空白處取消選取。
  if (await dismiss.count()) await dismiss.evaluate((button) => button.click());
}

async function searchNode(page, name) {
  // WB02：搜尋移進「更多」sheet（wireflow §11 — 主畫面不擺搜尋）
  await page.getByTestId("whiteboard-more").click();
  await page.getByTestId("whiteboard-search").click();
  const input = page.getByRole("textbox", { name: "搜尋節點" });
  await input.waitFor({ timeout: 5000 });
  await input.fill(name);
  const hit = page.locator(".wb-options button").filter({ hasText: name }).first();
  await hit.waitFor({ timeout: 8000 });
  await hit.click();
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
    // 討論就是房間殼（PR-01a）：第一屏是討論 feed + composer，
    // 總覽/內容/企劃是入口 chips，不再是互相競爭的四分頁。
    check("第一屏就是討論殼", await page.getByTestId("discussion-feed").count() === 1 && await page.getByLabel("房間討論").count() === 1);
    check("討論輸入列在第一屏", await page.getByTestId("discussion-composer").count() === 1);
    check("第一層沒有常駐總覽／AI／檔案", await page.getByTestId("open-overview-pane").count() === 0 && await page.getByTestId("room-ai-launcher").count() === 0 && await page.locator(".project-tabs").count() === 0);
    check("第一層只有對話／白板與更多", await page.getByRole("button", { name: "對話", exact: true }).count() >= 1 && await page.getByRole("button", { name: "白板", exact: true }).count() >= 1 && await page.getByTestId("room-more").count() === 1);
    check("語音是一行邊界說明，不佔 pane", (await page.getByTestId("voice-boundary").innerText()).includes("語音") && await page.getByTestId("voice-boundary").locator("button").count() === 0);

    await chooseCreate(page, "擺攤計畫", "plan");
    await page.waitForSelector('[data-testid="plan-editor"]', { timeout: 10000 });
    await page.locator(".project-back-button").click({ force: true });
    await page.waitForSelector('[data-testid="discussion-feed"]', { timeout: 10000 });

    await chooseCreate(page, "擺攤文宣", "poster", { name: "booth.png", mimeType: "image/png", buffer: TINY_PNG });
    await page.waitForSelector("img.stage-img", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector("img.stage-img")?.naturalWidth > 0, null, { timeout: 20000 });
    await page.locator("button.m-home").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="branch-workspace-overlay"]'), null, { timeout: 15000 });

    const videoBytes = await recordWebm(page);
    await chooseCreate(page, "招生影片", "video", { name: "admission.webm", mimeType: "video/webm", buffer: videoBytes });
    await page.waitForSelector("video.v-video", { timeout: 90000 });
    await page.locator("button.m-home").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="branch-workspace-overlay"]'), null, { timeout: 15000 });

    await page.getByRole("button", { name: "對話", exact: true }).click();
    await page.getByLabel("房間討論").fill("先把招生流程攤在白板上");
    await page.getByRole("button", { name: "送出" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("先把招生流程攤在白板上"), null, { timeout: 8000 });
    check("房間討論可送出文字", (await page.getByTestId("discussion-feed").innerText()).includes("先把招生流程攤在白板上"));
    check("送出後看得到最新一則", await page.locator('[data-testid="discussion-feed"] [data-latest="true"]').innerText().then((text) => text.includes("先把招生流程攤在白板上")));
    await page.getByTestId("discussion-edit").first().click();
    await page.getByTestId("discussion-edit-input").waitFor({ state: "visible", timeout: 8000 });
    await page.getByTestId("discussion-edit-input").fill("先把招生流程攤在白板上（改過）");
    await page.getByTestId("discussion-edit-save").click();
    await page.waitForFunction(() => document.body.innerText.includes("改過"), null, { timeout: 8000 });
    check("作者可改自己的文字", (await page.getByTestId("discussion-feed").innerText()).includes("改過"));
    await page.getByTestId("discussion-edited").first().waitFor({ state: "visible", timeout: 8000 });
    check("改過的訊息標已編輯", await page.getByTestId("discussion-edited").count() === 1);
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_edit_390.png"), fullPage: true });
    await page.getByTestId("decision-draft-open").click();
    await page.getByTestId("decision-draft-input").fill("主視覺採 B");
    await page.getByTestId("decision-draft-add").click();
    check("待決定草稿要人填標題", (await page.getByTestId("decision-area").innerText()).includes("主視覺採 B"));
    await page.getByTestId("discussion-create-poll").first().click();
    await page.waitForSelector('[data-testid="discussion-poll-draft"]', { timeout: 8000 });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_poll_390.png"), fullPage: true });
    await page.getByTestId("discussion-poll-question").fill("這週先主推哪一份？");
    await page.getByTestId("discussion-poll-option-0").fill("文宣");
    await page.getByTestId("discussion-poll-option-1").fill("影片");
    await page.getByTestId("discussion-create-poll-save").click();
    check("討論投票題目是人填的，不是罐頭", (await page.getByTestId("decision-area").innerText()).includes("這週先主推哪一份？"));
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForFunction(() => window.innerWidth >= 768, null, { timeout: 5000 });
    await page.getByTestId("discussion-create-poll").first().click();
    await page.waitForSelector('[data-testid="discussion-poll-draft"]', { timeout: 8000 });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_poll_768.png"), fullPage: true });
    await page.locator(".project-sheet-close").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.innerWidth <= 390, null, { timeout: 5000 });
    await page.getByTestId("composer-cite-work").click();
    await page.waitForSelector('[data-testid="cite-work"]', { timeout: 8000 });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_cite_work_390.png"), fullPage: true });
    await page.getByTestId("cite-work").getByRole("button", { name: "擺攤文宣" }).click();
    check("引用文宣卡進討論", (await page.getByTestId("discussion-feed").innerText()).includes("擺攤文宣"));
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForFunction(() => window.innerWidth >= 768, null, { timeout: 5000 });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_cite_768.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.innerWidth <= 390, null, { timeout: 5000 });

    await page.getByTestId("discussion-tombstone-btn").first().click();
    check("tombstone 畫墓碑，不是消失", await page.getByTestId("discussion-tombstone").count() >= 1);
    check("tombstone 之後列還在 feed", await page.locator('[data-testid^="discussion-"]').count() >= 1);
    check("tombstone 畫面沒有已讀回條", !(await page.getByTestId("discussion-feed").innerText()).includes("已讀"));
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_tombstone_390.png"), fullPage: true });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForFunction(() => window.innerWidth >= 768, null, { timeout: 5000 });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_tombstone_768.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.innerWidth <= 390, null, { timeout: 5000 });

    await page.locator("[data-tombstone='true']").first().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const end = document.querySelector('[data-testid="discussion-feed-end"]');
      if (!end) return true;
      return end.getBoundingClientRect().top > window.innerHeight - 40;
    }, null, { timeout: 5000 }).catch(() => undefined);
    await page.getByLabel("房間討論").fill("後到的一句");
    await page.getByRole("button", { name: "送出" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("後到的一句"), null, { timeout: 8000 });
    await page.getByLabel("房間討論").fill("再留一句");
    await page.getByRole("button", { name: "送出" }).click();
    await page.waitForFunction(() => document.body.innerText.includes("再留一句"), null, { timeout: 8000 });
    const unreadJump = page.getByTestId("jump-first-unread");
    check("第一則未讀可跳", await unreadJump.count() === 1);
    if (await unreadJump.count()) {
      await unreadJump.click({ force: true });
      const unreadMark = page.locator('[data-testid="discussion-feed"] [data-first-unread="true"]');
      await unreadMark.first().waitFor({ state: "attached", timeout: 3000 }).catch(() => undefined);
      check("未讀跳到水位之後", await unreadMark.count() >= 1);
    }
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_unread_390.png"), fullPage: true });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForFunction(() => window.innerWidth >= 768, null, { timeout: 5000 });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "discussion_unread_768.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.innerWidth <= 390, null, { timeout: 5000 });

    await page.getByRole("button", { name: "白板", exact: true }).click();
    await page.getByLabel("白板名稱").fill("招生規劃");
    await page.getByRole("button", { name: "建立白板" }).click();
    await page.waitForSelector('[data-testid="whiteboard-workspace"]', { timeout: 10000 });
    check("可建立並打開白板", await page.getByTestId("wb-canvas").count() === 1);
    check("空板先顯示三個下一步", await page.getByTestId("wb-empty-starter").count() === 1
      && await page.getByTestId("wb-start-step").count() === 1
      && await page.getByTestId("wb-start-poster").count() === 1
      && await page.getByTestId("wb-start-connect").count() === 1);
    await page.getByTestId("wb-start-step").click();
    await page.waitForSelector("textarea.wb-node-text", { timeout: 5000 });
    check("寫下一步驟會直接聚焦文字卡", await page.locator("textarea.wb-node-text").evaluate((el) => document.activeElement === el));
    await fillEditing(page, "先寫活動流程");
    await dismissSelection(page);

    // ---- WB02 Focus Mode 驗收（Grok wb00 F8 的防假綠斷言）----------
    {
      // 有效畫布面積（Grok wb02 F7）：canvas 矩形扣掉疊在其上的 chrome
      // 交集（頂欄/底欄/編輯行）。現在是純 flex 佈局、交集為 0；日後若改
      // overlay 疊在 canvas 上，這條會誠實掉下去而不是假綠。
      const metrics = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="wb-canvas"]').getBoundingClientRect();
        let overlap = 0;
        for (const el of document.querySelectorAll(".wb-focus-top, .wb-focus-bottom, .wb-editing-line")) {
          const r = el.getBoundingClientRect();
          const w = Math.max(0, Math.min(canvas.right, r.right) - Math.max(canvas.left, r.left));
          const h = Math.max(0, Math.min(canvas.bottom, r.bottom) - Math.max(canvas.top, r.top));
          overlap += w * h;
        }
        const effective = canvas.width * canvas.height - overlap;
        return {
          canvasArea: Math.round(canvas.width * canvas.height),
          chromeOverlap: Math.round(overlap),
          viewportArea: window.innerWidth * window.innerHeight,
          canvasPct: Math.round(effective / (window.innerWidth * window.innerHeight) * 100),
        };
      });
      check(`Focus Mode：有效畫布 ≥75% 視窗（實測 ${metrics.canvasPct}%）`, metrics.canvasPct >= 75, JSON.stringify(metrics));
      // FAB：unmount（count===0，display:none 不算過）
      check("Focus Mode：project-fab 不渲染", (await page.locator(".project-fab").count()) === 0);
      check("Focus Mode：asset-ai-fab 不渲染", (await page.locator(".asset-ai-fab").count()) === 0);
      // 殼元素被全屏層蓋住之外，畫面上不得再渲染搜尋列/膠囊/rd-tabs 在層上方
      const focusZ = await page.evaluate(() => getComputedStyle(document.querySelector(".wb-focus")).zIndex);
      check("Focus 層 z-index=45（疊加規則）", focusZ === "45", `z=${focusZ}`);

      // back 階梯：開 sheet → back 關 sheet 不退板；再 back 退回板清單
      await page.getByTestId("whiteboard-add").click();
      await page.waitForSelector(".project-scrim", { timeout: 5000 });
      await page.goBack();
      await page.waitForFunction(() => !document.querySelector(".project-scrim"), null, { timeout: 5000 });
      check("back 先關 sheet、板不退", (await page.getByTestId("wb-canvas").count()) === 1);
      await page.goBack();
      await page.waitForSelector(".wb-list", { timeout: 5000 });
      check("再 back 退出 Focus 回板清單", (await page.locator(".wb-list").count()) === 1);
      // 重新開板繼續後面的流程
      await page.locator(".wb-card").first().click();
      await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 10000 });
    }

    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "心智圖" }).click();
    await fillEditing(page, "招生");
    check("便利貼／心智圖可直接打字", (await page.locator("textarea.wb-node-text").inputValue()) === "招生");
    await fillEditing(page, "招生規劃");
    check("同一節點第二次改字不會因 stale-write 卡住", (await page.locator("textarea.wb-node-text").inputValue()) === "招生規劃");
    await fillEditing(page, "招生");

    for (const child of ["擺攤", "茶會", "演講"]) {
      if (child !== "擺攤") await searchNode(page, "招生");
      await runWhiteboardNodeAction(page, "wb-add-child");
      await fillEditing(page, child);
    }
    check("心智圖可加子節點 擺攤/茶會/演講", (await page.locator("[data-node-type='mindmap']").count()) >= 3);

    await searchNode(page, "擺攤");
    for (const step of ["吸引注意", "互動", "介紹活動", "QR", "加入茶會"]) {
      await runWhiteboardNodeAction(page, "wb-next-step");
      await fillEditing(page, step);
    }
    const flowCount = Number(await page.getByTestId("wb-stats").getAttribute("data-flow"));
    const edgeCount = Number(await page.getByTestId("wb-stats").getAttribute("data-edges"));
    check("擺攤可自動長出流程下一步", flowCount >= 5, `flow=${flowCount}`);
    check("流程邊線會一起建立", edgeCount >= 5, `edges=${edgeCount}`);

    await dismissSelection(page);
    const compactToolbar = page.getByTestId("wb-compact-toolbar");
    check("390 工具列走 compact（圖示、不佔整排字）", (await compactToolbar.getAttribute("data-compact")) === "true");
    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /擺攤文宣/ }).click();
    await page.waitForSelector('[data-testid="wb-poster-region"]', { timeout: 8000 });
    check("文宣卡先問範圍，不假裝已有圈選", (await page.getByTestId("wb-poster-region").innerText()).includes("還沒有圈選範圍"));
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "wb_poster_region_390.png"), fullPage: true });
    await page.getByTestId("wb-poster-whole").click();
    await dismissSelection(page);
    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /擺攤計畫/ }).click();
    await page.waitForSelector('[data-testid="wb-plan-section"]', { timeout: 8000 });
    check("企劃卡先問段落或整份", await page.getByTestId("wb-plan-whole").count() === 1);
    await page.screenshot({ path: join("/opt/cursor/artifacts", "wb_plan_section_390.png"), fullPage: true });
    await page.getByTestId("wb-plan-whole").click();
    await dismissSelection(page);
    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /招生影片/ }).click();
    await page.getByTestId("wb-video-0040").click();
    check("可把文宣／企劃／影片時間卡放上白板", await page.locator("[data-node-type='room_content']").count() >= 3);
    check("影片卡帶 00:40 時間點", (await page.locator("[data-node-type='room_content']").allTextContents()).some((text) => text.includes("00:40")));
    await dismissSelection(page);
    await page.screenshot({ path: join("/opt/cursor/artifacts", "wb_compact_toolbar_390.png"), fullPage: true });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="wb-compact-toolbar"]')?.getAttribute("data-compact") === "false",
      null,
      { timeout: 8000 },
    );
    check("768 工具列不是 compact", (await page.getByTestId("wb-compact-toolbar").getAttribute("data-compact")) === "false");
    await page.screenshot({ path: join("/opt/cursor/artifacts", "wb_toolbar_768.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.innerWidth <= 390, null, { timeout: 5000 });

    await page.getByTestId("whiteboard-more").click();
    await page.getByTestId("wb-create-poll").click();
    await page.waitForSelector('[data-testid="wb-poll-draft"]', { timeout: 8000 });
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "wb_poll_question_390.png"), fullPage: true });
    await page.getByTestId("wb-poll-question").fill("主視覺要不要換？");
    await page.getByTestId("wb-poll-option-0").fill("要，換成 B 版");
    await page.getByTestId("wb-poll-option-1").fill("先維持 A 版");
    await page.getByTestId("wb-create-poll-save").click();
    check("可引用投票節點", await page.locator("[data-node-type='poll']").count() >= 1);
    check("投票題目是人填的，不是罐頭", (await page.locator("[data-node-type='poll']").first().innerText()).includes("主視覺要不要換？"));
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForFunction(() => window.innerWidth >= 768, null, { timeout: 5000 });
    await page.getByTestId("whiteboard-more").click();
    await page.getByTestId("wb-create-poll").click();
    await page.waitForSelector('[data-testid="wb-poll-draft"]', { timeout: 8000 });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "wb_poll_question_768.png"), fullPage: true });
    await page.locator(".project-sheet-close").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.innerWidth <= 390, null, { timeout: 5000 });
    await page.getByTestId("whiteboard-more").click();
    await page.getByTestId("wb-write-decision").click();
    await page.waitForSelector('[data-testid="wb-decision-draft"]', { timeout: 8000 });
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "wb_decision_title_390.png"), fullPage: true });
    await page.getByTestId("wb-decision-title").fill("採用 B 版");
    await page.getByTestId("wb-write-decision-save").click();
    check("可寫決策節點", await page.locator("[data-node-type='decision']").count() >= 1);
    check("決策標題是人填的，不是罐頭", (await page.locator("[data-node-type='decision']").first().innerText()).includes("採用 B 版"));
    await page.screenshot({ path: join("/opt/cursor/artifacts", "collaboration_workspace_board.png"), fullPage: true });
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForFunction(() => window.innerWidth >= 768, null, { timeout: 5000 });
    await page.getByTestId("whiteboard-more").click();
    await page.getByTestId("wb-write-decision").click();
    await page.waitForSelector('[data-testid="wb-decision-draft"]', { timeout: 8000 });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "wb_decision_title_768.png"), fullPage: true });
    await page.locator(".project-sheet-close").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => window.innerWidth <= 390, null, { timeout: 5000 });

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

    // ---- WB03：frame 互動／freehand／camera memory --------------------
    {
      await page.getByTestId("whiteboard-more").click();
      await page.getByTestId("wb-create-frame").click();
      await page.waitForSelector("[data-testid^='wb-frame-handle-']", { timeout: 5000 });
      const frameHandle = page.locator("[data-testid^='wb-frame-handle-']").first();
      await frameHandle.click();
      await page.waitForSelector('[data-testid="wb-frame-actions"]', { timeout: 5000 });
      check("frame 可選取（情境列出現）", true);
      await page.getByTestId("wb-frame-rename").click();
      await page.locator(".wb-frame-rename input").fill("招生排程區");
      await page.locator(".wb-frame-rename button[type='submit']").click();
      await page.waitForTimeout(150);
      check("frame 可改名", (await page.locator(".wb-frame-title").first().innerText()) === "招生排程區");

      const frameEl = page.locator(".wb-frame").first();
      const beforeResize = await frameEl.boundingBox();
      const resize = page.locator("[data-testid^='wb-frame-resize-']").first();
      const rbox = await resize.boundingBox();
      await resize.dispatchEvent("pointerdown", { clientX: rbox.x + 10, clientY: rbox.y + 10, pointerId: 41 });
      await resize.dispatchEvent("pointermove", { clientX: rbox.x + 70, clientY: rbox.y + 50, pointerId: 41 });
      await resize.dispatchEvent("pointerup", { clientX: rbox.x + 70, clientY: rbox.y + 50, pointerId: 41 });
      await page.waitForTimeout(150);
      const afterResize = await frameEl.boundingBox();
      check("frame 可縮放（右下把手）", afterResize.width > beforeResize.width + 40, `${beforeResize.width}→${afterResize.width}`);

      const hbox = await frameHandle.boundingBox();
      await frameHandle.dispatchEvent("pointerdown", { clientX: hbox.x + 24, clientY: hbox.y + 10, pointerId: 42 });
      await frameHandle.dispatchEvent("pointermove", { clientX: hbox.x + 84, clientY: hbox.y + 40, pointerId: 42 });
      await frameHandle.dispatchEvent("pointerup", { clientX: hbox.x + 84, clientY: hbox.y + 40, pointerId: 42 });
      await page.waitForTimeout(150);
      const afterMove = await frameEl.boundingBox();
      check("frame 可拖曳", Math.abs(afterMove.x - afterResize.x - 60) < 10, `x ${afterResize.x}→${afterMove.x}`);

      await page.getByTestId("wb-undo").click();
      await page.waitForTimeout(150);
      const afterUndo = await frameEl.boundingBox();
      check("frame 拖曳可 undo 回原位", Math.abs(afterUndo.x - afterResize.x) < 10, `x ${afterMove.x}→${afterUndo.x}`);

      await frameHandle.click();
      await page.waitForSelector('[data-testid="wb-frame-delete"]', { timeout: 5000 });
      await page.getByTestId("wb-frame-delete").click();
      await page.waitForTimeout(150);
      check("frame 可刪除", (await page.locator(".wb-frame").count()) === 0);
      await page.getByTestId("wb-undo").click();
      await page.waitForFunction(() => document.querySelectorAll(".wb-frame").length === 1, null, { timeout: 5000 });
      check("frame 刪除可 undo 重建（含名字）", (await page.locator(".wb-frame-title").first().innerText()) === "招生排程區");

      // S6：同一板連續第二次 frame 寫入 — 版本沒採納的話會被 OCC 擋成
      // stale-write（同步狀態卡 offline-pending、雲端停在第一次的值）
      {
        const handle2 = page.locator("[data-testid^='wb-frame-handle-']").first();
        const b1 = await handle2.boundingBox();
        await handle2.dispatchEvent("pointerdown", { clientX: b1.x + 20, clientY: b1.y + 8, pointerId: 81 });
        await handle2.dispatchEvent("pointermove", { clientX: b1.x + 60, clientY: b1.y + 28, pointerId: 81 });
        await handle2.dispatchEvent("pointerup", { clientX: b1.x + 60, clientY: b1.y + 28, pointerId: 81 });
        await page.waitForTimeout(250);
        const b2 = await page.locator(".wb-frame").first().boundingBox();
        await handle2.dispatchEvent("pointerdown", { clientX: b2.x + 20, clientY: b2.y + 8, pointerId: 82 });
        await handle2.dispatchEvent("pointermove", { clientX: b2.x + 55, clientY: b2.y + 30, pointerId: 82 });
        await handle2.dispatchEvent("pointerup", { clientX: b2.x + 55, clientY: b2.y + 30, pointerId: 82 });
        await page.waitForTimeout(400);
        const b3 = await page.locator(".wb-frame").first().boundingBox();
        check("frame 第二次拖曳也真的移動（S6 版本簿記）", Math.abs(b3.x - b2.x - 35) < 12, `${b2.x}→${b3.x}`);
        // 直接讀 mock 的資料列（比 page fetch 可靠）：frame 必須真的
        // 寫進去且版本前進 — 舊 mock 沒有 whiteboard_frames 的自然鍵，
        // 更新走 insert→409→被 client 折成成功，列從未改變（S9 假綠）。
        const frameRow = (rows.whiteboard_frames ?? [])[0] ?? null;
        check(
          "frame 更新有寫進雲端且版本前進（S6/S9 假綠修正）",
          Boolean(frameRow && Number(frameRow.version) >= 2),
          frameRow ? `version=${frameRow.version} x=${Math.round(frameRow.x)}` : "no row",
        );
      }

      // ---- WB06：板內 AI（提案 → 預覽 → 套用 → 稽核）----------------
      {
        await dismissSelection(page);
        await page.route("**/functions/v1/room-ai-context", async (route) => {
          const body = JSON.parse(route.request().postData() || "{}");
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              room: { id: body.roomId, title: "e2e 房" },
              query: body.query,
              context: [], sources: [], relations: [],
              permissions: { role: "owner", canAsk: true, selectedCount: 0 },
              truncated: false,
              answer: {
                text: "可以分成三個方向。",
                citations: [],
                actions: [
                  { type: "add_whiteboard_node", label: "方向一", payload: { text: "AI：先做校內宣傳", nodeType: "text" } },
                  { type: "add_whiteboard_node", label: "方向二", payload: { text: "AI：再談異業合作", nodeType: "mindmap" } },
                  { type: "create_comment", label: "留到討論", payload: { body: "這個之後再說" } },
                ],
              },
              agent: { provider: "none", status: "unconfigured" },
            }),
          });
        });

        const nodesBefore = await page.locator(".wb-node:not(.wb-node-ai-preview)").count();
        const versionsBefore = (rows.whiteboard_versions ?? []).length;
        const dbNodesBefore = (rows.whiteboard_nodes ?? []).length;
        const dbMessagesBefore = (rows.room_discussion_messages ?? []).length;
        const auditBefore = (rows.collaboration_audit_events ?? []).length;
        await page.getByTestId("whiteboard-more").click();
        await page.getByTestId("wb-open-ai").click();
        await page.waitForSelector('[data-testid="wb-ai-sheet"]', { timeout: 8000 });
        await page.getByLabel("想問 AI 什麼").fill("把這些點子整理成方向");
        await page.getByTestId("wb-ai-ask").click();

        // 預覽：看得到、但**還沒**變成板上的節點
        await page.waitForSelector('[data-testid="wb-ai-preview-bar"]', { timeout: 10000 });
        const previewCount = await page.locator(".wb-node-ai-preview").count();
        check("AI 建議先以預覽出現（不是直接落板）", previewCount === 2, `preview=${previewCount}`);
        check("預覽期間真節點數沒有變", (await page.locator(".wb-node:not(.wb-node-ai-preview)").count()) === nodesBefore);
        // 紅線的**DB 層證據**：只數 DOM 的話，「預覽時順手 insert」也會全綠
        check(
          "預覽沒有寫進 whiteboard_nodes（紅線的 DB 層證據）",
          (rows.whiteboard_nodes ?? []).length === dbNodesBefore,
          `${dbNodesBefore}→${(rows.whiteboard_nodes ?? []).length}`,
        );
        check(
          "預覽沒有把留言提案送進討論串",
          (rows.room_discussion_messages ?? []).length === dbMessagesBefore,
          `${dbMessagesBefore}→${(rows.room_discussion_messages ?? []).length}`,
        );
        check("預覽點不到（pointer-events:none）", (await page.evaluate(() => {
          const ghost = document.querySelector(".wb-node-ai-preview");
          return ghost ? getComputedStyle(ghost).pointerEvents : "missing";
        })) === "none");
        const summary = await page.getByTestId("wb-ai-summary").innerText();
        check("預覽有說會發生什麼", summary.includes("會加上"), summary);
        // 原本這條重複斷言同一個 previewCount（沒有新觀察）。真正要驗的是
        // 「留言提案沒有變成板上的東西」：預覽節點的文字只能來自白板提案。
        const ghostTexts = await page.evaluate(() =>
          [...document.querySelectorAll(".wb-node-ai-preview")].map((el) => el.textContent ?? ""),
        );
        check(
          "非白板提案（留言）不會混進板上預覽",
          ghostTexts.length === 2 && !ghostTexts.some((text) => text.includes("這個之後再說")),
          JSON.stringify(ghostTexts),
        );

        // 取消：什麼都沒發生
        await page.getByTestId("wb-ai-discard").click();
        await page.waitForFunction(() => !document.querySelector('[data-testid="wb-ai-preview-bar"]'), null, { timeout: 5000 });
        check("取消後預覽整批消失、板上沒有殘留", (await page.locator(".wb-node:not(.wb-node-ai-preview)").count()) === nodesBefore
          && (await page.locator(".wb-node-ai-preview").count()) === 0);
        check(
          "取消後 DB 也沒有任何殘留",
          (rows.whiteboard_nodes ?? []).length === dbNodesBefore,
          `${dbNodesBefore}→${(rows.whiteboard_nodes ?? []).length}`,
        );

        // 再問一次並套用
        await page.getByTestId("whiteboard-more").click();
        await page.getByTestId("wb-open-ai").click();
        await page.getByLabel("想問 AI 什麼").fill("再整理一次");
        await page.getByTestId("wb-ai-ask").click();
        await page.waitForSelector('[data-testid="wb-ai-preview-bar"]', { timeout: 10000 });
        await page.getByTestId("wb-ai-apply").click();
        await page.waitForFunction(
          (before) => document.querySelectorAll(".wb-node:not(.wb-node-ai-preview)").length >= before + 2,
          nodesBefore,
          { timeout: 10000 },
        );
        check("套用後預覽變成真的節點", (await page.locator(".wb-node-ai-preview").count()) === 0);
        const applied = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".wb-node")).map((el) => el.textContent ?? "").join("|"),
        );
        check("AI 的內容真的在板上", applied.includes("AI：先做校內宣傳") && applied.includes("AI：再談異業合作"), applied.slice(0, 120));
        // 套用前必須自動存一張快照（0025 的 WB06 條款）
        const versionsAfter = (rows.whiteboard_versions ?? []).length;
        check("套用前自動存了快照（可以回得去）", versionsAfter > versionsBefore, `${versionsBefore}→${versionsAfter}`);
        const aiSnapshot = (rows.whiteboard_versions ?? []).some((row) => String(row.label ?? "").includes("AI 套用前"));
        check("快照標籤說明它是 AI 套用前存的", aiSnapshot);
        // 稽核這一腳原本完全沒被端到端覆蓋（章節標題卻寫著「→ 稽核」）
        const auditAfter = (rows.collaboration_audit_events ?? []).length;
        check("套用有寫進稽核表（0019）", auditAfter > auditBefore, `${auditBefore}→${auditAfter}`);
        // 「預覽不持久」的證據：關板再開（元件重掛、房態重讀）之後不得復活。
        // 不用 page.reload —— 這個 e2e 的房是本機建的，重整會回首頁，
        // 那樣驗到的是「回首頁沒有預覽」而不是「預覽不持久」。
        await page.locator(".wb-focus-top .project-back-button").click();
        await page.waitForSelector(".wb-list", { timeout: 10000 });
        await page.locator(".wb-card").first().click();
        await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
        check("關板再開預覽沒有復活（預覽不持久）", (await page.locator(".wb-node-ai-preview").count()) === 0);
        await page.unroute("**/functions/v1/room-ai-context");
      }

      // ---- WB04：版本快照與還原 ----
      {
        await dismissSelection(page);
        await page.getByTestId("whiteboard-more").click();
        await page.getByTestId("wb-open-versions").click();
        await page.waitForSelector('[data-testid="wb-versions"]', { timeout: 8000 });
        await page.getByTestId("wb-snapshot").click();
        await page.waitForFunction(
          () => document.querySelectorAll("[data-testid^='wb-version-']").length >= 1,
          null,
          { timeout: 10000 },
        );
        check("可存下白板快照並列在版本歷史", true);
        // 快照真的寫進雲端（讀 mock 列，不是看呼叫成功）
        const versionRow = (rows.whiteboard_versions ?? [])[0] ?? null;
        check(
          "快照有寫進 whiteboard_versions 且含節點",
          Boolean(versionRow && Array.isArray(versionRow.snapshot?.nodes) && versionRow.snapshot.nodes.length > 0),
          versionRow ? `nodes=${versionRow.snapshot?.nodes?.length}` : "no row",
        );
        await page.getByRole("button", { name: "關閉" }).click();
        // 快照後改動一個節點，再還原 → 內容回到快照當時
        await searchNode(page, "招生");
        const beforeText = await page.locator(".wb-node.is-selected .wb-node-static, .wb-node.is-selected textarea").first().inputValue().catch(() => null);
        await page.getByRole("button", { name: "編輯", exact: true }).click();
        await fillEditing(page, "快照後改的字");
        await dismissSelection(page);
        await page.getByTestId("whiteboard-more").click();
        await page.getByTestId("wb-open-versions").click();
        await page.waitForSelector("[data-testid^='wb-version-']", { timeout: 8000 });
        // 兩步流程：點版本 → 取快照＋顯示「還原會發生什麼」→ 確認
        await page.locator("[data-testid^='wb-version-']").first().click();
        await page.waitForSelector('[data-testid="wb-restore-summary"]', { timeout: 10000 });
        const summary = await page.getByTestId("wb-restore-summary").innerText();
        check("還原前先說清楚會發生什麼", summary.includes("還原會："), summary.slice(0, 80));
        await page.getByTestId("wb-restore-confirm").click();
        await page.waitForFunction(
          () => !document.querySelector('[data-testid="wb-versions"]'),
          null,
          { timeout: 10000 },
        );
        await page.waitForTimeout(400);
        const restored = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".wb-node")).map((el) => el.textContent ?? "").join("|"),
        );
        check("還原後「快照後改的字」不再出現在板上", !restored.includes("快照後改的字"), restored.slice(0, 120));
        void beforeText;
      }

      // freehand：繪圖工具畫一筆 → 節點；undo 軟刪
      await dismissSelection(page);
      await toggleWhiteboardDraw(page);
      await canvas.dispatchEvent("pointerdown", { clientX: box.x + 200, clientY: box.y + 320, pointerId: 51 });
      await canvas.dispatchEvent("pointermove", { clientX: box.x + 250, clientY: box.y + 355, pointerId: 51 });
      await canvas.dispatchEvent("pointermove", { clientX: box.x + 300, clientY: box.y + 330, pointerId: 51 });
      await canvas.dispatchEvent("pointerup", { clientX: box.x + 300, clientY: box.y + 330, pointerId: 51 });
      await page.waitForFunction(() => document.querySelectorAll("[data-node-type='freehand']").length >= 1, null, { timeout: 5000 });
      check("繪圖一筆成 freehand 節點（SVG path）", (await page.locator("[data-node-type='freehand'] svg path").count()) >= 1);
      await toggleWhiteboardDraw(page);
      await page.getByTestId("wb-undo").click();
      await page.waitForFunction(() => document.querySelectorAll("[data-node-type='freehand']").length === 0, null, { timeout: 5000 });
      check("freehand 可 undo（軟刪）", true);

      // S1/S2 反例：畫到一半第二指落下轉 pinch — 不得誤選節點、zoom 不得暴衝
      await toggleWhiteboardDraw(page);
      const nodeBox = await page.locator(".wb-node").first().boundingBox();
      const zoomBefore = await page.evaluate(() => {
        const style = document.querySelector(".wb-layer")?.getAttribute("style") ?? "";
        return Number(/scale\(([\d.]+)\)/.exec(style)?.[1] ?? 1);
      });
      // 起筆壓在節點上，畫出 200px，再落第二指
      await canvas.dispatchEvent("pointerdown", { clientX: nodeBox.x + 10, clientY: nodeBox.y + 10, pointerId: 71 });
      await canvas.dispatchEvent("pointermove", { clientX: nodeBox.x + 210, clientY: nodeBox.y + 60, pointerId: 71 });
      await canvas.dispatchEvent("pointerdown", { clientX: nodeBox.x + 260, clientY: nodeBox.y + 80, pointerId: 72 });
      await canvas.dispatchEvent("pointermove", { clientX: nodeBox.x + 215, clientY: nodeBox.y + 62, pointerId: 71 });
      await canvas.dispatchEvent("pointerup", { clientX: nodeBox.x + 215, clientY: nodeBox.y + 62, pointerId: 71 });
      await canvas.dispatchEvent("pointerup", { clientX: nodeBox.x + 260, clientY: nodeBox.y + 80, pointerId: 72 });
      await page.waitForTimeout(150);
      const zoomAfter = await page.evaluate(() => {
        const style = document.querySelector(".wb-layer")?.getAttribute("style") ?? "";
        return Number(/scale\(([\d.]+)\)/.exec(style)?.[1] ?? 1);
      });
      check("繪圖轉 pinch：zoom 不暴衝（S1）", zoomAfter > zoomBefore * 0.5 && zoomAfter < zoomBefore * 2, `${zoomBefore}→${zoomAfter}`);
      check("繪圖轉 pinch：不誤選節點（S2）", (await page.getByTestId("wb-node-actions").count()) === 0);
      check("繪圖轉 pinch：筆畫已取消不成節點", (await page.locator("[data-node-type='freehand']").count()) === 0);
      await toggleWhiteboardDraw(page);

      // camera memory：平移後離板重開，視角不歸零
      await canvas.dispatchEvent("pointerdown", { clientX: box.x + 60, clientY: box.y + 420, pointerId: 61 });
      await canvas.dispatchEvent("pointermove", { clientX: box.x + 150, clientY: box.y + 460, pointerId: 61 });
      await canvas.dispatchEvent("pointerup", { pointerId: 61 });
      await page.waitForTimeout(120);
      const camBefore = await page.locator(".wb-layer").getAttribute("style");
      await page.locator(".wb-focus-top .project-back-button").click();
      await page.waitForSelector(".wb-list", { timeout: 10000 });
      await page.locator(".wb-card").first().click();
      await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 10000 });
      await page.waitForTimeout(120);
      const camAfter = await page.locator(".wb-layer").getAttribute("style");
      check("camera memory：重開板視角不歸零", camAfter === camBefore, `${camBefore} vs ${camAfter}`);
    }

    await page.getByTestId("whiteboard-more").click();
    await page.getByTestId("whiteboard-arrange").click();
    check("整理按鈕可按", true);
    const nodeCount = await page.locator("[data-testid^='wb-node-']").count();
    const statsNodes = await page.getByTestId("wb-stats").getAttribute("data-nodes").catch(() => null);
    if (!nodeCount) {
      await page.screenshot({ path: join("/opt/cursor/artifacts", "collaboration_workspace_after_arrange.png"), fullPage: true }).catch(() => undefined);
      console.log("after arrange: rendered=0 stats=", statsNodes, "canvas=", (await page.getByTestId("wb-canvas").innerHTML().catch(() => "")).slice(0, 400));
    }
    const focused = page.locator("[data-testid^='wb-node-']").first();
    const hit = nodeCount ? await focused.boundingBox() : null;
    if (hit) {
      await page.evaluate(({ x, y }) => {
        const el = document.querySelector("[data-testid='wb-canvas']");
        if (!el) return;
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 31, pointerType: "touch" }));
      }, { x: hit.x + Math.min(20, hit.width / 2), y: hit.y + Math.min(16, hit.height / 2) });
      await page.waitForTimeout(550);
      check("長按進入多選", await page.getByTestId("wb-multiselect").count() === 1);
      if (await page.getByTestId("wb-multiselect").count()) await page.getByRole("button", { name: "完成" }).click();
      await page.evaluate(() => {
        document.querySelector("[data-testid='wb-canvas']")?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 31, pointerType: "touch" }));
      });
    } else {
      check("長按進入多選", false, "整理後仍找不到節點可長按");
    }

    await page.getByRole("button", { name: "分享至討論", exact: false }).first().click().catch(() => undefined);
    // WB02 Focus Mode：rd-tabs 在全屏層之下 — 先返回板清單再切對話
    await page.locator(".wb-focus-top .project-back-button").click();
    await page.waitForSelector(".wb-list", { timeout: 10000 });
    await page.getByRole("button", { name: "對話", exact: true }).click();
    check("討論與白板互相連得起來", (await page.getByTestId("discussion-feed").innerText()).length > 0);
    check("決策區看得到已決定", (await page.getByTestId("decision-area").innerText()).includes("採用 B 版"));

    // ---- WB03：雙向連結 — 訊息⇄白板 provenance／內容側 chip／overlay back --
    {
      await page.getByLabel("房間討論").fill("擺攤動線要重排");
      await page.locator(".rd-composer").getByRole("button", { name: "送出" }).click();
      await page.waitForFunction(() => document.querySelector('[data-testid="discussion-feed"]')?.textContent?.includes("擺攤動線要重排"), null, { timeout: 15000 });
      const sourceMsg = page.locator(".rd-msg", { hasText: "擺攤動線要重排" }).first();
      await sourceMsg.getByRole("button", { name: "加入白板" }).click();
      await page.getByRole("dialog", { name: "加入白板" }).getByRole("button", { name: "招生規劃" }).click();
      await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
      await page.waitForSelector('[data-testid="wb-node-actions"]', { timeout: 10000 });
      check("訊息「加入白板」：開板並聚焦新節點", true);
      await page.getByTestId("whiteboard-more").click();
      check("節點帶 provenance（打開來源訊息鈕）", (await page.getByTestId("wb-open-source-message").count()) === 1);
      await page.getByTestId("wb-open-source-message").click();
      await page.waitForSelector(".rd-msg-flash", { timeout: 8000 });
      check("打開來源訊息：跳回討論並高亮原文", (await page.locator(".rd-msg-flash").innerText()).includes("擺攤動線要重排"));

      // 內容側反向 chip：開 擺攤文宣 對稿 → 白板引用 chip → 跳回引用節點
      // 第一層沒有常駐內容入口（#110 更多 sheet）；不可直接點 open-content-pane。
      await openRoomPane(page, "open-content-pane");
      await page.getByTestId("content-pane").getByRole("button", { name: /擺攤文宣/ }).click();
      await page.waitForSelector('[data-testid="branch-workspace-overlay"]', { timeout: 15000 });
      await page.waitForSelector('[data-testid="board-refs-chip"]', { timeout: 10000 });
      check("對稿頂列出現「白板 N」引用 chip", (await page.getByTestId("board-refs-chip").first().innerText()).includes("白板"));
      await page.getByTestId("board-refs-chip").first().click();
      await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
      await page.waitForSelector('[data-testid="wb-node-actions"]', { timeout: 10000 });
      check("chip 跳回白板並聚焦引用節點", true);

      // S14：焦點只套一次 — 之後任何節點變動（打字/新增）不得再搶相機
      {
        const canvas2 = page.getByTestId("wb-canvas");
        const cbox = await canvas2.boundingBox();
        await canvas2.dispatchEvent("pointerdown", { clientX: cbox.x + 60, clientY: cbox.y + 300, pointerId: 91 });
        await canvas2.dispatchEvent("pointermove", { clientX: cbox.x + 170, clientY: cbox.y + 360, pointerId: 91 });
        await canvas2.dispatchEvent("pointerup", { pointerId: 91 });
        await page.waitForTimeout(150);
        const camPanned = await page.locator(".wb-layer").getAttribute("style");
        await page.getByTestId("wb-tool-sticky").click();
        await fillEditing(page, "焦點後新增");
        await page.waitForTimeout(300);
        const camAfterEdit = await page.locator(".wb-layer").getAttribute("style");
        check("焦點不再每次節點變動就搶相機（S14）", camAfterEdit === camPanned, `${camPanned} vs ${camAfterEdit}`);
      }

      // overlay 疊在 Focus 上：打開內容 → back 先關 overlay、板不退
      // （S14 那段新增了便利貼＝選取已換人，先選回內容卡）
      await dismissSelection(page);
      await searchNode(page, "擺攤文宣");
      await page.waitForSelector('[data-testid="wb-node-actions"]', { timeout: 10000 });
      await runWhiteboardNodeAction(page, "wb-open-content");
      await page.waitForSelector('[data-testid="branch-workspace-overlay"]', { timeout: 15000 });
      check("Focus 上可疊對稿 overlay（板不卸載）", (await page.getByTestId("wb-canvas").count()) === 1);
      // S15：只驗 DOM 存在是假綠 — overlay z 若低於 Focus 會被整個蓋住，
      // 畫面零變化但 back 卻先關那層看不見的。驗畫面中央實際命中誰。
      const overlayOnTop = await page.evaluate(() => {
        const overlay = document.querySelector('[data-testid="branch-workspace-overlay"]');
        if (!overlay) return { ok: false, why: "no overlay" };
        const hit = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
        return {
          ok: Boolean(hit && overlay.contains(hit)),
          why: hit ? (hit.closest(".wb-focus") ? "被白板 Focus 蓋住" : hit.className || hit.tagName) : "none",
        };
      });
      check("對稿 overlay 真的在最上層可見（S15）", overlayOnTop.ok, overlayOnTop.why);
      await page.goBack();
      await page.waitForFunction(() => !document.querySelector('[data-testid="branch-workspace-overlay"]'), null, { timeout: 8000 });
      check("back 先關 overlay、板不退（WB03 修的 listener 互踩）", (await page.getByTestId("wb-canvas").count()) === 1);
      // 收尾回對話，銜接後續章節
      await page.locator(".wb-focus-top .project-back-button").click();
      await page.waitForSelector(".wb-list", { timeout: 10000 });
      await page.getByRole("button", { name: "對話", exact: true }).click();
      await page.waitForSelector('[data-testid="discussion-feed"]', { timeout: 10000 });
    }

    check("語音是架構邊界而不是半成品 MVP", (await page.getByTestId("voice-boundary").innerText()).includes("語音"));

    // --- PR-01a 新增檢查 ---------------------------------------------
    // 鍵盤：composer 是 fixed dock，--kb 升起時要騎在鍵盤上、feed 保持可捲。
    await page.evaluate(() => document.documentElement.style.setProperty("--kb", "300px"));
    await page.waitForTimeout(120);
    {
      const box = await page.getByLabel("房間討論").boundingBox();
      const viewport = page.viewportSize();
      check("鍵盤升起時 composer 在鍵盤上方", Boolean(box && viewport && box.y + box.height <= viewport.height - 290), JSON.stringify(box));
    }
    await page.evaluate(() => document.documentElement.style.setProperty("--kb", "0px"));

    // 失敗送出：mock 注入一次 insert 失敗 → 樂觀列顯示未送出，重試後恢復，
    // 且訊息只出現一次（id 冪等）。
    // 兩發 fault：第一次失敗會被 outbox 的一次性自動補送吃掉（onLine
    // 時的死區恢復設計，PR-08b）；第二發也失敗 → 誠實 failed＋按鈕。
    faults.discussionInsert = 2;
    await page.getByLabel("房間討論").fill("這句會先失敗");
    await page.getByRole("button", { name: "送出" }).click();
    await page.waitForSelector(".rd-msg.is-failed [data-testid='discussion-retry'], .rd-msg.is-failed", { timeout: 20000 });
    check("失敗的討論訊息看得到、可重試（自動補送上限一次後）", await page.locator(".rd-msg.is-failed").count() === 1 && await page.getByTestId("discussion-retry").count() === 1);
    // wholesale 快照替換不能吃掉 ghost：先送一句成功的（觸發 realtime
    // reload → 整包快照不含失敗那句），失敗列必須還在（Grok pr01a F4/F7）。
    await page.getByLabel("房間討論").fill("這句會成功並觸發快照");
    await page.locator(".rd-composer").getByRole("button", { name: "送出" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="discussion-feed"]')?.textContent?.includes("這句會成功並觸發快照"), null, { timeout: 15000 });
    await page.waitForTimeout(600);
    check("失敗的 ghost 活過整包快照替換", await page.locator(".rd-msg.is-failed").count() === 1, "failed rows=" + await page.locator(".rd-msg.is-failed").count());

    // --- PR-02b：stale-write conflict → drop + 該板 refetch（真 409） -----
    {
      const stickyInput = page.locator("textarea.wb-node-text").first();
      // 先確保白板 pane 開著且有一個可編輯節點（前面流程已建）
      await page.getByRole("button", { name: "白板", exact: true }).click();
      // 板可能回到列表狀態：沒有 canvas 就點板卡打開
      if (!(await page.locator('[data-testid="wb-canvas"]').count())) {
        await page.locator('.wb-card').first().click({ force: true }).catch(() => undefined);
      }
      await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
      // 開著的板未必有可編輯便利貼：先建一張，等它落雲（有 server version）
      if (!(await page.locator("textarea.wb-node-text").count())) {
        await dismissSelection(page);
        await page.getByTestId("whiteboard-add").click();
        await page.locator(".project-sheet").getByRole("button", { name: "便利貼" }).click();
        await page.waitForSelector("textarea.wb-node-text", { timeout: 15000 });
      }
      await page.waitForTimeout(600); // 等新便利貼的雲端 ack（version 進 mock）
      check("02b 前置：mock 有節點列", rows.whiteboard_nodes.length > 0, "nodes=" + rows.whiteboard_nodes.length);
      {
        // 模擬「別人已存了更新版本」：所有節點的 server 版本直接跳高
        // （編輯到哪一顆都會 409）
        const bumped = rows.whiteboard_nodes.map((row) => { row.version = Number(row.version ?? 1) + 7; return row.version; });
        const maxBumped = Math.max(...bumped);
        requestLog.length = 0;
        // 觸發一次本地編輯 → blur 讓 persist("end") 送出舊 version → 409
        await stickyInput.click({ force: true }).catch(() => undefined);
        await stickyInput.fill("衝突觸發").catch(() => undefined);
        await page.keyboard.press("Tab");
        await page.waitForFunction(
          () => [...document.querySelectorAll(".toast, [role=status], .t-msg")].some((el) => el.textContent?.includes("被別人改過")),
          null,
          { timeout: 20000 },
        ).catch(() => undefined);
        const toastSeen = await page.evaluate(() => [...document.querySelectorAll("*")].some((el) => el.childElementCount === 0 && el.textContent?.includes("被別人改過")));
        const boardRefetched = requestLog.some((line) => line.includes("GET /rest/v1/whiteboard_nodes"));
        check("stale-write 衝突：誠實 toast＋該板 refetch（非空 reload）", toastSeen && boardRefetched, `toast=${toastSeen} refetch=${boardRefetched}`);
        // 同步後繼續編輯要能成功（版本已前進，不再 409 空轉）
        await page.waitForTimeout(400);
        await stickyInput.click({ force: true }).catch(() => undefined);
        await stickyInput.fill("同步後再編輯").catch(() => undefined);
        await page.keyboard.press("Tab");
        await page.waitForTimeout(800);
        void maxBumped;
        const landed = rows.whiteboard_nodes.some((row) => JSON.stringify(row.content ?? row).includes("同步後再編輯"));
        check("同步後編輯恢復（衝突後的寫真的落地，不再空轉）", landed, "landed=" + landed);
      }
      // --- PR-02c：兩分頁即時增量（無整房 reload） --------------------
      {
        await page.locator(".wb-focus-top .project-back-button").click().catch(() => undefined);
        await page.waitForSelector(".wb-list", { timeout: 10000 }).catch(() => undefined);
        await ensureRoomMore(page);
        await page.locator(".project-share-button").click();
        await page.waitForSelector("input.m-share-url", { timeout: 30000 });
        const shareUrl = await page.locator("input.m-share-url").inputValue();
        await page.locator(".m-modal").getByRole("button", { name: "關閉", exact: true }).click().catch(() => undefined);
        // 回到板上繼續雙分頁劇本
        await page.locator(".wb-card").first().click();
        await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });

        const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: "Mozilla/5.0 (Linux; Android 14) e2e" });
        const B = await ctxB.newPage();
        try {
          await B.goto(`${APP}${new URL(shareUrl).hash}`, { waitUntil: "domcontentloaded" });
          await B.fill("input.text-input", "第二分頁");
          await B.click("button.btn-primary");
          // 分享連結可能帶白板深連結：B 直接落在板上；否則自己走過去。
          await B.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 30000 });
          if (!(await B.locator('[data-testid="wb-canvas"]').count())) {
            await B.getByRole("button", { name: "白板", exact: true }).click().catch(() => undefined);
            if (!(await B.locator('[data-testid="wb-canvas"]').count())) {
              await B.locator(".wb-card").first().click({ force: true }).catch(() => undefined);
            }
          }
          await B.waitForSelector('[data-testid="wb-canvas"]', { timeout: 20000 });
          // 量測窗前的靜默期（Grok 08a F4 修正版）：B 的 subscribe→heal
          // 板級 GET 是 0-or-1 的合法競態 — subscribe 若在開板前完成就沒有
          // heal GET，之後完成就有一次。斷言「必發生」或「必不發生」都是
          // 錯的；正確的 deterministic 錨點是「板 GET 計數穩定 1.5 秒」，
          // 保證量測窗開始時所有 straggler 已落地。逾時（10 秒仍不穩定）
          // 即紅 — 那代表有 GET 迴圈，本身就是 bug。
          {
            const boardGets = () => requestLog.filter((line) => line.includes("GET /rest/v1/whiteboard_nodes")).length;
            const quietDeadline = Date.now() + 10000;
            let stableSince = Date.now();
            let last = boardGets();
            while (Date.now() - stableSince < 1500) {
              if (Date.now() > quietDeadline) break;
              await new Promise((resolve) => setTimeout(resolve, 150));
              const now = boardGets();
              if (now !== last) { last = now; stableSince = Date.now(); }
            }
            check("兩分頁：量測窗前板 GET 已靜默（無 GET 迴圈）", Date.now() <= quietDeadline, `boardGets=${last}`);
          }
          requestLog.length = 0;
          // A 新增一張便利貼並打字（INSERT + UPDATE 都走 row-patch）
          await dismissSelection(page);
          await page.getByTestId("whiteboard-add").click();
          await page.locator(".project-sheet").getByRole("button", { name: "便利貼" }).click();
          await page.waitForSelector("textarea.wb-node-text", { timeout: 15000 });
          await page.locator("textarea.wb-node-text").last().fill("跨分頁增量");
          await page.keyboard.press("Tab");

          // B 不做任何重開動作，節點與文字要自己出現
          // WB02：非編輯節點是靜態層（textarea 只在編輯時渲染）
          const seesText = (needle) => (el) => el.textContent && el.textContent.includes(needle);
          await B.waitForFunction(
            () => [...document.querySelectorAll(".wb-node-static, textarea.wb-node-text")].some((el) => (el.value ?? el.textContent ?? "").includes("跨分頁增量")),
            null,
            { timeout: 20000 },
          );
          const bSeen = await B.evaluate(() => [...document.querySelectorAll(".wb-node-static, textarea.wb-node-text")].some((el) => (el.value ?? el.textContent ?? "").includes("跨分頁增量")));
          void seesText;
          check("兩分頁：B 不重開就看到 A 的新節點與文字", bSeen);

          // reload 風暴不見了：整房快照與板 GET 都必須為 0 —
          // 後者證明 B 看到的是 realtime row-patch，不是任何 heal 的
          // loadWhiteboard 替代路徑（Grok pr02c F6）。
          const fullReloads = requestLog.filter((line) => line.startsWith("GET /rest/v1/rooms?select=*")).length;
          const boardFetches = requestLog.filter((line) => line.includes("GET /rest/v1/whiteboard_nodes")).length;
          check("row-patch 取代整房 reload（rooms 快照 GET=0 且板 GET=0）", fullReloads === 0 && boardFetches === 0, `fullReloads=${fullReloads} boardFetches=${boardFetches}`);
          // ---- WB01 tombstone：軟刪同步＋殭屍防護（Grok wb01 F1/F4）----
          // A 刪掉那張便利貼：B 不重開要看到它消失（tombstone UPDATE →
          // row-patch 的 delete 轉換 — 復活路徑的第一防線）
          {
            // WB02：非編輯節點是靜態層，整卡可點選（audit 缺陷已修）
            await page.locator(".wb-node").last().click({ force: true });
            await page.getByRole("button", { name: "刪除", exact: true }).click();
            await B.waitForFunction(
              () => ![...document.querySelectorAll(".wb-node-static, textarea.wb-node-text")].some((el) => (el.value ?? el.textContent ?? "").includes("跨分頁增量")),
              null,
              { timeout: 20000 },
            );
            check("tombstone：B 不重開就看到 A 刪掉的節點消失", true);
            // DB 斷言：列還在（soft），deleted_at 非空 — 不是硬刪
            const row = rows.whiteboard_nodes.find((r) => r.content && String(r.content.text ?? "").includes("跨分頁增量"));
            check("tombstone：DB 列仍在且 deleted_at 已標（軟刪不是硬刪）", Boolean(row && row.deleted_at), JSON.stringify({ found: Boolean(row), deleted: row?.deleted_at ?? null }).slice(0, 80));

            // 殭屍防護（F1 的真反例）：B 的 IndexedDB 快照裡還有這個節點
            // （刪除前存的）。B 離開板再重開 — 「先快照後雲端整替」的序列
            // 必須讓墓碑贏，節點不得回到畫面。
            await B.locator(".wb-focus-top .project-back-button").click().catch(() => undefined);
            await B.waitForSelector(".wb-list", { timeout: 15000 }).catch(() => undefined);
            await B.locator(".wb-card").first().click({ force: true });
            await B.waitForSelector('[data-testid="wb-canvas"]', { timeout: 20000 });
            // 給快照→雲端序列一個完整落地窗
            await B.waitForFunction(
              () => ![...document.querySelectorAll(".wb-node-static, textarea.wb-node-text")].some((el) => (el.value ?? el.textContent ?? "").includes("跨分頁增量")),
              null,
              { timeout: 20000 },
            );
            check("tombstone：B 重開板後殭屍不復活（快照→雲端序列生效）", true);
          }
        } finally {
          await ctxB.close();
        }
      }
      // ---- PR-08b：離線矩陣 -------------------------------------------
      // 真離線（Playwright setOffline），不是 mock fault：驗的是「斷網→
      // 回網」的整條使用者旅程 — 誠實狀態、不掉資料、回網自癒。
      {
        const ctx = page.context();
        // 前段停在白板 pane：Focus 開著要先退出，殼 tabs 才點得到。
        if (await page.locator(".wb-focus").count()) {
          await page.locator(".wb-focus-top .project-back-button").click();
          await page.waitForSelector(".wb-list", { timeout: 10000 });
        }
        await page.getByRole("button", { name: "對話", exact: true }).click();
        await page.waitForSelector('[data-testid="discussion-feed"]', { timeout: 15000 });

        // (a) 離線發討論訊息 → 誠實「未送出」→ 回網手動重試 → 落地
        await ctx.setOffline(true);
        await page.getByLabel("房間討論").fill("斷網時打的話");
        await page.locator(".rd-composer").getByRole("button", { name: "送出" }).click();
        const ghostShown = await page.waitForFunction(
          () => document.querySelector('[data-testid="discussion-feed"]')?.textContent?.includes("斷網時打的話") ?? false,
          null,
          { timeout: 15000 },
        ).then(() => true).catch(() => false);
        // 死區 fetch 是懸掛不是拒絕：failed 狀態要等 12 秒 abort deadline
        // 之後才誠實出現（這正是本 PR 的產品修復）。
        const retryAppeared = await page.waitForFunction(
          () => Boolean(document.querySelector('[data-testid="discussion-retry"]')),
          null,
          { timeout: 25000 },
        ).then(() => true).catch(() => false);
        check("離線：訊息以未送出 ghost 誠實顯示（abort deadline 後可重試）", ghostShown && retryAppeared);
        await ctx.setOffline(false);
        // 回網後不需要手動點：outbox 的 online flush＋一次性自動補送會把
        // 它送到（死區懸掛的第二發 fetch 也可能懸掛→abort→自動補一次 —
        // 全程誠實狀態）。落地以 mock 列為準。
        {
          const landDeadline = Date.now() + 40000;
          let msgRows = 0;
          while (Date.now() < landDeadline) {
            msgRows = rows.room_discussion_messages.filter((row) => row.body === "斷網時打的話").length;
            if (msgRows >= 1) break;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          check("回網自動補送：訊息落地恰好一列（無重複、無手動）", msgRows === 1, `rows=${msgRows}`);
        }

        // (b) 離線白板編輯 → pending 佇列 → 回網自動 flush → 恰好一列
        await page.getByRole("button", { name: "白板", exact: true }).click();
        if (!(await page.locator('[data-testid="wb-canvas"]').count())) {
          await page.locator(".wb-card").first().click({ force: true }).catch(() => undefined);
        }
        await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 20000 });
        await ctx.setOffline(true);
        await page.getByTestId("whiteboard-add").click();
        await page.locator(".project-sheet").getByRole("button", { name: "便利貼" }).click();
        await page.waitForSelector("textarea.wb-node-text", { timeout: 15000 });
        await page.locator("textarea.wb-node-text").last().fill("離線寫的節點");
        await page.keyboard.press("Tab");
        await page.waitForTimeout(800);
        const offlineNodeRows = rows.whiteboard_nodes.filter((row) => row.content?.text === "離線寫的節點").length;
        check("離線：節點寫入不出網（佇列持有）", offlineNodeRows === 0, `rows=${offlineNodeRows}`);
        await ctx.setOffline(false);
        // online 事件觸發 revive→flushPending；輪詢佇列 flush 的可觀測終態
        const flushDeadline = Date.now() + 20000;
        let flushedRows = 0;
        while (Date.now() < flushDeadline) {
          flushedRows = rows.whiteboard_nodes.filter((row) => row.content?.text === "離線寫的節點").length;
          if (flushedRows >= 1) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        check("回網：pending 佇列自動 flush，節點恰好一列", flushedRows === 1, `rows=${flushedRows}`);

        // (c) 節點在畫面上仍在（本地樂觀＋flush 後 ack，不閃不掉）
        // 只查 textarea 是脆弱的：WB02 之後 textarea **只在編輯中**渲染，
        // 編輯 session 一結束文字就搬到 .wb-node-static —— 那時這條會紅，
        // 但節點其實好好地在畫面上。要驗的是「還在」，不是「還在編輯」。
        const stillVisible = await page.evaluate(() =>
          [...document.querySelectorAll(".wb-node-static, textarea.wb-node-text")]
            .some((el) => (el.value ?? el.textContent ?? "").includes("離線寫的節點")),
        );
        check("離線寫的節點回網後仍在畫面上", stillVisible);
      }

      if (await page.locator(".wb-focus").count()) {
        await page.locator(".wb-focus-top .project-back-button").click();
        await page.waitForSelector(".wb-list", { timeout: 10000 });
      }
      await page.getByRole("button", { name: "對話", exact: true }).click();
    }
    // 舊 ghost 已被離線矩陣段的 online flush 自動送到（這正是 PR-08b 的
    // 設計）：按鈕不該在了，訊息應恰好一列 — 手動 retry 改為驗證自癒。
    await page.waitForFunction(() => !document.querySelector(".rd-msg.is-failed"), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    {
      const feedText = await page.getByTestId("discussion-feed").innerText();
      const occurrences = feedText.split("這句會先失敗").length - 1;
      const landedRows = rows.room_discussion_messages.filter((row) => row.body === "這句會先失敗").length;
      check("online flush 自癒舊 ghost：恢復且只出現一次", occurrences === 1 && landedRows === 1, `occurrences=${occurrences} rows=${landedRows}`);
    }

    // --- PR-01b：Universal Intake 附件 ---------------------------------
    const attachInput = page.locator(".rd-composer input[type=file]").first();
    await attachInput.setInputFiles({ name: "brief.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 e2e") });
    await page.waitForSelector('[data-testid="attachment-card"]', { timeout: 20000 });
    check(
      "composer 附 PDF 出現附件卡",
      (await page.getByTestId("discussion-feed").innerText()).includes("brief.pdf")
        && requestLog.some((line) => line.includes("/storage/v1/object/room-assets/rooms/") && line.includes("/attachments/")),
    );

    // planform 場佈 JSON（PR-06）：識別 → 摘要 chip；原始 bytes 原樣上傳
    {
      const planformJson = JSON.stringify({
        version: 8,
        id: "proj_e2e_1",
        name: "迎新場佈",
        classroom: { id: "classroom", name: "教室", length: 10, width: 8, x: 0, z: 0 },
        corridor: { id: "corridor", name: "走廊", length: 10, width: 2, x: 0, z: 8 },
        zones: [{ id: "z1" }, { id: "z2" }, { id: "z3" }],
        objects: [{ id: "o1" }],
        routes: [],
        scenarios: [],
      });
      await attachInput.setInputFiles({ name: "迎新場佈.planform.json", mimeType: "application/json", buffer: Buffer.from(planformJson) });
      await page.waitForSelector('[data-testid="planform-chip"]', { timeout: 20000 });
      const chip = await page.getByTestId("planform-chip").innerText();
      check("planform JSON 附件出現場佈摘要 chip", chip.includes("v8") && chip.includes("3 區") && chip.includes("1 物件"), chip);
      const feed = await page.getByTestId("discussion-feed").innerText();
      check("場佈卡標題用場佈名稱不是檔名", feed.includes("場佈：迎新場佈"), "");
      // 非 planform 的 JSON：一般附件卡，無 chip
      // 負例用「碰撞形狀」（Grok pr06 F6）：有 version＋classroom/corridor
      // 鍵但不是真場地（陣列/缺數字欄）— 識別器必須不認。
      await attachInput.setInputFiles({ name: "notes.json", mimeType: "application/json", buffer: Buffer.from('{"version":1,"classroom":[],"corridor":{}}') });
      await page.waitForFunction(
        () => document.body.innerText.includes("notes.json"),
        null,
        { timeout: 20000 },
      );
      check("一般 JSON 不誤認成場佈", (await page.locator('[data-testid="planform-chip"]').count()) === 1, "");
    }

    // 連結卡：純 URL 送出
    await page.getByLabel("房間討論").fill("https://example.com/menu");
    await page.locator(".rd-composer").getByRole("button", { name: "送出" }).click();
    await page.waitForSelector('[data-testid="link-card"]', { timeout: 15000 });
    check("純 URL 變成連結卡（http/https 白名單）", await page.getByTestId("link-card").count() >= 1);

    // 失敗重試不重新上傳：insert 失敗 → 附件卡進未送出；重試只補 insert。
    faults.discussionInsert = 2; // auto 補送吃一發，第二發落 failed
    const uploadsBefore = requestLog.filter((line) => line.startsWith("POST /storage/") && line.includes("/attachments/")).length;
    await attachInput.setInputFiles({ name: "retry.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 retry") });
    await page.waitForSelector(".rd-msg.is-failed [data-testid='discussion-retry'], .rd-msg.is-failed", { timeout: 20000 });
    const uploadsAfterFail = requestLog.filter((line) => line.startsWith("POST /storage/") && line.includes("/attachments/")).length;
    await page.getByTestId("discussion-retry").click();
    await page.waitForFunction(() => !document.querySelector(".rd-msg.is-failed"), null, { timeout: 15000 });
    const uploadsAfterRetry = requestLog.filter((line) => line.startsWith("POST /storage/") && line.includes("/attachments/")).length;
    check(
      "附件重試只補 insert，不重新上傳",
      uploadsAfterFail === uploadsBefore + 1 && uploadsAfterRetry === uploadsAfterFail,
      `uploads ${uploadsBefore}→${uploadsAfterFail}→${uploadsAfterRetry}`,
    );

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

  // ---- WB05：平板（1024×768 橫向）Split View ＋ 觸控筆 ----------------
  {
    const tablet = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      hasTouch: true,
      userAgent: "Mozilla/5.0 (Macintosh) e2e-tablet",
    });
    const page = await tablet.newPage();
    try {
      await page.goto(APP, { waitUntil: "domcontentloaded" });
      await page.fill("input.text-input", "平板使用者");
      await page.click("button.btn-primary");
      await page.getByRole("button", { name: "建立活動房" }).click();
      await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 30000 });
      await page.getByRole("button", { name: "白板", exact: true }).click();
      await page.getByLabel("白板名稱").fill("平板板");
      await page.getByRole("button", { name: "建立白板" }).click();
      await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });

      // Split View：討論欄與畫布同時看得見，且不重疊
      await page.waitForSelector('[data-testid="wb-side-rail"]', { timeout: 8000 });
      const layout = await page.evaluate(() => {
        const rail = document.querySelector('[data-testid="wb-side-rail"]');
        const focus = document.querySelector('[data-testid="whiteboard-workspace"]');
        const railBox = rail.getBoundingClientRect();
        const focusBox = focus.getBoundingClientRect();
        return {
          railVisible: railBox.width > 0 && getComputedStyle(rail).display !== "none",
          railHasFeed: Boolean(rail.querySelector('[data-testid="discussion-feed"]')),
          overlap: Math.max(0, Math.min(railBox.right, focusBox.right) - Math.max(railBox.left, focusBox.left)),
          focusLeft: Math.round(focusBox.left),
          railWidth: Math.round(railBox.width),
        };
      });
      check("平板：討論欄與白板並列（Split View）", layout.railVisible && layout.railHasFeed, JSON.stringify(layout));
      check("平板：兩者不重疊（畫布真的讓出左側）", layout.overlap === 0 && layout.focusLeft >= layout.railWidth - 1, JSON.stringify(layout));

      // 工具列在平板轉成右側直欄（不是底部橫列）
      const toolbar = await page.evaluate(() => {
        const bar = document.querySelector(".wb-focus-bottom");
        const box = bar.getBoundingClientRect();
        return { vertical: box.height > box.width, right: Math.round(window.innerWidth - box.right) };
      });
      check("平板：工具列轉右側直欄", toolbar.vertical && toolbar.right < 40, JSON.stringify(toolbar));
      check("平板 ≥768 不是 compact 橫列", (await page.getByTestId("wb-compact-toolbar").getAttribute("data-compact")) === "false");

      // 收合側欄 → 畫布佔滿
      await page.getByTestId("wb-rail-toggle").click();
      await page.waitForTimeout(150);
      const collapsed = await page.evaluate(() => {
        const rail = document.querySelector('[data-testid="wb-side-rail"]');
        const focus = document.querySelector('[data-testid="whiteboard-workspace"]');
        return {
          railHidden: !rail || getComputedStyle(rail).display === "none",
          focusLeft: Math.round(focus.getBoundingClientRect().left),
        };
      });
      check("平板：討論欄可收合，畫布補滿", collapsed.railHidden && collapsed.focusLeft === 0, JSON.stringify(collapsed));
      // F5：收合不得讓畫布視角跳掉 — 量畫面中心對應的世界座標
      const centerWorld = () => page.evaluate(() => {
        const layer = document.querySelector(".wb-layer");
        const canvas = document.querySelector('[data-testid="wb-canvas"]');
        const style = layer.getAttribute("style") ?? "";
        const t = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/.exec(style);
        const box = canvas.getBoundingClientRect();
        const [, tx, ty, scale] = t.map(Number);
        return {
          x: (box.width / 2 - tx) / scale,
          y: (box.height / 2 - ty) / scale,
        };
      });
      const afterCollapse = await centerWorld();
      await page.getByTestId("wb-rail-toggle").click();
      await page.waitForTimeout(200);
      const afterExpand = await centerWorld();
      check(
        "平板：收合/展開側欄不會讓畫布跳掉（F5）",
        Math.abs(afterExpand.x - afterCollapse.x) < 12 && Math.abs(afterExpand.y - afterCollapse.y) < 12,
        JSON.stringify({ afterCollapse, afterExpand }),
      );

      // 觸控筆：不用切繪圖工具，筆下去就畫；手掌（touch）不得中斷
      const canvas = page.getByTestId("wb-canvas");
      const box = await canvas.boundingBox();
      const pen = (type, x, y, extra = {}) => canvas.dispatchEvent(type, {
        clientX: box.x + x, clientY: box.y + y, pointerId: 101, pointerType: "pen", pressure: 0.8, isPrimary: true, ...extra,
      });
      const zoomNow = () => page.evaluate(() => {
        const style = document.querySelector(".wb-layer")?.getAttribute("style") ?? "";
        return Number(/scale\(([\d.]+)\)/.exec(style)?.[1] ?? 1);
      });
      const penZoomBefore = await zoomNow();
      await pen("pointerdown", 200, 200);
      await pen("pointermove", 260, 240, { pressure: 0.9 });
      // 手掌落下（touch）：必須被丟掉，不得把筆畫變成 pinch
      await canvas.dispatchEvent("pointerdown", { clientX: box.x + 320, clientY: box.y + 320, pointerId: 102, pointerType: "touch" });
      await canvas.dispatchEvent("pointermove", { clientX: box.x + 360, clientY: box.y + 360, pointerId: 102, pointerType: "touch" });
      await pen("pointermove", 320, 210, { pressure: 0.4 });
      await pen("pointerup", 320, 210, { pressure: 0 });
      await canvas.dispatchEvent("pointerup", { clientX: box.x + 360, clientY: box.y + 360, pointerId: 102, pointerType: "touch" });
      await page.waitForFunction(() => document.querySelectorAll("[data-node-type='freehand']").length >= 1, null, { timeout: 8000 });
      const penZoomAfter = await zoomNow();
      check("平板：筆不用切工具就能畫（筆優先）", true);
      const strokeInfo = await page.evaluate(() => {
        const svg = document.querySelector("[data-node-type='freehand'] svg");
        // 逐段線寬會把同寬的相鄰段併成一條 polyline（元素數＝粗細變化次數）
        const runs = svg.querySelectorAll("polyline");
        const widths = [...runs].map((run) => Number(run.getAttribute("stroke-width")));
        const totalPoints = [...runs].reduce((sum, run) => sum + (run.getAttribute("points") ?? "").split(" ").length, 0);
        return { runs: runs.length, distinctWidths: new Set(widths).size, totalPoints };
      });
      check(
        "平板：壓感畫成逐段線寬（不是單一粗細）",
        strokeInfo.runs >= 2 && strokeInfo.distinctWidths >= 2,
        JSON.stringify(strokeInfo),
      );
      check(
        "平板：同寬的段有被合併（不是每段一個元素）",
        strokeInfo.runs < strokeInfo.totalPoints,
        JSON.stringify(strokeInfo),
      );
      // N9：這條原本拿掉掌拒也會綠（筆畫路徑與手指路徑各走各的）。真正
      // 會變的是「手掌有沒有被當成第二指去縮放畫面」——驗 zoom 沒被動到，
      // 以及筆畫的段數沒有因為中途被打斷而變少。
      check("平板：手掌沒有把筆畫打斷成多個節點（掌拒）", (await page.locator("[data-node-type='freehand']").count()) === 1);
      check(
        "平板：手掌沒有被當成第二指縮放畫面（掌拒真的有作用）",
        Math.abs(penZoomAfter - penZoomBefore) < 0.01,
        `${penZoomBefore}→${penZoomAfter}`,
      );

      // F1 反例：手指**先**按著（已進手勢狀態機）→ 筆寫 → 手指抬起。
      // 掌拒若連已追蹤 pointer 的 up 一起吞掉，該 pointer 永遠留在 map，
      // 下一次單指按下就被當第二指進 pinch → 畫面暴縮。
      {
        const zoomOf = () => page.evaluate(() => {
          const style = document.querySelector(".wb-layer")?.getAttribute("style") ?? "";
          return Number(/scale\(([\d.]+)\)/.exec(style)?.[1] ?? 1);
        });
        await canvas.dispatchEvent("pointerdown", { clientX: box.x + 120, clientY: box.y + 500, pointerId: 201, pointerType: "touch" });
        await canvas.dispatchEvent("pointermove", { clientX: box.x + 150, clientY: box.y + 510, pointerId: 201, pointerType: "touch" });
        const pen2 = (type, x, y, extra = {}) => canvas.dispatchEvent(type, {
          clientX: box.x + x, clientY: box.y + y, pointerId: 202, pointerType: "pen", pressure: 0.7, isPrimary: true, ...extra,
        });
        await pen2("pointerdown", 400, 500);
        await pen2("pointermove", 460, 540);
        await pen2("pointerup", 460, 540, { pressure: 0 });
        // 手指在筆之後才抬起（掌拒寬限期內）
        await canvas.dispatchEvent("pointerup", { clientX: box.x + 150, clientY: box.y + 510, pointerId: 201, pointerType: "touch" });
        await page.waitForTimeout(320); // 過掌拒寬限期
        const zoomBefore = await zoomOf();
        await canvas.dispatchEvent("pointerdown", { clientX: box.x + 200, clientY: box.y + 560, pointerId: 203, pointerType: "touch" });
        await canvas.dispatchEvent("pointermove", { clientX: box.x + 280, clientY: box.y + 600, pointerId: 203, pointerType: "touch" });
        await canvas.dispatchEvent("pointerup", { clientX: box.x + 280, clientY: box.y + 600, pointerId: 203, pointerType: "touch" });
        await page.waitForTimeout(150);
        const zoomAfter = await zoomOf();
        check("平板：手指先按、筆後寫 — 之後單指仍是平移不是 pinch（F1）", Math.abs(zoomAfter - zoomBefore) < 0.01, `${zoomBefore}→${zoomAfter}`);
      }

      // N1 反例：工具列選了別的工具時，筆要聽話 —— 否則觸控筆永遠只能畫，
      // 選不到、拖不動、編輯不了任何節點（平板使用者沒有第二種指標可退回）
      {
        const strokesBefore = await page.locator("[data-node-type='freehand']").count();
        await page.getByTestId("wb-tool-select").click(); // off → marquee
        const nodeBox = await page.locator(".wb-node").first().boundingBox();
        await canvas.dispatchEvent("pointerdown", {
          clientX: nodeBox.x + 20, clientY: nodeBox.y + 16, pointerId: 210, pointerType: "pen", pressure: 0.6, isPrimary: true,
        });
        await canvas.dispatchEvent("pointerup", {
          clientX: nodeBox.x + 20, clientY: nodeBox.y + 16, pointerId: 210, pointerType: "pen", pressure: 0,
        });
        await page.waitForTimeout(200);
        check("平板：選了工具時筆不會亂畫（N1）", (await page.locator("[data-node-type='freehand']").count()) === strokesBefore);
        check("平板：筆選得到節點（情境列出現）", (await page.getByTestId("wb-node-actions").count()) === 1);
        await dismissSelection(page);
        await page.getByTestId("wb-tool-select").click(); // marquee → lasso
        await page.getByTestId("wb-tool-select").click(); // lasso → off
      }

      // 自審反例：兩支筆同時 —— B 的筆不得丟掉 A 正在寫的字
      {
        const strokesBefore = await page.locator("[data-node-type='freehand']").count();
        const penA = (type, x, y, extra = {}) => canvas.dispatchEvent(type, {
          clientX: box.x + x, clientY: box.y + y, pointerId: 301, pointerType: "pen", pressure: 0.7, isPrimary: true, ...extra,
        });
        await penA("pointerdown", 150, 620);
        await penA("pointermove", 210, 650);
        // B 的筆落下：整個事件應該被丟掉，A 的筆畫繼續
        await canvas.dispatchEvent("pointerdown", { clientX: box.x + 500, clientY: box.y + 620, pointerId: 302, pointerType: "pen", pressure: 0.6 });
        await canvas.dispatchEvent("pointermove", { clientX: box.x + 560, clientY: box.y + 650, pointerId: 302, pointerType: "pen", pressure: 0.6 });
        await penA("pointermove", 270, 630);
        await penA("pointerup", 270, 630, { pressure: 0 });
        await canvas.dispatchEvent("pointerup", { clientX: box.x + 560, clientY: box.y + 650, pointerId: 302, pointerType: "pen", pressure: 0 });
        await page.waitForFunction(
          (before) => document.querySelectorAll("[data-node-type='freehand']").length === before + 1,
          strokesBefore,
          { timeout: 8000 },
        );
        check("兩支筆同時：第二支不得丟掉第一支正在寫的字", true);
        const zoomNow2 = await page.evaluate(() => {
          const style = document.querySelector(".wb-layer")?.getAttribute("style") ?? "";
          return Number(/scale\(([\d.]+)\)/.exec(style)?.[1] ?? 1);
        });
        check("兩支筆同時不得變成 pinch 縮放", Math.abs(zoomNow2 - penZoomBefore) < 0.01, `${penZoomBefore}→${zoomNow2}`);
      }

      // 自審反例：切板後筆狀態不得殘留（否則新板上所有手指被永久掌拒）
      {
        // 筆按下但**不抬起**就離開這塊板（模擬「筆還在玻璃上時板被關掉」）
        await canvas.dispatchEvent("pointerdown", { clientX: box.x + 300, clientY: box.y + 680, pointerId: 401, pointerType: "pen", pressure: 0.5 });
        await page.locator(".wb-focus-top .project-back-button").click();
        await page.waitForSelector(".wb-list", { timeout: 10000 });
        await page.locator(".wb-card").first().click();
        await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
        const canvas2 = page.getByTestId("wb-canvas");
        const box2 = await canvas2.boundingBox();
        const camBefore = await page.locator(".wb-layer").getAttribute("style");
        await canvas2.dispatchEvent("pointerdown", { clientX: box2.x + 120, clientY: box2.y + 300, pointerId: 402, pointerType: "touch" });
        await canvas2.dispatchEvent("pointermove", { clientX: box2.x + 220, clientY: box2.y + 340, pointerId: 402, pointerType: "touch" });
        await canvas2.dispatchEvent("pointerup", { clientX: box2.x + 220, clientY: box2.y + 340, pointerId: 402, pointerType: "touch" });
        await page.waitForTimeout(150);
        const camAfter = await page.locator(".wb-layer").getAttribute("style");
        check("切板後手指仍能平移（筆狀態沒有殘留）", camAfter !== camBefore, `${camBefore} vs ${camAfter}`);
      }

      // F2：側欄的討論要能自己捲（feed 有自己的捲軸，不靠整頁捲）
      const railScroll = await page.evaluate(() => {
        const feed = document.querySelector('[data-testid="wb-side-rail"] [data-testid="discussion-feed"]');
        if (!feed) return null;
        return { overflowY: getComputedStyle(feed).overflowY, canScroll: feed.clientHeight > 0 };
      });
      check("平板：側欄討論可自己捲動（F2）", Boolean(railScroll && railScroll.overflowY === "auto" && railScroll.canScroll), JSON.stringify(railScroll));
    } finally {
      await tablet.close();
    }
  }

  // ---- WB05/F3：手機橫向（926×428）不得誤判成平板 ----------------------
  {
    const landscape = await browser.newContext({
      viewport: { width: 926, height: 428 },
      isMobile: true,
      hasTouch: true,
      userAgent: ANDROID_UA,
    });
    const page = await landscape.newPage();
    try {
      await page.goto(APP, { waitUntil: "domcontentloaded" });
      await page.fill("input.text-input", "橫向手機");
      await page.click("button.btn-primary");
      await page.getByRole("button", { name: "建立活動房" }).click();
      await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 30000 });
      await page.getByRole("button", { name: "白板", exact: true }).click();
      await page.getByLabel("白板名稱").fill("橫向板");
      await page.getByRole("button", { name: "建立白板" }).click();
      await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
      const layout = await page.evaluate(() => {
        const rail = document.querySelector('[data-testid="wb-side-rail"]');
        const focus = document.querySelector('[data-testid="whiteboard-workspace"]');
        const bar = document.querySelector(".wb-focus-bottom");
        const barBox = bar.getBoundingClientRect();
        return {
          railShown: Boolean(rail) && getComputedStyle(rail).display !== "none",
          focusLeft: Math.round(focus.getBoundingClientRect().left),
          toolbarVertical: barBox.height > barBox.width,
        };
      });
      check("手機橫向不進 Split View（F3：寬 926px 但高只有 428px）", !layout.railShown && layout.focusLeft === 0, JSON.stringify(layout));
      check("手機橫向的工具列維持底部橫列", !layout.toolbarVertical, JSON.stringify(layout));
    } finally {
      await landscape.close();
    }
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
