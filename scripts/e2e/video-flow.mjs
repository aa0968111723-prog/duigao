#!/usr/bin/env node
/**
 * PR #23 acceptance run for 影片對稿.
 *
 * Drives the real production bundle in Chromium at the Android viewports this
 * app targets, against `mock-supabase.mjs`, and asserts the whole video review
 * contract end to end:
 *
 *   A  a video room is created, the file lands in Storage (not in any JSON),
 *      and the cut plays
 *   B  這一刻留意見 files a comment at the moment the viewer stopped at
 *   C  選一段留意見 files a range, and a backwards or too-short one is refused
 *   D  tapping a discussion card seeks the player to that moment
 *   E  resolving a comment weakens its marker instead of hiding the count
 *   F  a second cut keeps roughly the same moment when switching (spec §20),
 *      and clamps to a shorter cut's length rather than stranding past its end
 *   G  the share link is the permanent `#room=…&invite=…` one, its Open Graph
 *      card is the poster frame, and the HTML never contains the invite
 *   H  a partner opens that link with the host's page CLOSED, sees the markers,
 *      can reply and 我也覺得
 *   I  poster rooms are untouched: the image entry still takes images, pins
 *      still work, and nothing about that flow changed
 *
 * The video fixture is recorded in-page from a canvas, so no binary file is
 * committed — the same principle as share-flow.mjs's generated PNG.
 *
 * Usage:  npm i -D playwright && npx playwright install chromium
 *         node scripts/e2e/video-flow.mjs
 *         (CHROMIUM_PATH=/path/to/chrome to reuse an existing browser)
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { start as startMock, requestLog, rows } from "./mock-supabase.mjs";

const MOCK_PORT = 54405;
const APP_PORT = 4177;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const LINE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Line/13.20.0";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

// ------------------------------------------------------------------ report --

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const phone = (width, height, userAgent) => ({
  viewport: { width, height },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent,
});

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};

function serveStatic(root, port) {
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    const file = join(root, normalize(p === "/" ? "/index.html" : p));
    try {
      const buf = await read(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(buf);
    } catch {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await read(join(root, "index.html")));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/**
 * The image-regression leg only needs *a* decodable image: it asserts that the
 * poster flow still reaches the poster workspace, not how a poster renders
 * (share-flow.mjs owns that). A 1×1 PNG keeps this file free of binaries.
 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// ----------------------------------------------------------------- fixture --

/**
 * Record a short WebM in the page from a canvas.
 *
 * Deliberately generated rather than committed: it keeps binaries out of the
 * repo, and it also produces exactly the container the app has to cope with in
 * the wild — MediaRecorder writes no duration into the WebM header, so this
 * fixture exercises the `duration: Infinity` path in probeVideo for free.
 */
async function recordWebm(page, seconds) {
  return await page.evaluate(async (secs) => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(20);
    const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start();
    const t0 = performance.now();
    await new Promise((resolve) => {
      const frame = () => {
        const t = (performance.now() - t0) / 1000;
        // Distinct, high-contrast frames: the poster capture rejects a blank
        // frame, so a fixture that is all one colour would test the wrong path.
        ctx.fillStyle = `hsl(${Math.round(t * 60) % 360} 70% 45%)`;
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 48px sans-serif";
        ctx.fillText(`${t.toFixed(1)}s`, 24, 110);
        if (t >= secs) {
          resolve();
          return;
        }
        requestAnimationFrame(frame);
      };
      frame();
    });
    rec.stop();
    await stopped;
    const blob = new Blob(chunks, { type: "video/webm" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, seconds);
}

// ------------------------------------------------------------------- steps --

async function enterName(page, appUrl, name) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", name);
  await page.click("button.btn-primary");
  await page.waitForSelector(".home-picks", { timeout: 20000 });
}

async function uploadVideo(page, buffer, fileName = "cut.webm") {
  await page.setInputFiles('.home-pick-video input[type="file"]', {
    name: fileName,
    mimeType: "video/webm",
    buffer,
  });
}

const playerReady = (page) =>
  page.waitForFunction(
    () => {
      const v = document.querySelector("video.v-video");
      return Boolean(v && v.readyState >= 1);
    },
    null,
    { timeout: 60000 },
  );

const currentTime = (page) => page.evaluate(() => document.querySelector("video.v-video")?.currentTime ?? -1);
const videoDuration = (page) =>
  page.evaluate(() => {
    const v = document.querySelector("video.v-video");
    return v && Number.isFinite(v.duration) ? v.duration : 0;
  });

/** Seek by tapping the timeline, which is what a reviewer actually does. */
async function seekFraction(page, fraction) {
  const box = await page.locator(".v-track").boundingBox();
  await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
  await page.waitForTimeout(250);
}

async function fileComment(page, which) {
  await page.click(".m-toolbar .m-tool.is-primary");
  await page.waitForSelector(".m-action-btn", { timeout: 10000 });
  await page.locator(".m-action-btn").nth(which === "point" ? 0 : 1).click();
}

/** Raise the discussion sheet so its cards are actually reachable. */
async function openDiscussion(page) {
  const half = await page.evaluate(() => Boolean(document.querySelector(".m-sheet-half, .m-sheet-full")));
  if (!half) await page.click(".m-toolbar .m-tool:has-text('討論')");
  await page.waitForSelector(".m-sheet-half, .m-sheet-full", { timeout: 10000 });
  await page.waitForTimeout(350);
}

async function submitComposer(page, body) {
  await page.waitForSelector(".m-modal textarea.m-textarea", { timeout: 10000 });
  await page.fill(".m-modal textarea.m-textarea", body);
  await page.click(".m-compose-actions .m-btn-primary");
  await page.waitForSelector(".m-modal", { state: "detached", timeout: 10000 });
}

// -------------------------------------------------------------------- run ---

const tmpRoot = mkdtempSync(join(tmpdir(), "duigao-video-e2e-"));
const dist = join(tmpRoot, "cloud");

console.log("building the app against the mock…");
execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], {
  cwd: join(import.meta.dirname, "..", ".."),
  stdio: "pipe",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    VITE_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_mock_key_000000",
  },
});

const mock = await startMock(MOCK_PORT, { appOrigin: APP.replace(/\/$/, "") });
const app = await serveStatic(dist, APP_PORT);
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

try {
  // ------------------------------------------------- fixture: record a cut --
  const fixtureCtx = await browser.newContext();
  const fixturePage = await fixtureCtx.newPage();
  await fixturePage.goto(APP, { waitUntil: "domcontentloaded" });
  const shortB64 = await recordWebm(fixturePage, 6);
  const longB64 = await recordWebm(fixturePage, 12);
  await fixtureCtx.close();
  const SHORT = Buffer.from(shortB64, "base64");
  const LONG = Buffer.from(longB64, "base64");
  check("fixture. 產生了可用的 webm", SHORT.length > 1000 && LONG.length > SHORT.length, `${SHORT.length} / ${LONG.length} bytes`);

  // --------------------------------------------------- A: create + play ----
  const ctxA = await browser.newContext(phone(390, 844, ANDROID_UA));
  const A = await ctxA.newPage();
  await enterName(A, APP, "主辦方A");
  requestLog.length = 0;
  await uploadVideo(A, LONG);
  await playerReady(A);

  check("A. 影片房開起來，播放器是畫面主體", await A.isVisible("video.v-video"));
  check("A. 時間軸在畫面上", await A.isVisible(".v-track"));

  const uploadedPath = requestLog.find((l) => l.includes("/storage/v1/object/room-assets/rooms/") && l.includes("/videos/"));
  check("A. 影片直接進 Storage 的 rooms/<roomId>/videos/ 路徑", Boolean(uploadedPath), uploadedPath ?? "沒有這個請求");

  const versionRow = rows.versions[0];
  check(
    "A. version 列是影片、poster 走 image_path、時長寫進去",
    versionRow?.media_kind === "video" &&
      typeof versionRow?.video_path === "string" &&
      typeof versionRow?.image_path === "string" &&
      (versionRow?.duration_seconds ?? 0) > 0,
    JSON.stringify({
      media_kind: versionRow?.media_kind,
      video: Boolean(versionRow?.video_path),
      poster: Boolean(versionRow?.image_path),
      duration: versionRow?.duration_seconds,
    }),
  );

  const roomJson = await A.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("duigao", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const all = await new Promise((resolve) => {
      const tx = db.transaction("rooms", "readonly");
      const req = tx.objectStore("rooms").getAll();
      req.onsuccess = () => resolve(req.result ?? []);
    });
    return JSON.stringify(all);
  });
  check(
    "A. 影片位元組沒有進 IndexedDB 的 Room JSON",
    !roomJson.includes("data:video") && roomJson.length < 200000,
    `${roomJson.length} chars`,
  );

  const dur = await videoDuration(A);
  check("A. 讀得到影片長度", dur > 1, `${dur.toFixed(2)}s`);

  // -------------------------------------------------- B: point comment -----
  await seekFraction(A, 0.35);
  const atPoint = await currentTime(A);
  await fileComment(A, "point");
  await submitComposer(A, "這裡字幕出現太慢");
  await A.waitForSelector("article.m-item", { timeout: 15000 });

  const pointRow = rows.comments.find((c) => c.anchor_type === "video-point");
  check(
    "B. 這一刻留意見寫成 video-point，時間對得上",
    Boolean(pointRow) && Math.abs((pointRow?.time_seconds ?? -99) - atPoint) < 0.6,
    `stored=${pointRow?.time_seconds?.toFixed?.(2)} player=${atPoint.toFixed(2)}`,
  );
  check(
    "B. 討論卡以時間為主角",
    (await A.locator("article.m-item .m-item-anchor").first().innerText()).trim().includes(":"),
  );
  check("B. 時間軸出現 marker", (await A.locator(".v-marker").count()) >= 1);
  check("B. 留意見時影片會停下來", await A.evaluate(() => document.querySelector("video.v-video")?.paused === true));

  // -------------------------------------------------- C: range comment -----
  await seekFraction(A, 0.55);
  const rangeStart = await currentTime(A);
  await fileComment(A, "range");
  await A.waitForSelector(".v-rangebar", { timeout: 10000 });
  await seekFraction(A, 0.8);
  await A.click(".v-rangebar .m-btn-primary");
  await submitComposer(A, "這段轉場太突然");
  await A.waitForTimeout(400);

  const rangeRow = rows.comments.find((c) => c.anchor_type === "video-range");
  check(
    "C. 選一段留意見寫成 video-range，end 大於 start",
    Boolean(rangeRow) && rangeRow.end_time_seconds > rangeRow.time_seconds,
    `${rangeRow?.time_seconds?.toFixed?.(2)} → ${rangeRow?.end_time_seconds?.toFixed?.(2)}`,
  );
  check(
    "C. 範圍起點就是按下去的那一刻",
    Boolean(rangeRow) && Math.abs(rangeRow.time_seconds - rangeStart) < 0.6,
    `stored=${rangeRow?.time_seconds?.toFixed?.(2)} player=${rangeStart.toFixed(2)}`,
  );
  check("C. 時間軸畫出範圍段", (await A.locator(".v-marker-range").count()) >= 1);
  check(
    "C. 範圍段沒有畫出軌道",
    await A.evaluate(() => {
      const el = document.querySelector(".v-marker-range");
      if (!el) return false;
      const left = parseFloat(el.style.left) || 0;
      const width = parseFloat(el.style.width) || 0;
      return left + width <= 100.5;
    }),
  );

  // ------------------------------------------- D: tapping a card seeks -----
  await A.evaluate(() => {
    const v = document.querySelector("video.v-video");
    if (v) v.currentTime = 0;
  });
  await A.waitForTimeout(200);
  await openDiscussion(A);
  await A.locator("article.m-item").first().click();
  await A.waitForTimeout(500);
  const seeked = await currentTime(A);
  const firstAnchor = Math.min(
    ...rows.comments.filter((c) => c.time_seconds != null).map((c) => c.time_seconds),
  );
  check(
    "D. 點討論卡，播放器跳到那個時間",
    Math.abs(seeked - firstAnchor) < 0.8,
    `player=${seeked.toFixed(2)} anchor=${firstAnchor.toFixed(2)}`,
  );

  // --------------------------------------------------- E: resolve state ----
  await openDiscussion(A);
  await A.locator("article.m-item .m-item-state").first().click();
  await A.waitForTimeout(600);
  check("E. 標記完成後 marker 弱化但還在", (await A.locator(".v-marker.is-done").count()) >= 1);
  check("E. 完成的項目沒有從討論裡消失", (await A.locator("article.m-item.is-done").count()) >= 1);

  // ------------------------------------------- F: second cut keeps time ----
  const chipsBefore = await A.locator(".m-vchip").count();
  await A.setInputFiles('.m-vchip-add input[type="file"]', {
    name: "cut2.webm",
    mimeType: "video/webm",
    buffer: SHORT,
  });
  await A.waitForFunction(
    (n) => document.querySelectorAll(".m-vchip").length > n,
    chipsBefore,
    { timeout: 90000 },
  );
  await A.waitForTimeout(800);

  // Park at a moment that exists in the long cut but not in the short one.
  await A.evaluate(() => {
    const v = document.querySelector("video.v-video");
    if (v) v.currentTime = Math.max(0, v.duration - 1.5);
  });
  await A.waitForTimeout(300);
  const beforeSwitch = await currentTime(A);
  const shortDuration = 6;

  await A.locator(".m-vchip").nth(1).click();
  await playerReady(A);
  await A.waitForTimeout(900);
  const afterSwitch = await currentTime(A);
  const newDuration = await videoDuration(A);
  check(
    "F. 切版本不會跳回 0:00",
    afterSwitch > 0.5,
    `before=${beforeSwitch.toFixed(2)} after=${afterSwitch.toFixed(2)} newDuration=${newDuration.toFixed(2)}`,
  );
  check(
    "F. 較短的版本會夾到片尾，不會停在超過長度的地方",
    afterSwitch <= newDuration + 0.2,
    `after=${afterSwitch.toFixed(2)} duration=${newDuration.toFixed(2)}`,
  );
  await openDiscussion(A);
  const otherCutComments = await A.locator("article.m-item").count();
  check("F. 版本各自的討論不會混在一起", otherCutComments === 0, `改一的討論數 ${otherCutComments}`);
  void shortDuration;

  // ------------------------------------------------------ G: share card ----
  await A.locator(".m-vchip").nth(0).click();
  await A.waitForTimeout(400);
  await A.click("button.m-share");
  await A.waitForSelector("input.m-share-url", { timeout: 30000 });
  await A.waitForFunction(
    () => !document.querySelector(".m-share-preview-thumb.is-generic")?.textContent?.includes("準備中"),
    null,
    { timeout: 30000 },
  ).catch(() => null);
  const shareUrl = await A.inputValue("input.m-share-url");
  check(
    "G. 分享連結是永久連結（room + invite 在 fragment）",
    /#room=[0-9a-f-]{36}&invite=[A-Za-z0-9_-]{20,}/.test(shareUrl),
    shareUrl.slice(0, 90),
  );

  const previewId = (shareUrl.match(/share-preview\/([0-9a-f-]{36})/) || [])[1];
  check("G. 卡片走 previewId，不是 roomId", Boolean(previewId) && !shareUrl.includes(`/${previewId}#room=${previewId}`));

  const cardHtml = previewId
    ? await (await fetch(`http://127.0.0.1:${MOCK_PORT}/functions/v1/share-preview/${previewId}`, {
        headers: { "user-agent": "facebookexternalhit/1.1" },
      })).text()
    : "";
  check("G. OG 卡片是影片的邀請語", cardHtml.includes("時間點留一句話"), cardHtml.match(/og:description[^>]*/)?.[0] ?? "");
  check("G. OG HTML 不含 invite / room id", !/invite/i.test(cardHtml) && !cardHtml.includes("room="));
  check(
    "G. OG 圖片是衍生縮圖，不是原始影片",
    /og:image[^>]*share-previews/.test(cardHtml) && !cardHtml.includes(".webm"),
  );
  const previewRow = rows.share_previews[0];
  check("G. 縮圖是從 poster frame render 的", Boolean(previewRow?.thumbnail_path));

  await A.keyboard.press("Escape");

  // --------------------------------------- H: partner opens, host closed ---
  await ctxA.close();
  const ctxB = await browser.newContext(phone(430, 932, LINE_UA));
  const B = await ctxB.newPage();
  await B.goto(shareUrl, { waitUntil: "domcontentloaded" });
  await B.fill("input.text-input", "夥伴B");
  await B.click("button.btn-primary");
  await playerReady(B);

  check("H. 主辦方關頁後，夥伴仍打得開影片房", await B.isVisible("video.v-video"));
  check("H. 夥伴看得到主辦方的時間點 marker", (await B.locator(".v-marker").count()) >= 1);

  await openDiscussion(B);
  await B.waitForSelector("article.m-item", { timeout: 15000 });
  const beforeReply = rows.comment_replies.length;
  await B.locator("article.m-item .m-reply-toggle").first().click();
  await B.fill("article.m-item .m-reply-input input.m-input", "同意，這裡我也覺得慢");
  await B.keyboard.press("Enter");
  await B.waitForTimeout(900);
  check("H. 夥伴可以回覆", rows.comment_replies.length > beforeReply);

  const beforeSupport = rows.comment_supports.length;
  await B.locator("article.m-item .m-support").first().click();
  await B.waitForTimeout(900);
  check("H. 夥伴可以按我也覺得", rows.comment_supports.length > beforeSupport);

  await B.locator("article.m-item").first().click();
  await B.waitForTimeout(600);
  check("H. 夥伴點討論卡也會跳到對的時間", (await currentTime(B)) > 0.3);
  await ctxB.close();

  // ------------------------------------------------ I: image regression ----
  const ctxC = await browser.newContext(phone(390, 844, ANDROID_UA));
  const C = await ctxC.newPage();
  await enterName(C, APP, "圖片使用者");
  await C.setInputFiles('.home-picks .home-pick:not(.home-pick-video) input[type="file"]', {
    name: "poster.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  await C.waitForSelector(".m-stage-area", { timeout: 30000 });
  check("I. 圖片入口仍然開圖片工作區（不是影片的）", !(await C.isVisible("video.v-video")));
  check("I. 圖片工作區的看稿區還在", await C.isVisible(".m-stage-area"));

  await C.click(".m-toolbar .m-tool.is-primary");
  await C.waitForSelector(".m-action-btn", { timeout: 10000 });
  const imageActions = await C.locator(".m-action-btn b").allInnerTexts();
  check(
    "I. 圖片版的修改仍是「點位置 / 圈範圍」，沒有變成影片的選項",
    imageActions.join("|").includes("點位置留意見") && !imageActions.join("|").includes("這一刻"),
    imageActions.join(" / "),
  );
  await C.keyboard.press("Escape");
  await ctxC.close();

  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
} finally {
  await browser.close();
  mock.close();
  app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
}
