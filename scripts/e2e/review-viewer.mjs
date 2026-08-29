#!/usr/bin/env node
/**
 * Acceptance run for 文宣 Review Viewer 2.0.
 *
 * This drives the real production bundle in Chromium at Android-sized
 * viewports. The poster is generated in memory, and the cloud calls go to the
 * repository's Supabase stand-in, so the journey is repeatable without a
 * project, credentials, or a committed binary fixture.
 *
 * Covered here:
 *   - entering and leaving the immersive viewer
 *   - Fit / 100% / 200%, double-tap, pinch zoom, and pan
 *   - adding a point comment while zoomed
 *   - discussion-card focus and annotation coordinate stability
 *   - Clean View and region-comment focus
 *   - phone overflow and the existing image-review surface
 *
 * Usage: npm run test:review-viewer
 *        (CHROMIUM_PATH=/path/to/chrome to reuse an existing browser)
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { deflateSync } from "node:zlib";
import { start as startMock } from "./mock-supabase.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = 54406;
const APP_PORT = 4178;
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

// A valid PNG, generated rather than committed. Its dimensions are large
// enough to make the 100% and 200% presets observable on a phone.
function makePoster(w = 600, h = 800) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const scanlines = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x += 1) {
      const offset = 1 + x * 3;
      row[offset] = Math.floor((x * 255) / w);
      row[offset + 1] = Math.floor((y * 255) / h);
      row[offset + 2] = 150;
    }
    scanlines.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const POSTER = makePoster();

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

function serveStatic(root, port) {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const file = join(root, normalize(pathname === "/" ? "/index.html" : pathname));
    try {
      const buffer = await read(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(buffer);
    } catch {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await read(join(root, "index.html")));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

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

async function createRoom(page, name) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", name);
  await page.click("button.btn-primary");
  await page.setInputFiles('input[type="file"]', {
    name: "review-poster.png",
    mimeType: "image/png",
    buffer: POSTER,
  });
  await page.waitForSelector("button.m-share", { timeout: 20000 });
  await page.waitForFunction(
    () => [...document.images].some((img) => img.classList.contains("stage-img") && img.complete && img.naturalWidth > 0),
    null,
    { timeout: 20000 },
  );
}

async function openViewer(page) {
  const stage = page.locator(".m-stage-area .stage");
  const box = await stage.boundingBox();
  if (!box) throw new Error("image stage has no bounding box");
  await stage.click({ position: { x: box.width / 2, y: Math.min(box.height / 2, 220) } });
  await page.waitForSelector('[data-testid="immersive-viewer"]', { timeout: 10000 });
}

function readTransform(page) {
  return page.locator(".immersive-stage .stage-content").evaluate((el) => {
    const value = el.style.transform;
    const match = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0px\)\s*scale\(([-\d.]+)\)/.exec(value);
    return {
      value,
      translateX: match ? Number(match[1]) : Number.NaN,
      translateY: match ? Number(match[2]) : Number.NaN,
      scale: match ? Number(match[3]) : Number.NaN,
    };
  });
}

async function dispatchTouch(cdp, type, points) {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map(({ x, y, id }) => ({ x, y, id, radiusX: 8, radiusY: 8 })),
    modifiers: 0,
  });
}

function parseFrameAndTransform(snapshot) {
  const parse = (value) => Number.parseFloat(value ?? "0");
  const transform = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0px\)\s*scale\(([-\d.]+)\)/.exec(snapshot.transform);
  if (!transform) throw new Error(`cannot parse viewer transform: ${snapshot.transform}`);
  const scale = Number(transform[3]);
  const centerX = snapshot.box.width / 2;
  const centerY = snapshot.box.height / 2;
  const unscaledX = centerX + (snapshot.point.x - centerX - Number(transform[1])) / scale;
  const unscaledY = centerY + (snapshot.point.y - centerY - Number(transform[2])) / scale;
  return {
    x: (unscaledX - parse(snapshot.frame.left)) / parse(snapshot.frame.width),
    y: (unscaledY - parse(snapshot.frame.top)) / parse(snapshot.frame.height),
  };
}

async function startPointComment(page, body, point) {
  await page.getByTestId("viewer-comment").click();
  await page.waitForSelector(".immersive-comment-hint", { timeout: 5000 });
  const stage = page.locator(".immersive-stage .stage");
  const box = await stage.boundingBox();
  if (!box) throw new Error("immersive stage has no bounding box");
  const snapshot = await stage.evaluate((el, p) => {
    const frame = el.querySelector(".stage-frame");
    const content = el.querySelector(".stage-content");
    if (!frame || !content) throw new Error("annotation frame did not render");
    return {
      box: { width: el.clientWidth, height: el.clientHeight },
      frame: {
        left: frame.style.left,
        top: frame.style.top,
        width: frame.style.width,
        height: frame.style.height,
      },
      transform: content.style.transform,
      point: p,
    };
  }, point);
  const expected = parseFrameAndTransform(snapshot);
  await page.mouse.click(box.x + point.x, box.y + point.y);
  await page.waitForSelector(".m-modal textarea.m-textarea", { timeout: 10000 });
  await page.fill(".m-modal textarea.m-textarea", body);
  await page.click(".m-modal-action .m-btn-primary");
  await page.waitForSelector(".m-modal", { state: "detached", timeout: 10000 });
  await page.waitForFunction(
    (text) => [...document.querySelectorAll("article.m-item .m-item-body")].some((el) => el.textContent?.includes(text)),
    body,
    { timeout: 15000 },
  );
  return expected;
}

async function openDiscussion(page) {
  const discussion = page.locator(".m-toolbar .m-tool").filter({ hasText: "討論" });
  await discussion.click();
  await page.waitForSelector(".m-sheet-half, .m-sheet-full", { timeout: 10000 });
}

async function closeDiscussionToPeek(page) {
  const sheet = page.locator(".m-sheet-half, .m-sheet-full");
  if (await sheet.count()) await page.locator(".m-toolbar .m-tool").filter({ hasText: "討論" }).click();
  await page.waitForTimeout(150);
}

async function createRegionComment(page, body) {
  await closeDiscussionToPeek(page);
  await page.locator(".m-toolbar .m-tool.is-primary").click();
  await page.waitForSelector(".m-action-btn", { timeout: 5000 });
  await page.locator(".m-action-btn").filter({ hasText: "圈出要調整的範圍" }).click();
  const stage = page.locator(".m-stage-area .stage");
  const box = await stage.boundingBox();
  if (!box) throw new Error("normal stage has no bounding box");
  const start = { x: box.x + 70, y: box.y + 150 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (const offset of [
    [105, 12],
    [145, 48],
    [175, 88],
    [180, 125],
    [140, 155],
    [95, 155],
    [55, 125],
    [55, 75],
    [70, 150],
  ]) {
    await page.mouse.move(box.x + offset[0], box.y + offset[1]);
  }
  await page.mouse.up();
  await page.waitForSelector(".m-modal textarea.m-textarea", { timeout: 10000 });
  await page.fill(".m-modal textarea.m-textarea", body);
  await page.click(".m-modal-action .m-btn-primary");
  await page.waitForSelector(".m-modal", { state: "detached", timeout: 10000 });
  await page.waitForFunction(
    (text) => [...document.querySelectorAll("article.m-item .m-item-body")].some((el) => el.textContent?.includes(text)),
    body,
    { timeout: 15000 },
  );
}

const tempRoot = mkdtempSync(join(tmpdir(), "duigao-review-viewer-"));
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

  // --------------------------------------------------------- main phone leg
  const ctx = await browser.newContext(phone(390, 844));
  const page = await ctx.newPage();
  await createRoom(page, "檢視器測試者");
  check("手機文宣房仍可載入原稿", await page.locator(".m-stage-area img.stage-img").first().evaluate((img) => img.naturalWidth > 0));
  check("390×844 沒有水平溢出", await noHorizontalOverflow(page));

  await openViewer(page);
  check("點擊文宣進入沉浸式檢視", await page.locator('[data-testid="immersive-viewer"]').isVisible());
  check("沉浸式控制只保留必要操作", (await page.locator(".immersive-head, .immersive-zoom-bar").count()) === 2);

  await page.getByTestId("viewer-zoom-100").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-status"]')?.textContent?.trim() === "100%");
  const oneHundred = await readTransform(page);
  check("快速縮放 100%", oneHundred.scale > 1 && oneHundred.scale < 2, `${oneHundred.scale.toFixed(2)}x`);

  await page.getByTestId("viewer-zoom-200").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-status"]')?.textContent?.trim() === "200%");
  const twoHundred = await readTransform(page);
  check("快速縮放 200%", twoHundred.scale > oneHundred.scale && twoHundred.scale <= 6, `${twoHundred.scale.toFixed(2)}x`);

  await page.getByTestId("viewer-zoom-fit").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-status"]')?.textContent?.trim() === "Fit");
  check("Fit 還原到適合螢幕", (await readTransform(page)).scale === 1);

  const zoomStage = page.locator(".immersive-stage .stage");
  await zoomStage.dblclick({ position: { x: 195, y: 360 } });
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-status"]')?.textContent?.trim() === "200%");
  check("雙擊放大", (await readTransform(page)).scale > 1);
  await zoomStage.dblclick({ position: { x: 195, y: 360 } });
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-status"]')?.textContent?.trim() === "Fit");
  check("再次雙擊還原", (await readTransform(page)).scale === 1);

  const cdp = await ctx.newCDPSession(page);
  await dispatchTouch(cdp, "touchStart", [
    { id: 1, x: 130, y: 360 },
    { id: 2, x: 260, y: 360 },
  ]);
  await dispatchTouch(cdp, "touchMove", [
    { id: 1, x: 90, y: 360 },
    { id: 2, x: 300, y: 360 },
  ]);
  await dispatchTouch(cdp, "touchEnd", []);
  await page.waitForTimeout(120);
  const pinched = await readTransform(page);
  check("雙指 pinch-to-zoom", pinched.scale > 1.1 && pinched.scale <= 6, `${pinched.scale.toFixed(2)}x`);

  const panBefore = pinched.translateX;
  await dispatchTouch(cdp, "touchStart", [{ id: 3, x: 195, y: 420 }]);
  await dispatchTouch(cdp, "touchMove", [{ id: 3, x: 145, y: 420 }]);
  await dispatchTouch(cdp, "touchEnd", []);
  await page.waitForTimeout(120);
  const panned = await readTransform(page);
  check("放大後單指拖曳平移", Math.abs(panned.translateX - panBefore) > 5, `${panBefore.toFixed(1)} → ${panned.translateX.toFixed(1)}px`);

  await dispatchTouch(cdp, "touchStart", [
    { id: 4, x: 90, y: 360 },
    { id: 5, x: 300, y: 360 },
  ]);
  await dispatchTouch(cdp, "touchMove", [
    { id: 4, x: 130, y: 360 },
    { id: 5, x: 260, y: 360 },
  ]);
  await dispatchTouch(cdp, "touchEnd", []);
  await page.waitForTimeout(120);
  const pinchedBack = await readTransform(page);
  check("pinch 可縮回且不低於 Fit", pinchedBack.scale >= 1 && pinchedBack.scale < pinched.scale);

  await page.getByTestId("viewer-zoom-200").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-status"]')?.textContent?.trim() === "200%");
  const expectedPoint = await startPointComment(page, "放大後仍可直接留言", { x: 96, y: 300 });
  check("放大狀態下建立 point comment", await page.locator("article.m-item .m-item-body").filter({ hasText: "放大後仍可直接留言" }).count() === 1);

  await page.getByTestId("viewer-close").click();
  await page.waitForSelector('[data-testid="immersive-viewer"]', { state: "detached", timeout: 10000 });
  await openDiscussion(page);
  const pointCard = page.locator("article.m-item").filter({ hasText: "放大後仍可直接留言" });
  await pointCard.click();
  await page.waitForSelector('[data-testid="immersive-viewer"]', { timeout: 10000 });
  await page.waitForSelector(".immersive-stage .pin", { timeout: 10000 });
  const focusedPoint = await readTransform(page);
  check("點修改建議自動開啟並聚焦", focusedPoint.scale >= 2);
  check("聚焦的 point 有短暫高亮定位", (await page.locator(".immersive-stage .pin.pin-locator").count()) === 1);
  const pinPosition = await page.locator(".immersive-stage .pin").first().evaluate((el) => ({
    left: Number.parseFloat(el.style.left) / 100,
    top: Number.parseFloat(el.style.top) / 100,
  }));
  check(
    "point comment 在縮放與聚焦後座標不漂移",
    Math.abs(pinPosition.left - expectedPoint.x) < 0.02 && Math.abs(pinPosition.top - expectedPoint.y) < 0.02,
    `${pinPosition.left.toFixed(3)},${pinPosition.top.toFixed(3)} ≈ ${expectedPoint.x.toFixed(3)},${expectedPoint.y.toFixed(3)}`,
  );

  await page.getByTestId("viewer-clean-toggle").click();
  await page.waitForFunction(() => document.querySelectorAll(".immersive-stage .pin, .immersive-stage .region-rect, .immersive-stage .overlay").length === 0);
  check("Clean View 隱藏 pin / region / 輔助框", true);
  await page.getByTestId("viewer-clean-toggle").click();
  check("Clean View 可一鍵顯示標記", (await page.locator(".immersive-stage .pin").count()) === 1);

  await page.getByTestId("viewer-close").click();
  await page.waitForSelector('[data-testid="immersive-viewer"]', { state: "detached", timeout: 10000 });
  await createRegionComment(page, "這個區域需要重排");
  await openDiscussion(page);
  const regionCard = page.locator("article.m-item").filter({ hasText: "這個區域需要重排" });
  await regionCard.click();
  await page.waitForSelector('[data-testid="immersive-viewer"]', { timeout: 10000 });
  await page.waitForSelector('.immersive-stage .region-rect[role="img"]', { timeout: 10000 });
  const focusedRegion = await readTransform(page);
  check("點 region comment 自動聚焦區域", focusedRegion.scale >= 2);
  check(
    "region comment 顯示正確區域標記",
    (await page.locator('.immersive-stage .region-rect[role="img"]').getAttribute("aria-label"))?.includes("這個區域需要重排") === true,
  );

  await page.getByTestId("viewer-close").click();
  await page.waitForSelector('[data-testid="immersive-viewer"]', { state: "detached", timeout: 10000 });
  check("關閉 viewer 回到原有文宣對稿流程", await page.locator(".m-stage-area .stage").count() === 1 && !(await page.locator('[data-testid="immersive-viewer"]').count()));

  // PR-01a：single 雲端房的房級討論 drawer 掛在既有討論 sheet 的聊天 tab 裡
  //（不是 tab 殼），對稿工作區佈局不變。
  await closeDiscussionToPeek(page);
  // 圖片房是 local-first：第一次分享才建立雲端房。房級討論是雲端面，
  // 所以先分享（綁定）再驗 drawer。
  await page.locator("button.m-share").click();
  await page.waitForSelector("input.m-share-url", { timeout: 30000 });
  await page.locator(".m-modal").getByRole("button", { name: "關閉", exact: true }).click();
  await openDiscussion(page);
  await page.locator(".m-sheet-tabs button").filter({ hasText: "聊天" }).click();
  await page.waitForSelector('[data-testid="discussion-drawer"]', { timeout: 15000 });
  check("聊天位掛的是房級討論 drawer", await page.getByTestId("discussion-drawer").count() === 1);
  const drawer = page.locator('[data-testid="discussion-drawer"][data-draft-ready="true"]');
  await drawer.waitFor({ timeout: 15000 });
  await drawer.getByLabel("房間討論").fill("drawer 打個招呼");
  const send = drawer.getByRole("button", { name: "送出" });
  await send.waitFor({ state: "visible", timeout: 5000 });
  check("送出在草稿 hydrate 後可按", await send.isEnabled());
  await send.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="discussion-feed"]')?.textContent?.includes("drawer 打個招呼"), null, { timeout: 15000 });
  check("drawer 可送出房級討論", (await page.getByTestId("discussion-feed").innerText()).includes("drawer 打個招呼"));
  check("drawer 沒有把決定/投票/白板塞給對稿", await page.getByTestId("decision-area").count() === 0 && (await page.getByTestId("discussion-drawer").innerText()).includes("drawer 打個招呼"));
  // PR-01b：drawer 也能附檔（同一條 Universal Intake 路徑）
  await page.locator('[data-testid="discussion-drawer"] input[type=file]').first().setInputFiles({ name: "drawer.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 drawer") });
  await page.waitForSelector('[data-testid="attachment-card"]', { timeout: 20000 });
  check("drawer 附 PDF 出現附件卡", (await page.getByTestId("discussion-drawer").innerText()).includes("drawer.pdf"));
  await closeDiscussionToPeek(page);
  await ctx.close();

  // ----------------------------------------------- second phone viewport
  const ctxSmall = await browser.newContext(phone(430, 932));
  const small = await ctxSmall.newPage();
  await createRoom(small, "小螢幕測試者");
  check("430×932 手機版沒有水平溢出", await noHorizontalOverflow(small));
  await openViewer(small);
  check("另一個直式手機尺寸可進入 viewer", await small.locator('[data-testid="immersive-viewer"]').isVisible());
  await small.getByTestId("viewer-close").click();
  await small.waitForSelector('[data-testid="immersive-viewer"]', { state: "detached", timeout: 10000 });
  await ctxSmall.close();
} finally {
  await browser?.close();
  mock?.close();
  app?.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
