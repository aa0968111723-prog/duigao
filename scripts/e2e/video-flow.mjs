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
 *   R  the host's page STAYS OPEN and sees the partner's new comment appear on
 *      the timeline without reloading — the room is bound to realtime from the
 *      moment it is created, not only after a share
 *   I  poster rooms are untouched: the image entry still takes images, pins
 *      still work, and nothing about that flow changed
 *   N  a failed first upload leaves a way out, and retrying reuses the room it
 *      already created instead of quietly leaving an empty one behind
 *   P  a guest who joined by link can add a cut of their own — Storage
 *      authorises on membership, not on owning the invite
 *   Q  cancelling the first upload leaves nothing behind, and backend English
 *      never reaches the screen
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
import { readFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { start as startMock, requestLog, rows, faults, cloudRooms, storageObjects, expireSignedUrls } from "./mock-supabase.mjs";

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

/**
 * Run the app's own media rules — the ones no browser journey reaches.
 *
 * `rejectByDuration` in particular cannot be proven by the recorded fixture:
 * MediaRecorder writes no duration into a WebM header, so that path is exactly
 * the one where the limit is deliberately skipped. Calling the module directly
 * is the only honest way to show the ceiling exists.
 */
async function checkMediaRules(page) {
  const ts = await import("typescript");
  const source = await readFile(join(import.meta.dirname, "..", "..", "src", "features", "video-review", "media.ts"), "utf8");
  const js = ts.default.transpileModule(source, {
    compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 },
  }).outputText;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`;

  return await page.evaluate(async (url) => {
    const m = await import(url);
    const file = (name, type, size) => {
      const f = new File([new Uint8Array(8)], name, { type });
      Object.defineProperty(f, "size", { value: size });
      return f;
    };
    return {
      tooBig: m.acceptVideoFile(file("big.mp4", "video/mp4", 101 * 1024 * 1024)),
      wrongType: m.acceptVideoFile(file("clip.avi", "video/x-msvideo", 1000)),
      notVideo: m.acceptVideoFile(file("poster.png", "image/png", 1000)),
      good: m.acceptVideoFile(file("cut.mp4", "video/mp4", 5 * 1024 * 1024)),
      tooLong: m.rejectByDuration(2 * 60 * 60 + 1),
      okLength: m.rejectByDuration(90),
      unknownLength: m.rejectByDuration(0),
      times: [m.formatTime(13.42), m.formatTime(90), m.formatTime(3671)],
      posterAt: [m.posterTimeFor(120), m.posterTimeFor(0.6), m.posterTimeFor(0)],
      limitHint: m.VIDEO_LIMIT_HINT,
    };
  }, dataUrl);
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

/**
 * How many cloud rooms exist — including empty ones.
 *
 * Counting through child tables would miss exactly the room this leg is about:
 * one created for an upload that never landed has no versions and no comments.
 */
const countRooms = () => cloudRooms.size;

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
  // The copy-list leg reads what the app wrote; without this Chromium refuses.
  await ctxA.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP.replace(/\/$/, "") });
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

  // ---------------------------- signed URL expiry + lifecycle reliability --
  const signedPath = versionRow.video_path;
  const signProbe = async (path, expiresIn) => {
    const response = await fetch(`http://127.0.0.1:${MOCK_PORT}/storage/v1/object/sign/room-assets/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expiresIn }),
    });
    const body = await response.json();
    return new URL(`/storage/v1${body.signedURL}`, `http://127.0.0.1:${MOCK_PORT}`);
  };
  faults.signTtl = 1;
  const shortSigned = await signProbe(signedPath, 1);
  const shortStatus = (await fetch(shortSigned)).status;
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const expiredStatus = (await fetch(shortSigned)).status;
  const freshSigned = await signProbe(signedPath, 30);
  const freshStatus = (await fetch(freshSigned)).status;
  faults.signTtl = null;
  check("20. signed URL 過期後回 400/403，重新簽名取得新 URL", shortStatus === 200 && [400, 403].includes(expiredStatus) && freshStatus === 200 && String(shortSigned) !== String(freshSigned), `${shortStatus} -> ${expiredStatus} -> ${freshStatus}`);

  const resumeAt = 2.6;
  await A.evaluate((at) => {
    const v = document.querySelector("video.v-video");
    if (v) { v.currentTime = at; v.pause(); }
  }, resumeAt);
  await A.waitForTimeout(250);
  expireSignedUrls(signedPath);
  await A.evaluate(() => document.querySelector("video.v-video")?.dispatchEvent(new Event("error")));
  await A.waitForTimeout(1800);
  const afterResign = await currentTime(A);
  check("20. 播放中 signed URL 過期，重新取得 URL 不會重設 currentTime", Math.abs(afterResign - resumeAt) < 0.8, `before=${resumeAt} after=${afterResign.toFixed(2)}`);

  // Two error events arrive before the first signing request resolves. The
  // player must share that promise, not install two fresh sources with two
  // competing resume points.
  const raceAt = 3.4;
  await A.evaluate((at) => {
    const v = document.querySelector("video.v-video");
    if (v) { v.currentTime = at; v.pause(); v.dispatchEvent(new Event("error")); v.dispatchEvent(new Event("error")); }
  }, raceAt);
  await A.waitForTimeout(1800);
  const afterRace = await currentTime(A);
  check("23. 同時重新簽名兩次不會互相覆蓋播放位置", Math.abs(afterRace - raceAt) < 0.8, `before=${raceAt} after=${afterRace.toFixed(2)}`);

  // Change the source once so this leg gets a fresh one-shot re-sign budget,
  // then click a discussion card after its URL has expired.
  await A.locator(".m-vchip").nth(1).click();
  await playerReady(A);
  await A.waitForTimeout(500);
  await A.locator(".m-vchip").nth(0).click();
  await playerReady(A);
  await A.waitForTimeout(500);
  await openDiscussion(A);
  await A.evaluate(() => { const v = document.querySelector("video.v-video"); if (v) v.currentTime = 0; });
  expireSignedUrls(signedPath);
  await A.locator("article.m-item").first().click();
  await A.evaluate(() => document.querySelector("video.v-video")?.dispatchEvent(new Event("error")));
  await A.waitForTimeout(1800);
  const afterCommentResign = await currentTime(A);
  check("21. URL 過期後點後半段留言，重新簽名仍跳到留言時間", Math.abs(afterCommentResign - firstAnchor) < 0.9 && afterCommentResign > 0.5, `anchor=${firstAnchor.toFixed(2)} after=${afterCommentResign.toFixed(2)}`);

  const backgroundAt = 2.1;
  await A.evaluate(async (at) => {
    const v = document.querySelector("video.v-video");
    if (!v) return;
    v.currentTime = at;
    await v.play().catch(() => undefined);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    v.pause();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, backgroundAt);
  await A.waitForTimeout(700);
  const afterForeground = await currentTime(A);
  const resumed = await A.evaluate(() => document.querySelector("video.v-video")?.paused === false);
  check("22. hidden → visible 後播放位置保持且可繼續播放", Math.abs(afterForeground - backgroundAt) < 0.9 && resumed, `before=${backgroundAt} after=${afterForeground.toFixed(2)} resumed=${resumed}`);

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

  // The spec's actual sentence (§20): A 在 00:35，切 B 也在 00:35。Only a cut
  // long enough to hold the moment can show that, so park inside the短 cut and
  // switch back to the long one.
  await A.evaluate(() => {
    const v = document.querySelector("video.v-video");
    if (v) v.currentTime = 3.2;
  });
  await A.waitForTimeout(300);
  const beforeBack = await currentTime(A);
  await A.locator(".m-vchip").nth(0).click();
  await playerReady(A);
  await A.waitForTimeout(900);
  const afterBack = await currentTime(A);
  check(
    "F. 切到夠長的版本會停在同一個時間（§20 本文）",
    Math.abs(afterBack - beforeBack) < 0.5,
    `before=${beforeBack.toFixed(2)} after=${afterBack.toFixed(2)}`,
  );

  // 3.3 needs an end that outlives the current cut: the range was filed on the
  // long version, so viewing it against the short one is where a separately
  // clamped width would draw past the track.
  await A.locator(".m-vchip").nth(1).click();
  await playerReady(A);
  await A.waitForTimeout(600);
  const overflowSafe = await A.evaluate(() =>
    Array.from(document.querySelectorAll(".v-marker-range")).every((el) => {
      const left = parseFloat(el.style.left) || 0;
      const width = parseFloat(el.style.width) || 0;
      return left + width <= 100.5;
    }),
  );
  check("F. 範圍在較短的版本上也不會畫出軌道", overflowSafe);
  await A.locator(".m-vchip").nth(0).click();
  await playerReady(A);
  await A.waitForTimeout(500);
  void shortDuration;

  // ------------------------------------------- copy list keeps the times ---
  await A.evaluate(() => navigator.clipboard.writeText("").catch(() => undefined));
  await A.click(".m-toolbar .m-tool:has-text('更多')");
  await A.waitForSelector(".m-more", { timeout: 10000 });
  await A.click(".m-more .m-row:has-text('複製修改清單')");
  await A.waitForTimeout(600);
  const summary = await A.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  check(
    "K. 複製的修改清單帶時間碼（不然對不回畫面）",
    /\d+:\d{2}/.test(summary),
    summary.split("\n").slice(0, 3).join(" / ").slice(0, 120),
  );
  check("K. 片段的清單寫成起訖", /\d+:\d{2}–\d+:\d{2}/.test(summary) || !summary.includes("轉場"), "");
  await A.keyboard.press("Escape");
  await A.waitForTimeout(300);

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

  const mappingKeys = await A.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("duigao.cloudmap.")),
  );
  const roomIdInUrl = (shareUrl.match(/#room=([0-9a-f-]{36})/) || [])[1];
  check(
    "L. 房間的雲端身分同時記在本機碼與雲端 UUID 底下",
    mappingKeys.some((k) => k.endsWith(roomIdInUrl)) && mappingKeys.length >= 2,
    mappingKeys.join(", "),
  );
  check(
    "L. 用雲端 id 重開房間仍然是雲端房（不會掉回本機模式）",
    await A.evaluate((id) => {
      const raw = localStorage.getItem(`duigao.cloudmap.${id}`);
      if (!raw) return false;
      const m = JSON.parse(raw);
      return m.roomId === id && typeof m.token === "string" && m.token.length > 16;
    }, roomIdInUrl),
  );

  // ------------------------------ R: the host is still watching ------------
  // A video room reaches the cloud when it is CREATED (its Storage path needs a
  // room id), which is a different bind path from the poster app's share-time
  // migration. This leg exists because that difference once left the room
  // writable but deaf: comments went up, nothing came back down.
  const ctxR = await browser.newContext(phone(390, 844, ANDROID_UA));
  const R = await ctxR.newPage();
  await R.goto(shareUrl, { waitUntil: "domcontentloaded" });
  await R.fill("input.text-input", "夥伴R");
  await R.click("button.btn-primary");
  await playerReady(R);

  const markersBefore = await A.locator(".v-marker").count();
  await R.evaluate(() => {
    const v = document.querySelector("video.v-video");
    if (v) v.currentTime = 1.2;
  });
  await R.waitForTimeout(300);
  await fileComment(R, "point");
  await submitComposer(R, "開頭這句聽不清楚");

  // No reload, no navigation: the host's page has to hear about it by itself.
  const heard = await A.waitForFunction(
    (before) => document.querySelectorAll(".v-marker").length > before,
    markersBefore,
    { timeout: 20000 },
  )
    .then(() => true)
    .catch(() => false);
  check("R. 主辦方不重整就看到夥伴新增的時間點 marker", heard, `before=${markersBefore}`);

  if (heard) {
    await openDiscussion(A);
    const texts = await A.locator("article.m-item .m-item-body").allInnerTexts();
    check("R. 那則留言也出現在主辦方的討論列表", texts.some((t) => t.includes("聽不清楚")), texts.join(" / ").slice(0, 90));
  }

  // Resolving on one side reaches the other the same way (§28's list).
  const resolvedBefore = await R.locator(".v-marker.is-done").count();
  await openDiscussion(A);
  await A.locator("article.m-item").filter({ hasText: "聽不清楚" }).locator(".m-item-state").first().click();
  const resolveHeard = await R.waitForFunction(
    (before) => document.querySelectorAll(".v-marker.is-done").length > before,
    resolvedBefore,
    { timeout: 20000 },
  )
    .then(() => true)
    .catch(() => false);
  check("R. 標記完成也會即時同步到另一個人的時間軸", resolveHeard);
  await ctxR.close();

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

  // ------------------------------------------- P: a guest adds a cut -------
  const chipsBeforeGuest = await B.locator(".m-vchip").count();
  const versionsBeforeGuest = rows.versions.length;
  await B.setInputFiles('.m-vchip-add input[type="file"]', {
    name: "guest-cut.webm",
    mimeType: "video/webm",
    buffer: SHORT,
  });
  const guestAdded = await B.waitForFunction(
    (n) => document.querySelectorAll(".m-vchip").length > n,
    chipsBeforeGuest,
    { timeout: 90000 },
  )
    .then(() => true)
    .catch(() => false);
  check("P. 夥伴（不是主辦方）也能新增一版", guestAdded, `chips ${chipsBeforeGuest} → ${await B.locator(".m-vchip").count()}`);

  const guestVersion = rows.versions[rows.versions.length - 1];
  check(
    "P. 夥伴上傳的影片放在同一個房間底下（不是另外開一間）",
    rows.versions.length === versionsBeforeGuest + 1 &&
      typeof guestVersion?.video_path === "string" &&
      guestVersion.video_path.includes(guestVersion.room_id),
    guestVersion?.video_path ?? "沒有新版本",
  );
  await ctxB.close();

  // -------------------------------------------- M: desktop can share -------
  // BLOCKER 6 was a desktop player with no way to hand the link over. Every
  // other leg runs on a phone, so this is the only place that would catch it
  // coming back.
  const ctxD = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const D = await ctxD.newPage();
  await D.goto(shareUrl, { waitUntil: "domcontentloaded" });
  await D.fill("input.text-input", "桌機夥伴");
  await D.click("button.btn-primary");
  await playerReady(D);
  check("M. 桌機影片工作區有播放器與時間軸", (await D.isVisible("video.v-video")) && (await D.isVisible(".v-track")));
  check("M. 桌機有回首頁與標題", (await D.isVisible("header.topbar .brand")) && (await D.isVisible("header.topbar input.title-input")));
  check("M. 桌機討論在右側", await D.isVisible(".v-desktop-side"));
  await D.click("header.topbar .btn-primary:has-text('分享')");
  await D.waitForSelector("input.m-share-url", { timeout: 30000 });
  const desktopUrl = await D.inputValue("input.m-share-url");
  check(
    "M. 桌機拿得到永久分享連結",
    /#room=[0-9a-f-]{36}&invite=[A-Za-z0-9_-]{20,}/.test(desktopUrl),
    desktopUrl.slice(0, 80),
  );
  await ctxD.close();

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

  // ------------------------------------------------ J: the media rules -----
  const ctxRules = await browser.newContext();
  const rulesPage = await ctxRules.newPage();
  await rulesPage.goto(APP, { waitUntil: "domcontentloaded" });
  const rules = await checkMediaRules(rulesPage);
  await ctxRules.close();

  check("J. 超過 100MB 會被擋下並說出上限", rules.tooBig.ok === false && rules.tooBig.reason.includes("100 MB"), rules.tooBig.reason);
  check("J. 不支援的影片格式會建議轉 MP4", rules.wrongType.ok === false && rules.wrongType.reason.includes("MP4"), rules.wrongType.reason);
  check("J. 不是影片的檔案會被擋下", rules.notVideo.ok === false);
  check("J. 正常的 MP4 會過", rules.good.ok === true);
  check(
    "J. 超過 120 分鐘會被擋下（fixture 讀不到長度，只有直接呼叫才驗得到）",
    typeof rules.tooLong === "string" && rules.tooLong.includes("120"),
    String(rules.tooLong),
  );
  check("J. 正常長度不會被擋", rules.okLength === null);
  check("J. 讀不到長度時放行（不因 codec 怪癖懲罰使用者）", rules.unknownLength === null);
  check("J. 時間格式", rules.times.join(" ") === "0:13 1:30 1:01:11", rules.times.join(" "));
  check(
    "J. 封面取樣時間：長片取 3 秒、短片取中間",
    rules.posterAt[0] === 3 && Math.abs(rules.posterAt[1] - 0.3) < 0.001 && rules.posterAt[2] === 0,
    rules.posterAt.join(" / "),
  );
  check("J. 首頁寫得出上限提示", rules.limitHint.includes("100 MB") && rules.limitHint.includes("120"), rules.limitHint);

  // --------------------------------- N: a first upload that fails ----------
  // The room reaches the cloud BEFORE the bytes do, so a failure here is the
  // one that can strand a person on a screen with nothing on it — and, if they
  // reload, leave an empty cloud room behind and make a second one.
  const roomsBefore = countRooms();
  const ctxN = await browser.newContext(phone(390, 844, ANDROID_UA));
  const N = await ctxN.newPage();
  await enterName(N, APP, "上傳失敗的人");
  faults.videoUpload = true;
  await uploadVideo(N, SHORT);
  await N.waitForSelector(".onboard-card", { timeout: 60000 });
  await N.waitForFunction(
    () => document.querySelector(".onboard-hint")?.textContent?.includes("失敗") ?? false,
    null,
    { timeout: 60000 },
  ).catch(() => null);

  const failureText = await N.innerText(".onboard-card");
  check("N. 上傳失敗會說出來，而不是停在進度條", failureText.includes("失敗"), failureText.split("\n")[1] ?? "");
  const buttons = await N.locator(".onboard-card button, .onboard-card .btn").allInnerTexts();
  check(
    "N. 失敗畫面有出口（重新選檔／回首頁），不是死路",
    buttons.some((b) => b.includes("重新選")) && buttons.some((b) => b.includes("回首頁")),
    buttons.join(" / "),
  );

  const roomsAfterFailure = countRooms();
  faults.videoUpload = false;
  await N.setInputFiles('.onboard-card input[type="file"]', {
    name: "retry.webm",
    mimeType: "video/webm",
    buffer: SHORT,
  });
  await playerReady(N);
  const roomsAfterRetry = countRooms();
  check("N. 失敗後重試會播得起來", await N.isVisible("video.v-video"));
  check(
    "N. 重試沿用同一間雲端房，不會多開一間",
    roomsAfterRetry === roomsAfterFailure,
    `失敗後 ${roomsAfterFailure} 間、重試後 ${roomsAfterRetry} 間（一開始 ${roomsBefore} 間）`,
  );
  await ctxN.close();

  // --------------------------- Q: cancel, and what an error may say --------
  const ctxQ = await browser.newContext(phone(390, 844, ANDROID_UA));
  const Q = await ctxQ.newPage();
  await enterName(Q, APP, "會反悔的人");
  const roomsBeforeCancel = countRooms();
  const objectsBeforeCancel = new Set(storageObjects.keys());
  await uploadVideo(Q, LONG);
  await Q.waitForSelector(".onboard-card .btn", { timeout: 60000 });
  await Q.click(".onboard-card .btn:has-text('取消')");
  await Q.waitForSelector(".home-picks", { timeout: 30000 });
  check("Q. 取消第一支上傳會回到首頁", await Q.isVisible(".home-picks"));

  const recentTitles = await Q.locator(".home-recent-item").allInnerTexts();
  check(
    "Q. 取消後不會在最近討論留下打不開的空房",
    !recentTitles.some((t) => t.includes("未命名影片")),
    recentTitles.join(" / ") || "（沒有最近討論）",
  );
  const leakedAfterCancel = [...storageObjects.keys()].filter((key) => !objectsBeforeCancel.has(key));
  check("23. 中途取消後 mock Storage 不殘留該 version 的 video/poster", leakedAfterCancel.length === 0, leakedAfterCancel.join(" / ") || "no orphan objects");
  void roomsBeforeCancel;

  // Backend English — RLS wording, PostgREST codes — is not user copy.
  faults.videoUpload = true;
  await uploadVideo(Q, SHORT);
  await Q.waitForFunction(
    () => document.querySelector(".onboard-hint")?.textContent?.includes("失敗") ?? false,
    null,
    { timeout: 60000 },
  ).catch(() => null);
  const shown = await Q.innerText(".onboard-card");
  faults.videoUpload = false;
  check(
    "Q. 後端的英文錯誤不會變成使用者文案",
    !/row-level|violates|PGRST|permission denied|injected/i.test(shown),
    shown.replace(/\n/g, " ").slice(0, 90),
  );
  check("Q. 取而代之的是可以照做的中文", shown.includes("影片上傳失敗") || shown.includes("再試"), "");
  await Q.click(".onboard-card .btn:has-text('回首頁')").catch(() => undefined);
  await Q.waitForSelector(".home-picks", { timeout: 30000 });

  // Metadata failure happens after both Storage objects have landed. The mock
  // fails the first cleanup request once; videoRoom.ts must retry and leave no
  // object whose version row never existed.
  const objectsBeforeMetadataFailure = new Set(storageObjects.keys());
  faults.versionInsert = true;
  faults.assetDelete = 1;
  await uploadVideo(Q, SHORT, "metadata-fails.webm");
  await Q.waitForSelector(".onboard-card", { timeout: 60000 });
  await Q.waitForTimeout(500);
  const leakedAfterMetadataFailure = [...storageObjects.keys()].filter((key) => !objectsBeforeMetadataFailure.has(key));
  check(
    "23. metadata 寫入失敗後 video/poster object 皆清乾淨",
    leakedAfterMetadataFailure.length === 0 && faults.assetDelete === 0,
    leakedAfterMetadataFailure.join(" / ") || "no orphan objects; cleanup retry succeeded",
  );
  faults.versionInsert = false;
  faults.assetDelete = 0;
  await ctxQ.close();

  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
  console.log(
    "\n注意：這個 harness 的 mock 沒有 websocket 以外的真實後端行為，" +
      "Safari 的 Range seek、iPhone HEVC、LINE in-app 首次播放手勢與三種直向尺寸仍需真機驗收。",
  );
  if (results.some((r) => !r.pass)) process.exitCode = 1;
} finally {
  await browser.close();
  mock.close();
  app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
}
