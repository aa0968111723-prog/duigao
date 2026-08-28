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

async function dismissSelection(page) {
  // WB02：選取節點時情境列取代主工具列 — 開主工具列動作前先取消選取
  const dismiss = page.locator(".wb-context-dismiss");
  if (await dismiss.count()) await dismiss.click();
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
    check("入口 chips 取代四分頁", await page.locator(".project-entry-chips button").count() === 3 && await page.locator(".project-tabs").count() === 0);
    check("語音是一行邊界說明，不佔 pane", (await page.getByTestId("voice-boundary").innerText()).includes("語音") && await page.getByTestId("voice-boundary").locator("button").count() === 0);

    await chooseCreate(page, "擺攤計畫", "plan");
    await page.waitForSelector('[data-testid="plan-editor"]', { timeout: 10000 });
    await page.locator(".project-back-button").click({ force: true });
    await page.waitForSelector(".project-entry-chips", { timeout: 10000 });

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
    check("房間討論可送出文字", (await page.getByTestId("discussion-feed").innerText()).includes("先把招生流程攤在白板上"));

    await page.getByRole("button", { name: "白板", exact: true }).click();
    await page.getByLabel("白板名稱").fill("招生規劃");
    await page.getByRole("button", { name: "建立白板" }).click();
    await page.waitForSelector('[data-testid="whiteboard-workspace"]', { timeout: 10000 });
    check("可建立並打開白板", await page.getByTestId("wb-canvas").count() === 1);

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

    await dismissSelection(page);
    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /擺攤文宣/ }).click();
    await dismissSelection(page);
    await page.getByTestId("whiteboard-add").click();
    await page.getByRole("button", { name: "放入房間內容" }).click();
    await page.getByTestId("wb-content-picker").getByRole("button", { name: /擺攤計畫/ }).click();
    await dismissSelection(page);
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
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    await page.screenshot({ path: join("/opt/cursor/artifacts", "collaboration_workspace_board.png"), fullPage: true });

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
        // WB02 Focus Mode：殼 header 在全屏層之下 — 先退出白板拿分享連結
        await page.locator(".wb-focus-top .project-back-button").click();
        await page.waitForSelector(".wb-list", { timeout: 10000 });
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
        const stillVisible = await page.evaluate(() =>
          [...document.querySelectorAll("textarea.wb-node-text")].some((el) => el.value.includes("離線寫的節點")),
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
} finally {
  await browser?.close();
  mock?.close();
  app?.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
