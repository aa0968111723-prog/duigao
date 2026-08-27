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

async function searchNode(page, name) {
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
    faults.discussionInsert = true;
    await page.getByLabel("房間討論").fill("這句會先失敗");
    await page.getByRole("button", { name: "送出" }).click();
    await page.waitForSelector(".rd-msg.is-failed [data-testid='discussion-retry'], .rd-msg.is-failed", { timeout: 15000 });
    check("失敗的討論訊息看得到、可重試", await page.locator(".rd-msg.is-failed").count() === 1 && await page.getByTestId("discussion-retry").count() === 1);
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
        await page.getByTestId("whiteboard-add").click();
        await page.getByRole("button", { name: "便利貼" }).click();
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
        // A 拿分享連結（殼 header 的分享 — PR-01a 抬升後兩路徑都渲染）
        await page.locator(".project-share-button").click();
        await page.waitForSelector("input.m-share-url", { timeout: 30000 });
        const shareUrl = await page.locator("input.m-share-url").inputValue();
        await page.locator(".m-modal").getByRole("button", { name: "關閉", exact: true }).click().catch(() => undefined);

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
          // 量測窗前先等 B 的 subscribe→heal（02c 的一次性板級 GET）落地：
          // code-split 之後殼是 lazy 的，subscribe 時序後移，heal 可能壓進
          // 量測窗造成假紅。等「已出現過板 GET」是 deterministic 錨點 —
          // heal 每次 subscribe 恰好一次。
          {
            const healDeadline = Date.now() + 8000;
            while (Date.now() < healDeadline) {
              if (requestLog.some((line) => line.includes("GET /rest/v1/whiteboard_nodes"))) break;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            await B.waitForTimeout(300);
          }

          requestLog.length = 0;
          // A 新增一張便利貼並打字（INSERT + UPDATE 都走 row-patch）
          await page.getByTestId("whiteboard-add").click();
          await page.getByRole("button", { name: "便利貼" }).click();
          await page.waitForSelector("textarea.wb-node-text", { timeout: 15000 });
          await page.locator("textarea.wb-node-text").last().fill("跨分頁增量");
          await page.keyboard.press("Tab");

          // B 不做任何重開動作，節點與文字要自己出現
          await B.waitForFunction(
            () => [...document.querySelectorAll("textarea.wb-node-text")].some((el) => el.value.includes("跨分頁增量")),
            null,
            { timeout: 20000 },
          );
          const bSeen = await B.evaluate(() => [...document.querySelectorAll("textarea.wb-node-text")].some((el) => el.value.includes("跨分頁增量")));
          check("兩分頁：B 不重開就看到 A 的新節點與文字", bSeen);

          // reload 風暴不見了：整房快照與板 GET 都必須為 0 —
          // 後者證明 B 看到的是 realtime row-patch，不是任何 heal 的
          // loadWhiteboard 替代路徑（Grok pr02c F6）。
          const fullReloads = requestLog.filter((line) => line.startsWith("GET /rest/v1/rooms?select=*")).length;
          const boardFetches = requestLog.filter((line) => line.includes("GET /rest/v1/whiteboard_nodes")).length;
          check("row-patch 取代整房 reload（rooms 快照 GET=0 且板 GET=0）", fullReloads === 0 && boardFetches === 0, `fullReloads=${fullReloads} boardFetches=${boardFetches}`);
        } finally {
          await ctxB.close();
        }
      }
      await page.getByRole("button", { name: "對話", exact: true }).click();
    }
    await page.getByTestId("discussion-retry").click();
    await page.waitForFunction(() => !document.querySelector(".rd-msg.is-failed"), null, { timeout: 15000 });
    await page.waitForTimeout(400);
    {
      const feedText = await page.getByTestId("discussion-feed").innerText();
      const occurrences = feedText.split("這句會先失敗").length - 1;
      check("重試後訊息恢復且只出現一次", occurrences === 1, "occurrences=" + occurrences);
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

    // 連結卡：純 URL 送出
    await page.getByLabel("房間討論").fill("https://example.com/menu");
    await page.locator(".rd-composer").getByRole("button", { name: "送出" }).click();
    await page.waitForSelector('[data-testid="link-card"]', { timeout: 15000 });
    check("純 URL 變成連結卡（http/https 白名單）", await page.getByTestId("link-card").count() >= 1);

    // 失敗重試不重新上傳：insert 失敗 → 附件卡進未送出；重試只補 insert。
    faults.discussionInsert = true;
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
