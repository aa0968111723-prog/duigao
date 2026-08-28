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
import { faults, requestLog, rows, start as startMock } from "./mock-supabase.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
// 共用機器上別的專案可能已經佔著這些 port（planform-iso 的 vite preview
// 就用 4180）。預設值不變，需要時以環境變數讓路 — 不必去動別人的程序。
const MOCK_PORT = Number(process.env.DUIGAO_E2E_MOCK_PORT || 54408);
const APP_PORT = Number(process.env.DUIGAO_E2E_APP_PORT || 4180);
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
  mock = await startMock(MOCK_PORT, { cutosBridge: true, voiceToken: true, canvaBridge: true });
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
      { timeout: 30000 },
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
    // 上傳期間活動房必須有東西在動。這條檢查存在的原因是它曾經整個沒有：
    // App 的上傳進度畫面排在活動房殼的 return 之後，專案房永遠走不到，
    // 使用者選完檔案看到的是一個完全靜止的畫面（上傳其實正在跑）。
    faults.videoUploadDelayMs = 8000;
    await videoSheet.locator("button.project-submit").click();
    {
      let statusText = "";
      try {
        await page.waitForSelector('[data-testid="project-upload-status"]', { timeout: 20000 });
        statusText = await page.getByTestId("project-upload-status").innerText();
      } catch {
        statusText = "";
      }
      check(
        "活動房上傳影片時看得到進度（不是靜止畫面）",
        /上傳|準備|處理/.test(statusText),
        statusText.replace(/\s+/g, " ").slice(0, 60) || "沒有狀態列",
      );
      // 建立內容之後 App 會把人帶進這條新分支（activeBranchId），而它還沒有
      // 版本 — 就是使用者回報的那個畫面。上傳跑著的時候那裡不可以還擺一顆
      // 按了會被上傳鎖擋掉的「＋ 加入影片」。
      // 建立內容之後 App 會把人帶進這條新分支（activeBranchId），而它還沒有
      // 版本 — 就是使用者回報的那個畫面。上傳跑著的時候那裡不可以還擺一顆
      // 按了會被上傳鎖擋掉的「＋ 加入影片」。
      let inflightSeen = false;
      try {
        await page.waitForFunction(
          () =>
            !!document.querySelector('[data-testid="branch-upload-inflight"]') &&
            !document.querySelector(".project-branch-empty-detail .project-upload-button"),
          null,
          { timeout: 20000 },
        );
        inflightSeen = true;
      } catch {
        inflightSeen = false;
      }
      check(
        "上傳中的空分支不再擺一顆按了沒反應的按鈕",
        inflightSeen,
        inflightSeen
          ? ""
          : (await page.evaluate(() => document.querySelector(".project-branch-detail")?.innerText?.slice(0, 120) ?? "沒有分支詳情")).replace(/\s+/g, " "),
      );
    }
    faults.videoUploadDelayMs = 0;
    await page.waitForSelector("video.v-video", { timeout: 90000 });
    check(
      "上傳完成後狀態列自己收掉",
      (await page.getByTestId("project-upload-status").count()) === 0,
    );
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

    // 上傳失敗這條路以前是最糟的：畫面沒有進度、錯誤 toast 兩秒半就自己
    // 消失，而空分支上那顆按鈕看起來還能按。更糟的是上傳鎖有機會沒放掉，
    // 之後每一次點擊都被靜靜擋掉 — 按鈕從此完全沒有反應。
    {
      faults.videoUpload = true;
      await page.getByTestId("open-content-pane").click();
      await page.getByRole("button", { name: /新增影片/ }).click();
      const failSheet = page.getByTestId("create-content-sheet");
      await failSheet.locator('input:not([type="file"])').first().fill("擺攤影片");
      await failSheet.locator('input[type="file"]').setInputFiles({ name: "booth.webm", mimeType: "video/webm", buffer: videoBytes });
      await failSheet.locator("button.project-submit").click();

      let failText = "";
      try {
        await page.waitForFunction(
          () => document.querySelector('[data-testid="project-upload-status"]')?.classList.contains("is-error"),
          null,
          { timeout: 60000 },
        );
        failText = await page.getByTestId("project-upload-status").innerText();
      } catch {
        failText = "";
      }
      faults.videoUpload = false;
      check("上傳失敗在活動房裡看得到（不是只有會消失的 toast）", failText.length > 0, failText.replace(/\s+/g, " ").slice(0, 60) || "沒有錯誤狀態列");

      // 鎖真的放掉了：空分支的入口必須回來，而且是能再按的那一顆。
      let retryable = false;
      try {
        await page.waitForFunction(
          () =>
            !!document.querySelector(".project-branch-empty-detail .project-upload-button") &&
            !document.querySelector('[data-testid="branch-upload-inflight"]'),
          null,
          { timeout: 30000 },
        );
        retryable = true;
      } catch {
        retryable = false;
      }
      check(
        "失敗後「＋ 加入影片」可以再按一次（上傳鎖沒被鎖死）",
        retryable,
        retryable
          ? ""
          : (await page.evaluate(() => document.querySelector(".project-branch-detail")?.innerText?.slice(0, 120) ?? "沒有分支詳情")).replace(/\s+/g, " "),
      );

      await page.getByTestId("project-upload-status").getByRole("button", { name: "知道了" }).click();
      check("按「知道了」收掉錯誤狀態列", (await page.getByTestId("project-upload-status").count()) === 0);

      await page.locator(".project-back-button").click();
      await closePushedPane(page);
    }

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
      // one-shot：返回討論殼後，別的 realtime 快照不得把人再推回分支
      //（Grok pr01a F6/F7）。用一句討論訊息當 nudge。
      await deepPage.locator("button.m-home").click();
      await deepPage.waitForFunction(() => !document.querySelector('[data-testid="branch-workspace-overlay"]'), null, { timeout: 15000 });
      await deepPage.getByLabel("房間討論").fill("nudge 一下");
      await deepPage.getByRole("button", { name: "送出" }).click();
      await deepPage.waitForFunction(() => document.querySelector('[data-testid="discussion-feed"]')?.textContent?.includes("nudge 一下"), null, { timeout: 15000 });
      await deepPage.waitForTimeout(600);
      check("deep-link 是一次性的：返回後快照不再推回分支", !(await deepPage.getByTestId("branch-workspace-overlay").count()));
    } finally {
      await deepContext.close();
    }

    // ---- PR-07：CUTOS 成品匯入（S2S bridge，真實 edge 源碼） ----------
    {
      // 前一段停在文宣 workspace overlay：先回到討論殼再收面板，fab 才在。
      await page.locator("button.m-home").click().catch(() => undefined);
      await page.waitForFunction(() => !document.querySelector('[data-testid="branch-workspace-overlay"]'), null, { timeout: 20000 });
      await closePushedPane(page);
      // health gate 是 5 分鐘快取；本流程房間早已 bound，入口應已出現。
      await page.locator(".project-fab").click();
      await page.waitForSelector('[data-testid="create-content-sheet"]', { timeout: 15000 });
      const optionVisible = await page.getByTestId("cutos-import-option").count();
      check("CUTOS 匯入入口在健檢通過後出現", optionVisible === 1);
      await page.getByTestId("cutos-import-option").click();
      await page.getByLabel("名稱").fill("CUTOS 成品影片");
      await page.getByTestId("cutos-project-id").fill("cutos-demo");
      await page.getByRole("button", { name: "匯入", exact: true }).click();
      // 成功會關 sheet；版本列落在 mock 的 versions 表（video_path 齊備）
      await page.waitForFunction(() => !document.querySelector('[data-testid="create-content-sheet"]'), null, { timeout: 30000 });
      const imported = rows.versions.find((row) => row.label === "CUTOS 成品影片");
      check("CUTOS 匯入落成影片版本列（video_path＋mp4）", Boolean(imported && String(imported.video_path || "").endsWith("original.mp4")), `row=${JSON.stringify(imported ?? null).slice(0, 120)}`);
      const importedBranch = rows.room_branches.find((row) => row.name === "CUTOS 成品影片");
      check("匯入建立了對應的影片分支（FK 齊備）", Boolean(importedBranch) && imported?.branch_id === importedBranch?.id, `branch=${importedBranch?.id ?? "none"} version.branch_id=${imported?.branch_id ?? "none"}`);

      // NO_EXPORT：還沒渲染過的專案 → 誠實文案、sheet 留著可改
      faults.cutosOutputProjectId = null;
      await page.locator(".project-fab").click();
      await page.waitForSelector('[data-testid="create-content-sheet"]', { timeout: 15000 });
      await page.getByTestId("cutos-import-option").click();
      await page.getByLabel("名稱").fill("沒有成品的專案");
      await page.getByTestId("cutos-project-id").fill("cutos-demo");
      await page.getByRole("button", { name: "匯入", exact: true }).click();
      const noExportShown = await page.waitForFunction(
        () => document.querySelector(".project-sheet-error")?.textContent?.includes("還沒有渲染過成品") ?? false,
        null,
        { timeout: 30000 },
      ).then(() => true).catch(() => false);
      const errText = await page.locator(".project-sheet-error").innerText().catch(() => "");
      check("沒有成品時的文案可照做（先在 CUTOS 按輸出）", noExportShown && errText.includes("先在 CUTOS 按輸出"), errText.slice(0, 60));
      // 連按重試不增生分支（Grok 07 F4）：沿用同一條
      const branchesBefore = rows.room_branches.filter((row) => row.name === "沒有成品的專案").length;
      await page.getByRole("button", { name: "匯入", exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".project-sheet")?.textContent?.includes("匯入中"), null, { timeout: 30000 });
      const branchesAfter = rows.room_branches.filter((row) => row.name === "沒有成品的專案").length;
      check("重試沿用同一條分支，不增生", branchesBefore === 1 && branchesAfter === 1, `before=${branchesBefore} after=${branchesAfter}`);
      faults.cutosOutputProjectId = "cutos-demo";
      await page.locator(".project-sheet-close").click();
    }

    // ---- PR-05：Canva 文宣匯入（OAuth bridge，真實 edge 源碼） --------
    {
      // (0) 未連結：health 過 → 入口出現；面板顯示官方授權引導
      await page.locator(".project-fab").click();
      await page.waitForSelector('[data-testid="create-content-sheet"]', { timeout: 15000 });
      check("Canva 匯入入口在健檢通過後出現", (await page.getByTestId("canva-import-option").count()) === 1);
      await page.getByTestId("canva-import-option").click();
      await page.waitForSelector('[data-testid="canva-connect"]', { timeout: 15000 });
      check("未連結時顯示連結引導，不露設計清單", (await page.getByTestId("canva-design-item").count()) === 0);

      // (1) OAuth 機械（node 側、獨立使用者）：connect-url → authorize 302
      //     → callback 交換。PKCE S256 是 mock 真的驗，state 一次性。
      const canvaMock = `http://127.0.0.1:${MOCK_PORT}`;
      const nodeSession = await fetch(`${canvaMock}/auth/v1/token?grant_type=password`, { method: "POST", body: "{}" }).then((r) => r.json());
      const invokeCanva = (action, extra = {}) =>
        fetch(`${canvaMock}/functions/v1/canva-bridge`, {
          method: "POST",
          headers: { authorization: `Bearer ${nodeSession.access_token}`, "content-type": "application/json" },
          body: JSON.stringify({ action, ...extra }),
        });
      const connectRes = await (await invokeCanva("connect-url")).json();
      check(
        "connect-url：官方授權頁＋PKCE S256，無 secret 外洩",
        Boolean(connectRes.ok) && /code_challenge=/.test(String(connectRes.url)) && /code_challenge_method=S256/.test(String(connectRes.url)) && !/e2e-canva-secret/.test(String(connectRes.url)),
        String(connectRes.url ?? "").slice(0, 110),
      );
      const authorizeRes = await fetch(connectRes.url, { redirect: "manual" });
      const callbackUrl = authorizeRes.headers.get("location") ?? "";
      const cbHtml = await fetch(callbackUrl).then((r) => r.text());
      check("callback 完成 code+verifier 交換（回報已連結）", cbHtml.includes("已連結"), cbHtml.slice(0, 80));
      const nodeConn = rows.canva_connections.find((row) => row.user_id === nodeSession.user.id);
      check("token 落 service 專用表", Boolean(nodeConn && nodeConn.access_token && nodeConn.refresh_token));
      const replayStatus = (await fetch(callbackUrl)).status;
      check("同一 state 重放被拒（一次性消費）", replayStatus === 400, `status=${replayStatus}`);

      // refresh 輪替：把過期時間撥回過去 → 下一次呼叫必須 refresh 並把
      // 輪替後的新 refresh token 落盤（不落盤＝下次斷線）。
      nodeConn.token_expires_at = new Date(Date.now() - 1000).toISOString();
      const listAfterRefresh = await (await invokeCanva("list-designs")).json();
      check("token 過期自動 refresh，清單照拿", Boolean(listAfterRefresh.ok) && listAfterRefresh.designs.length === 2, JSON.stringify(listAfterRefresh).slice(0, 90));
      check("輪替後的 refresh token 已落盤", rows.canva_connections.find((row) => row.user_id === nodeSession.user.id)?.refresh_token === "e2e-canva-rt2");
      check("清單是誠實子集（回應不含任何 token）", !JSON.stringify(listAfterRefresh).includes("e2e-canva-at"));

      // 非成員匯入 page 的房 → 404（房間對外人是不存在的）
      const pageRoomId = rows.room_branches[0]?.room_id;
      const denied = await invokeCanva("import-design", { roomId: pageRoomId, designId: "DAGe2eDesign1" });
      check("非成員匯入 404 ROOM_NOT_FOUND", denied.status === 404);

      // (2) UI：page 使用者標為已連結（同一機械已在 (1) 驗過）→ 清單 →
      //     匯入 → 圖片版本落地、分支 FK 齊備。
      const pageUid = rows.room_branches[0]?.created_by;
      rows.canva_connections.push({
        user_id: pageUid,
        access_token: "e2e-canva-at",
        refresh_token: "e2e-canva-rt",
        token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
      await page.getByTestId("canva-recheck").click();
      await page.waitForSelector('[data-testid="canva-design-item"]', { timeout: 15000 });
      check("已連結後看得到設計清單", (await page.getByTestId("canva-design-item").count()) === 2);
      await page.getByTestId("canva-design-item").first().click();
      await page.getByLabel("名稱").fill("Canva 招生海報");
      await page.getByTestId("canva-import-submit").click();
      await page.waitForFunction(() => !document.querySelector('[data-testid="create-content-sheet"]'), null, { timeout: 30000 });
      const canvaVersion = rows.versions.find((row) => row.label === "Canva 招生海報");
      check(
        "Canva 匯入落成圖片版本列（image_path＋png）",
        Boolean(canvaVersion && String(canvaVersion.image_path || "").endsWith("poster.png") && canvaVersion.mime_type === "image/png"),
        `row=${JSON.stringify(canvaVersion ?? null).slice(0, 120)}`,
      );
      const canvaBranch = rows.room_branches.find((row) => row.name === "Canva 招生海報");
      check("匯入建立了文宣分支（FK 齊備）", Boolean(canvaBranch) && canvaVersion?.branch_id === canvaBranch?.id, `branch=${canvaBranch?.id ?? "none"}`);
    }

    // ---- PR-03：語音房（LiveKit）— token 契約與 UI 誠實性 ------------
    {
      // (1) health 過 → dock 出現（在討論根畫面）
      await page.waitForSelector('[data-testid="voice-dock"]', { timeout: 20000 });
      check("語音 dock 在健檢通過後出現", (await page.getByTestId("voice-dock").count()) === 1);
      check("開場權限：owner 看到「開始語音」", (await page.getByTestId("voice-join").innerText()).includes("開始語音"));

      // (2) token 契約：node 側以獨立使用者對真實 edge 源碼驗簽
      //（HS256 簽名＋claims 形狀 — LiveKit token 的公開契約）
      {
        const mockOrigin = `http://127.0.0.1:${MOCK_PORT}`;
        const tokenRes0 = await fetch(`${mockOrigin}/auth/v1/token?grant_type=password`, { method: "POST", body: "{}" });
        const session = await tokenRes0.json();
        const probeRoom = crypto.randomUUID();
        await fetch(`${mockOrigin}/rest/v1/rpc/create_room_with_invite`, {
          method: "POST",
          headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
          body: JSON.stringify({ p_room_id: probeRoom, p_title: "voice-probe", p_invite_token: "tok-voice-probe-1", p_display_name: "P", p_color: "#111" }),
        });
        const vt = await fetch(`${mockOrigin}/functions/v1/voice-token`, {
          method: "POST",
          headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "token", roomId: probeRoom, displayName: "契約探針" }),
        });
        const minted = await vt.json();
        let claimsOk = false;
        let signatureOk = false;
        if (minted.ok && typeof minted.token === "string") {
          const [h, pl, sig] = minted.token.split(".");
          const payload = JSON.parse(Buffer.from(pl, "base64url").toString("utf8"));
          claimsOk =
            payload.iss === "e2e-livekit-key" &&
            payload.video?.room === `duigao-${probeRoom}` &&
            payload.video?.roomJoin === true &&
            payload.video?.canPublish === true &&
            payload.video?.canPublishData === false &&
            Array.isArray(payload.video?.canPublishSources) &&
            payload.video.canPublishSources.length === 1 &&
            payload.video.canPublishSources[0] === "microphone" &&
            payload.exp - payload.nbf <= 10 * 60 + 20;
          const cryptoMod = await import("node:crypto");
          const expected = cryptoMod.createHmac("sha256", "e2e-livekit-secret-for-harness-only").update(`${h}.${pl}`).digest("base64url");
          signatureOk = expected === sig;
        }
        check("voice token：claims 契約（單房/音訊限定/TTL）", claimsOk, JSON.stringify(minted).slice(0, 100));
        check("voice token：HS256 簽名以 harness secret 驗證通過", signatureOk);
        // 非成員拿不到別房的 token
        const other = await fetch(`${mockOrigin}/auth/v1/token?grant_type=password`, { method: "POST", body: "{}" }).then((r) => r.json());
        const denied = await fetch(`${mockOrigin}/functions/v1/voice-token`, {
          method: "POST",
          headers: { authorization: `Bearer ${other.access_token}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "token", roomId: probeRoom, displayName: "外人" }),
        });
        const deniedBody = await denied.json();
        check("voice token：非成員 404 ROOM_NOT_FOUND", denied.status === 404 && deniedBody.code === "ROOM_NOT_FOUND", JSON.stringify(deniedBody).slice(0, 80));
      }

      // (3) 按「開始語音」：session＋參與者列落 DB；LiveKit 連線對假
      //     wss 失敗 → 誠實錯誤文案（不是假裝已加入）
      await page.getByTestId("voice-join").click();
      // 假 wss 連不上 → join 失敗 → F5 清理（left_at＋end session）會把
      // live 場立刻收掉：正確的終態是「錯誤可見＋沒有殘場」，不是
      // 「live 場還在」。
      const errShown = await page.waitForFunction(
        () => document.querySelector(".rd-voice-error")?.textContent?.includes("失敗") ?? false,
        null,
        { timeout: 30000 },
      ).then(() => true).catch(() => false);
      const errText = await page.locator(".rd-voice-error").innerText().catch(() => "");
      check("假 LiveKit 連不上 → 誠實錯誤文案", errShown && errText.includes("失敗"), errText.slice(0, 60));
      // DB 終態：曾經建場（POST 發生）、失敗即清（live=0、參與者已離場）
      const sessionsEverCreated = rows.voice_sessions.length;
      const liveLeft = rows.voice_sessions.filter((row) => row.status === "live").length;
      const zombieParts = rows.voice_session_participants.filter((row) => !row.left_at).length;
      check("開始語音有真的建場（session 列曾落地）", sessionsEverCreated >= 1, `total=${sessionsEverCreated}`);
      check("連線失敗即清場（無 live 殘場、無在場殭屍）", liveLeft === 0 && zombieParts === 0, `live=${liveLeft} zombies=${zombieParts}`);
      check(
        "不假裝已加入：無離開鈕、join 可再試",
        (await page.getByTestId("voice-leave").count()) === 0 &&
          (await page.getByTestId("voice-join").count()) === 1 &&
          !(await page.getByTestId("voice-join").isDisabled()),
      );
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
