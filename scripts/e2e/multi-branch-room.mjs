#!/usr/bin/env node
/**
 * Android-sized acceptance run for 同房多分支 1.0.
 *
 * The journey uses the real production bundle and the repository's Supabase
 * stand-in. It intentionally starts with a local project room, exercises the
 * mobile shell and then creates a video branch; that last step promotes the
 * room to cloud storage and proves that branch data survives the migration.
 *
 * Covered here:
 *   - simple first-screen mobile navigation
 *   - plan/checklist editing and cross-content relation
 *   - room-level decision poll
 *   - poster and video branches with independent content
 *   - branch-targeted share URL kept in the fragment
 *   - Android viewport overflow and branch deep-link reopening
 *
 * Usage: npm run test:multi-branch-e2e
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { requestLog, start as startMock } from "./mock-supabase.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = 54408;
const APP_PORT = 4180;
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

const phone = (width, height) => ({
  viewport: { width, height },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: ANDROID_UA,
});

function browserOptions() {
  if (process.env.CHROMIUM_PATH) return { executablePath: process.env.CHROMIUM_PATH };
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    const executablePath = candidates.find((candidate) => existsSync(candidate));
    if (executablePath) return { executablePath };
  }
  return {};
}

const noHorizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** Create a short real WebM in Chromium; no committed media fixture is needed. */
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
  if (await current.getByRole("button", { name: type === "plan" ? "企劃" : type === "poster" ? "文宣" : "影片", exact: true }).count()) {
    await current.getByRole("button", { name: type === "plan" ? "企劃" : type === "poster" ? "文宣" : "影片", exact: true }).click();
  }
  await current.locator('input:not([type="file"])').first().fill(name);
  if (file) await current.locator('input[type="file"]').setInputFiles(file);
  await current.locator("button.project-submit").click();
}

async function closePushedPane(page) {
  // 面板關閉是 state 更新；點擊與 unmount 之間可能夾著 realtime 重繪，
  // 用「點到消失為止」的輪詢取代單次點擊。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const back = page.locator(".project-push-head .project-back-button");
    if (!(await back.count())) return;
    await back.click({ force: true }).catch(() => undefined);
    const gone = await page.waitForFunction(() => !document.querySelector(".project-push-pane"), null, { timeout: 3000 }).then(() => true).catch(() => false);
    if (gone) return;
  }
  throw new Error("push pane did not close");
}

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-multi-branch-"));
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

  const context = await browser.newContext(phone(390, 844));
  const page = await context.newPage();
  try {
    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await page.fill("input.text-input", "活動房測試者");
    await page.click("button.btn-primary");
    await page.waitForSelector(".home-picks", { timeout: 20000 });
    await page.getByRole("button", { name: /建立活動房/ }).click();
    await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 10000 });

    // 討論就是房間殼：進房第一屏是討論 feed + composer + 三個入口 chips，
    // 不再有互相競爭的四分頁（PR-01a）。
    check(
      "Android 手機第一屏就是討論殼",
      await page.getByTestId("discussion-feed").count() === 1
        && await page.getByLabel("房間討論").count() === 1
        && await page.locator(".project-entry-chips button").count() === 3
        && await page.locator(".project-tabs, .project-bottom-nav").count() === 0,
    );
    check("活動房首頁沒有 desktop sidebar", await page.locator(".sidebar, .desktop-sidebar").count() === 0);
    check("390×844 沒有水平溢出", await noHorizontalOverflow(page));
    await page.getByTestId("open-overview-pane").click();
    check("新活動房顯示清楚空狀態", (await page.locator(".project-welcome").innerText()).includes("這間房還沒有內容"));
    await closePushedPane(page);
    check("總覽面板返回後回到討論殼", await page.getByTestId("discussion-feed").count() === 1);

    await chooseCreate(page, "擺攤計畫", "plan");
    await page.waitForSelector('[data-testid="plan-editor"]', { timeout: 10000 });
    await page.getByRole("button", { name: "＋段落" }).click();
    await page.locator('input[aria-label="段落內容"]').fill("目標：招募新生");
    await page.getByRole("button", { name: "＋待辦" }).click();
    await page.locator('input[aria-label="完成項目"]').check();
    await page.getByRole("button", { name: "完成" }).click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('input[aria-label="段落內容"]')).some((input) => input.value === "目標：招募新生") && document.querySelector('input[aria-label="完成項目"]')?.checked === true,
      null,
      { timeout: 10000 },
    );
    check("手機企劃可快速編輯段落與 checkbox", await page.locator('input[aria-label="段落內容"]').first().inputValue() === "目標：招募新生" && await page.locator('input[aria-label="完成項目"]').isChecked());

    await page.locator(".project-back-button").click();
    await page.getByTestId("open-content-pane").click();
    const poster = { name: "演講文宣", mimeType: "image/png", buffer: TINY_PNG };
    await page.getByRole("button", { name: /新增文宣/ }).click();
    const posterSheet = page.getByTestId("create-content-sheet");
    await posterSheet.locator('input:not([type="file"])').first().fill(poster.name);
    await posterSheet.locator('input[type="file"]').setInputFiles(poster);
    await posterSheet.locator("button.project-submit").click();
    await page.waitForSelector(".m-stage-area .stage", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector("img.stage-img")?.naturalWidth > 0, null, { timeout: 20000 });
    check("文宣分支進入既有 review workspace", await page.locator(".m-stage-area img.stage-img").count() === 1);
    // 對稿是 overlay：殼在底下持續掛著，不是整棵樹替換（PR-01a 核心）。
    check("對稿 overlay 打開時討論殼仍掛著", await page.getByTestId("branch-workspace-overlay").count() === 1 && await page.getByTestId("multi-branch-room").count() === 1);
    await page.locator("button.m-home").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="branch-workspace-overlay"]'), null, { timeout: 20000 });
    check("返回後回到討論殼（不需重新載入）", await page.getByTestId("discussion-feed").count() === 1);
    // 推進面板的狀態會跨 overlay 保留（建立文宣前開的內容面板還在）——
    // 這是設計行為；要去總覽先把它收起來。
    check("內容面板狀態跨對稿 overlay 保留", await page.getByTestId("content-pane").count() === 1);
    await closePushedPane(page);

    await page.getByTestId("open-overview-pane").click();
    const decisions = page.getByTestId("decisions");
    await decisions.getByRole("button", { name: "＋ 新增" }).click();
    const pollSheet = page.getByRole("dialog", { name: "新增待決策" });
    const pollInputs = pollSheet.locator("input");
    await pollInputs.nth(0).fill("茶會文宣 A / B 哪版？");
    await pollInputs.nth(1).fill("A 版");
    await pollInputs.nth(2).fill("B 版");
    await pollSheet.getByRole("button", { name: "建立" }).click();
    await page.waitForSelector('[data-testid^="poll-"]', { timeout: 10000 });
    await page.getByRole("button", { name: "A 版" }).click();
    check("總覽可直接建立與投票待決策", (await decisions.innerText()).includes("茶會文宣 A / B 哪版？") && (await decisions.innerText()).includes("1 人已投") && await decisions.locator(".project-poll-option.is-chosen").count() === 1);
    await closePushedPane(page);

    await page.getByTestId("open-plan-pane").click();
    await page.locator('[data-testid="plan-branches"] .project-branch-card').filter({ hasText: "擺攤計畫" }).click();
    await page.locator('select[aria-label="選擇相關內容"]').selectOption({ label: "演講文宣" });
    await page.getByRole("button", { name: "加入" }).click();
    check("企劃可關聯文宣且只顯示相關內容", (await page.locator(".project-related").innerText()).includes("演講文宣"));
    await page.locator(".project-related").getByRole("button", { name: "移除演講文宣" }).click();
    check("企劃關聯可以移除", !(await page.locator(".project-related-list").innerText()).includes("演講文宣"));
    await page.locator('select[aria-label="選擇相關內容"]').selectOption({ label: "演講文宣" });
    await page.getByRole("button", { name: "加入" }).click();
    await page.locator(".project-back-button").click();

    const videoBytes = await recordWebm(page);
    await page.getByTestId("open-content-pane").click();
    await page.getByRole("button", { name: /新增影片/ }).click();
    const videoSheet = page.getByTestId("create-content-sheet");
    await videoSheet.locator('input:not([type="file"])').first().fill("招生影片");
    await videoSheet.locator('input[type="file"]').setInputFiles({ name: "admission.webm", mimeType: "video/webm", buffer: videoBytes });
    await videoSheet.locator("button.project-submit").click();
    await page.waitForSelector("video.v-video", { timeout: 90000 });
    check("影片分支沿用既有播放器並能載入", await page.locator("video.v-video").count() === 1);
    check("影片分支沒有把文宣版本串進來", await page.locator(".m-vchip:not(.m-vchip-add)").count() === 1);
    await page.locator("button.m-home").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="branch-workspace-overlay"]'), null, { timeout: 15000 });
    // 影片是從內容面板建立的：返回後面板仍開著（狀態保留），先數卡再收合。
    await page.waitForFunction(() => document.querySelectorAll('.project-branch-card').length >= 2, null, { timeout: 15000 });
    await closePushedPane(page);
    await page.getByTestId("open-overview-pane").click();
    await page.waitForFunction(() => document.querySelectorAll('.project-branch-card').length >= 1, null, { timeout: 15000 });
    {
      const overviewTexts = await page.locator(".project-update-row, .project-branch-card").allTextContents();
      check("同一房間可同時看文宣、影片、企劃分支", ["演講文宣", "招生影片", "擺攤計畫"].every((name) => overviewTexts.some((text) => text.includes(name))), overviewTexts.join(" / "));
    }
    await closePushedPane(page);

    // A branch share is intentionally checked from a real workspace. The
    // preview path may change, but its fragment must remain the app target.
    await page.getByTestId("open-content-pane").click();
    await page.locator('[data-testid="poster-branches"] .project-branch-card').filter({ hasText: "演講文宣" }).click();
    await page.locator("button.m-share").click();
    await page.waitForSelector("input.m-share-url", { timeout: 30000 });
    const sharedUrl = await page.locator("input.m-share-url").inputValue();
    const shared = new URL(sharedUrl);
    check("分享指定內容時 branch / version 都留在 fragment", shared.search === "" && shared.hash.includes("branch=") && shared.hash.includes("item="), sharedUrl);
    await page.locator(".m-modal").getByRole("button", { name: "關閉", exact: true }).click();

    const deepLink = `${APP}${shared.hash}`;
    const shareHash = new URL(sharedUrl).hash;
    const hashParams = new URLSearchParams(shareHash.slice(1));
    const rootHash = `#room=${encodeURIComponent(hashParams.get("room") ?? "")}&invite=${encodeURIComponent(hashParams.get("invite") ?? "")}`;
    requestLog.length = 0;
    const rootContext = await browser.newContext(phone(390, 844));
    const rootPage = await rootContext.newPage();
    try {
      await rootPage.goto(`${APP}${rootHash}`, { waitUntil: "domcontentloaded" });
      await rootPage.fill("input.text-input", "總覽懶載入測試者");
      await rootPage.click("button.btn-primary");
      await rootPage.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 30000 });
      await rootPage.waitForTimeout(450);
      const firstPaintRequests = requestLog.join("\n");
      check(
        "活動房總覽 lazy load 不下載所有版本與原始媒體",
        firstPaintRequests.includes("/rest/v1/rpc/get_room_branch_summaries")
          && !firstPaintRequests.includes("/rest/v1/versions?")
          && !firstPaintRequests.includes("/storage/v1/object/sign/room-assets/"),
        firstPaintRequests,
      );
    } finally {
      await rootContext.close();
    }

    const deepContext = await browser.newContext(phone(390, 844));
    const deepPage = await deepContext.newPage();
    try {
      await deepPage.goto(deepLink, { waitUntil: "domcontentloaded" });
      await deepPage.fill("input.text-input", "分支連結測試者");
      await deepPage.click("button.btn-primary");
      await deepPage.waitForSelector("input[aria-label=\"文宣名稱\"]", { timeout: 30000 });
      check("branch deep-link 直接開到指定文宣", await deepPage.locator('input[aria-label="文宣名稱"]').inputValue() === "演講文宣");
    } finally {
      await deepContext.close();
    }

    mkdirSync(join(ROOT, "output", "playwright"), { recursive: true });
    await page.screenshot({ path: join(ROOT, "output", "playwright", "multi-branch-mobile.png"), fullPage: true });
    check("手機活動房完成 journey 後仍沒有水平溢出", await noHorizontalOverflow(page));
  } catch (error) {
    check("同房多分支手機 acceptance journey", false, (error instanceof Error ? error.stack : String(error)).slice(0, 600));
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
