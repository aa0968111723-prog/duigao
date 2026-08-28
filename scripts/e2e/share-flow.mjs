#!/usr/bin/env node
/**
 * PR #16 acceptance run for the share-link contract.
 *
 * Drives the real production bundle in Chromium at the two Android viewports
 * this app targets (390×844, 430×932) plus a LINE in-app user agent, and
 * asserts the whole rule set:
 *
 *   A  a new share link is `#room=<uuid>&invite=<token>`, and a partner can
 *      still open it after the host closes the page entirely
 *   B  a failed cloud create shows retry and hands out no URL at all
 *   C  a production build without Supabase env never claims sharing worked
 *   D  legacy `#room=<6碼>` links: owner auto-upgrade, guest gets the
 *      "ask for a new link" message instead of an unwinnable retry loop
 *   +  PR #12's invite model still holds (wrong / missing invite ⇒ no access)
 *
 * The cloud side runs against `mock-supabase.mjs` — a local stand-in for the
 * Supabase endpoints this app uses, so the run needs no network and no real
 * project. It exercises the app's own logic end to end; it is not a test of
 * Supabase itself.
 *
 * Usage:  npm i -D playwright && npx playwright install chromium
 *         node scripts/e2e/share-flow.mjs
 *         (CHROMIUM_PATH=/path/to/chrome to reuse an existing browser)
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, readFile, mkdtempSync, rmSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, normalize } from "node:path";
import { deflateSync } from "node:zlib";
import { start as startMock, requestLog, faults, rows, cloudRooms } from "./mock-supabase.mjs";

const MOCK_PORT = 54399;
const APP_PORT = 4173;
const NOCLOUD_PORT = 4174;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const APP_NOCLOUD = `http://127.0.0.1:${NOCLOUD_PORT}/`;
const LINE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Line/13.20.0";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

// ---------------------------------------------------------------- fixtures
/** Small greyscale PNGs, so the run needs no binary fixture in the repo. */
function makePoster(w = 600, h = 800) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w + 1);
    for (let x = 0; x < w; x++) row[x + 1] = Math.floor((x * 255) / w);
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const POSTER = makePoster();
/** A different shape, so a re-render is visibly a different card. */
const POSTER2 = makePoster(900, 500);

// ------------------------------------------------------------------ servers
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

// ------------------------------------------------------------------ harness
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const phone = (width, height, userAgent) => ({
  viewport: { width, height },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent,
});

async function newRoomWithPoster(page, appUrl, name) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", name);
  await page.click("button.btn-primary");
  await page.setInputFiles('input[type="file"]', { name: "poster.png", mimeType: "image/png", buffer: POSTER });
  await page.waitForSelector("button.m-share, header .btn-primary", { timeout: 15000 });
}

async function openShareSheet(page) {
  const mobileShare = await page.$("button.m-share");
  if (mobileShare) await mobileShare.click();
  else await page.click("header .btn-primary:has-text('分享')");
  await page.waitForSelector(".m-share-note", { timeout: 20000 });
}

const cloudRoomIdOf = (shareUrl) => shareUrl.split("#room=")[1].split("&")[0];

const noHorizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ------------------------------------------------------------------- builds
const out = mkdtempSync(join(tmpdir(), "duigao-e2e-"));
const cloudDist = join(out, "cloud");
const nocloudDist = join(out, "nocloud");
console.log("building bundles…");
execFileSync("npx", ["vite", "build", "--outDir", cloudDist, "--emptyOutDir"], {
  stdio: "pipe",
  // npx is a shell script on Windows; without this the spawn is an ENOENT.
  shell: process.platform === "win32",
  env: {
    ...process.env,
    // A build pointed at the local mock. `http://127.0.0.1` is accepted by the
    // config check precisely so a local Supabase stack can be used this way.
    VITE_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_mock_key_000000",
  },
});
execFileSync("npx", ["vite", "build", "--outDir", nocloudDist, "--emptyOutDir"], {
  stdio: "pipe",
  shell: process.platform === "win32",
  // A production build with the cloud env deliberately absent (case C). Blank
  // strings override any .env file, which a plain `delete` would not.
  env: { ...process.env, VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: "" },
});

// The mock also mounts the real share-preview Edge Function, so the guest leg
// below is a genuine LINE journey: card URL → redirect → room.
const mock = await startMock(MOCK_PORT, { appOrigin: APP.replace(/\/$/, "") });
const app = await serveStatic(cloudDist, APP_PORT);
const nocloud = await serveStatic(nocloudDist, NOCLOUD_PORT);

// CHROMIUM_PATH lets a pre-installed Chromium be used (CI images, sandboxes)
// instead of the copy `npx playwright install` would download.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

try {
  // ------------------------------------------------------------ A: new share
  const ctxA = await browser.newContext(phone(390, 844, ANDROID_UA));
  const A = await ctxA.newPage();
  await newRoomWithPoster(A, APP, "主辦方A");
  check("A. 390×844 建房後版面沒有水平溢出", await noHorizontalOverflow(A));

  await openShareSheet(A);
  await A.waitForSelector("input.m-share-url", { timeout: 30000 });
  // The preview lands a moment after the link itself; wait for it to settle.
  await A.waitForSelector(".m-share-preview", { timeout: 30000 }).catch(() => null);
  await A.waitForFunction(
    () => !document.querySelector(".m-share-preview-thumb.is-generic")?.textContent?.includes("準備中"),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const shareUrl = await A.inputValue("input.m-share-url");
  const shareNote = (await A.textContent(".m-share-note")) ?? "";
  check(
    "A. 分享 URL 是 #room=<uuid>&invite=<token>",
    /#room=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}&invite=[A-Za-z0-9_-]{20,}$/.test(shareUrl),
    shareUrl.replace(/invite=.*/, "invite=<redacted>"),
  );
  check("A. 分享文案宣告永久連結", shareNote.includes("分享連結已建立"));

  // ------------------------------------------------- PR #21: 連結預覽 (OG)
  check(
    "A. 分享 URL 走 share-preview landing（previewId ≠ roomId）",
    /\/functions\/v1\/share-preview\/[0-9a-f-]{36}#room=/.test(shareUrl) &&
      shareUrl.split("/share-preview/")[1].split("#")[0] !== shareUrl.split("#room=")[1].split("&")[0],
    shareUrl.replace(/invite=.*/, "invite=<redacted>"),
  );
  const previewThumb = await A.getAttribute(".m-share-preview-thumb", "src").catch(() => null);
  check(
    "A. 連結預覽顯示乾淨文宣縮圖",
    Boolean(previewThumb && previewThumb.includes("/storage/v1/object/public/share-previews/")),
    previewThumb ?? "no thumbnail",
  );
  check(
    "A. 縮圖真的載入得起來",
    await A.evaluate(() => {
      const img = document.querySelector(".m-share-preview-thumb");
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }),
  );

  // The card a crawler sees: fetched with no JavaScript at all.
  const previewUrl = shareUrl.split("#")[0];
  // no-store: the endpoint sets a short public cache, and this run fetches the
  // same URL again after toggling the thumbnail off. (Crawler user agents are
  // covered by scripts/e2e/share-preview.mjs — fetch() cannot set one.)
  // 真人 UA 現在吃 302（share-preview 的新契約），所以爬蟲卡片改由
  // node 側帶爬蟲 UA 直接抓 — 這段本來就是在演 unfurler。
  const card = await fetch(previewUrl, { headers: { "user-agent": "facebookexternalhit/1.1" }, cache: "no-store" })
    .then(async (res) => ({ status: res.status, type: res.headers.get("content-type"), html: await res.text() }));
  const ogImage = /<meta property="og:image" content="([^"]*)"/.exec(card.html)?.[1] ?? "";
  const ogTitle = /<meta property="og:title" content="([^"]*)"/.exec(card.html)?.[1] ?? "";
  const inviteToken = shareUrl.split("&invite=")[1];
  check("A. 爬蟲 GET 預覽頁得到 200 text/html", card.status === 200 && /text\/html/.test(card.type ?? ""));
  check("A. 預覽頁有 og:title / og:description / og:image", Boolean(ogTitle && ogImage && /og:description/.test(card.html)));
  check("A. og:image 指向 share-previews 公開 bucket", ogImage.includes("/storage/v1/object/public/share-previews/"), ogImage);
  check("A. 預覽 HTML 不含 invite token", !card.html.includes(inviteToken));
  check("A. 預覽 HTML 不含 room id", !card.html.includes(cloudRoomIdOf(shareUrl)));

  // The card must be rendered from the ORIGINAL poster in Storage. A DOM
  // screenshot would drag in pins, regions, proposal overlays and the toolbar —
  // so assert the route taken, not just the result.
  const previewIdOf = shareUrl.split("/share-preview/")[1].split("#")[0];
  check(
    "A. 縮圖來源是 room-assets 裡的原稿（不是螢幕截圖）",
    requestLog.some((r) => r.startsWith("POST /storage/v1/object/sign/room-assets/rooms/")) &&
      requestLog.some((r) => r.startsWith("GET /storage/v1/object/sign/room-assets/rooms/")),
  );
  check(
    "A. 縮圖上傳到獨立的 share-previews bucket",
    requestLog.some((r) => r === `POST /storage/v1/object/share-previews/${previewIdOf}/cover.webp`),
  );
  check(
    "A. 沒有把任何東西寫進 room-assets 的 preview 路徑",
    !requestLog.some((r) => r.startsWith("POST /storage/v1/object/room-assets/") && r.includes("cover")),
  );

  // 關掉「顯示文宣縮圖」→ 只剩通用封面
  await A.click(".m-share-toggle input");
  await A.waitForFunction(
    () => document.querySelector(".m-share-preview-thumb.is-generic") &&
      !document.querySelector(".m-share-preview-thumb.is-generic").textContent.includes("準備中"),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const offCard = await fetch(previewUrl, { headers: { "user-agent": "facebookexternalhit/1.1" }, cache: "no-store" }).then((res) => res.text());
  const offImage = /<meta property="og:image" content="([^"]*)"/.exec(offCard)?.[1] ?? "";
  check("A. 關閉縮圖後 og:image 換成通用封面", offImage.endsWith("/og-cover.png"), offImage);
  check("A. 關閉縮圖後不再暴露文宣縮圖", !offCard.includes("/share-previews/"));
  // Public bucket: flipping a flag is not revocation, the bytes have to go.
  check(
    "A. 關閉縮圖會真的刪掉公開的縮圖檔",
    requestLog.some((r) => r === "DELETE /storage/v1/object/share-previews"),
  );

  // 開回來，讓後續的夥伴情境仍有卡片
  await A.click(".m-share-toggle input");
  await A.waitForFunction(
    () => Boolean(document.querySelector("img.m-share-preview-thumb")),
    null,
    { timeout: 30000 },
  ).catch(() => {});

  // ------- 撤銷失敗不能假裝成功（公開 bucket 上，沒刪掉就等於沒撤銷）-------
  faults.previewDelete = true;
  await A.click(".m-share-toggle input");
  await A.waitForFunction(
    () => (document.querySelector(".m-share-preview")?.textContent ?? "").includes("沒有產生預覽縮圖"),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  check(
    "A. 縮圖刪不掉時不會假裝已經關閉",
    ((await A.textContent(".m-share-preview")) ?? "").includes("沒有產生預覽縮圖"),
    (await A.textContent(".m-share-preview"))?.trim(),
  );
  check(
    "A. 刪不掉時仍保留 thumbnail_path，之後才有機會補刪",
    Boolean(rows.share_previews[0]?.thumbnail_path),
    JSON.stringify(rows.share_previews[0]?.thumbnail_path),
  );
  // Clearing the fault: the next 分享 retries the delete on its own, because the
  // row still remembers the path. The preview stays OFF (the flag did land), so
  // turn it back on for the scenarios below.
  faults.previewDelete = false;
  await A.click(".m-close");
  await openShareSheet(A);
  await A.waitForFunction(
    () => Boolean(document.querySelector(".m-share-toggle input")) &&
      !(document.querySelector(".m-share-preview-thumb.is-generic")?.textContent ?? "").includes("準備中"),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  check(
    "A. 補刪成功後縮圖檔真的不見了",
    !rows.share_previews[0]?.thumbnail_path,
    JSON.stringify(rows.share_previews[0]?.thumbnail_path),
  );
  await A.click(".m-share-toggle input");
  await A.waitForSelector("img.m-share-preview-thumb", { timeout: 30000 }).catch(() => null);

  // ---------------- 預覽失敗後要能自己好起來（不是永遠卡在舊版）----------------
  // A second version plus a failing upload is the shape that used to wedge the
  // card on the previous poster forever: the row advanced to the new version
  // while the old image stayed, so every later retry decided nothing was stale.
  await A.click(".m-close");
  await A.setInputFiles('input[type="file"]', { name: "poster2.png", mimeType: "image/png", buffer: POSTER2 });
  // A new version is written locally first and re-keyed when the cloud snapshot
  // comes back, which resets the selection. Wait for that to settle BEFORE
  // choosing the version, or the choice is silently undone a moment later.
  await A.waitForFunction(() => document.querySelectorAll(".m-vchip:not(.m-vchip-add)").length >= 2, null, {
    timeout: 20000,
  }).catch(() => {});
  const versionCount = await A.evaluate(() => document.querySelectorAll(".m-vchip:not(.m-vchip-add)").length);
  check("A. 可以再加一個版本（給預覽換版用）", versionCount >= 2, `versions=${versionCount}`);
  await A.waitForTimeout(2500);

  // The card follows the version being looked at, so switch to the new one.
  // `nth=` indexes the matched list; :nth-of-type would index siblings instead.
  await A.locator("button.m-vchip:not(.m-vchip-add)").nth(1).click();
  await A.waitForFunction(
    () => document.querySelector(".m-vchip.is-on")?.textContent?.trim() === "改一",
    null,
    { timeout: 10000 },
  ).catch(() => {});
  await A.waitForTimeout(800);
  check(
    "A. 切換到新版本後選擇不會被雲端同步彈回去",
    (await A.evaluate(() => document.querySelector(".m-vchip.is-on")?.textContent?.trim())) === "改一",
  );

  faults.previewUpload = true;
  requestLog.length = 0;
  await openShareSheet(A);
  await A.waitForSelector(".m-share-preview", { timeout: 30000 }).catch(() => null);
  await A.waitForFunction(
    () => (document.querySelector(".m-share-preview")?.textContent ?? "").includes("沒有產生預覽縮圖"),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  const failedText = (await A.textContent(".m-share-preview")) ?? "";
  check("A. 縮圖上傳失敗時說明預覽沒產生", failedText.includes("沒有產生預覽縮圖"), failedText.trim());
  // PR #30: a failed card is no longer a silent fallback. Nothing is shareable
  // until the host has been told there will be no thumbnail and said so.
  const sheetText = (await A.textContent(".m-more")) ?? "";
  check(
    "A. 縮圖失敗時先告知這次不會有縮圖",
    sheetText.includes("這次沒有產生預覽縮圖，但分享連結仍可使用"),
    sheetText.slice(0, 80),
  );
  check("A. 縮圖失敗時不先把連結攤在那裡", !(await A.$("input.m-share-url")));
  check("A. 縮圖失敗時提供明確的「仍要分享」", Boolean(await A.$("button:has-text('仍要分享')")));
  await A.click("button:has-text('仍要分享')");
  await A.waitForSelector("input.m-share-url", { timeout: 15000 });
  const failedUrl = await A.inputValue("input.m-share-url");
  check(
    "A. 縮圖上傳失敗仍給得出永久 room+invite 連結",
    /#room=[0-9a-f-]{36}&invite=[A-Za-z0-9_-]{20,}$/.test(failedUrl),
    failedUrl.replace(/invite=.*/, "invite=<redacted>"),
  );

  faults.previewUpload = false;
  await A.click(".m-close");
  requestLog.length = 0;
  await openShareSheet(A);
  await A.waitForSelector("img.m-share-preview-thumb", { timeout: 30000 }).catch(() => null);
  check(
    "A. 上傳恢復後預覽會自己重新產生（不會卡在舊版）",
    requestLog.some((r) => r.startsWith("POST /storage/v1/object/share-previews/")),
    requestLog.filter((r) => r.includes("share-previews")).join(" | ") || "no re-upload",
  );
  check(
    "A. 恢復後 ShareSheet 又是完整的預覽卡片",
    ((await A.textContent(".m-share-preview")) ?? "").includes("顯示文宣縮圖"),
  );
  await A.click(".m-close");
  await openShareSheet(A);
  await A.waitForSelector("input.m-share-url", { timeout: 30000 });

  // ================= PR #30: 文宣語境 + 自訂分享內容（圖片房） =================
  // 1) media copy: an image room must never talk about 影片.
  {
    const sheet = (await A.textContent(".m-more")) ?? "";
    check("PR30. 圖片房不會出現「這支影片」", !sheet.includes("這支影片"), sheet.slice(0, 120));
    check("PR30. 圖片房不會出現「影片封面」", !sheet.includes("影片封面"));
    check("PR30. 圖片房的 toggle 仍是「顯示文宣縮圖」", sheet.includes("顯示文宣縮圖"));
    check(
      "PR30. 圖片房的隱私說明仍是文宣說法",
      sheet.includes("低解析度文宣預覽"),
      sheet.slice(0, 200),
    );
  }

  // 2) the invite text that actually travels, straight off the LINE deep link.
  const lineHref = (await A.getAttribute("a.m-row-line", "href")) ?? "";
  const lineText = decodeURIComponent(lineHref.split("?")[1] ?? "");
  check("PR30. 圖片房 LINE 文案講「這張文宣」", lineText.includes("這張文宣"), lineText.slice(0, 60));
  check("PR30. 圖片房 LINE 文案不講「這支影片」", !lineText.includes("這支影片"));
  check(
    "PR30. LINE 帶出去的是 share-preview 連結，不是原始 App URL",
    lineText.includes("/functions/v1/share-preview/") && !/\n\s*http:\/\/127\.0\.0\.1:4173\/#room=/.test(lineText),
    lineText.split("\n").pop()?.replace(/invite=.*/, "invite=<redacted>") ?? "",
  );

  // 3) 自訂分享標題：卡片改了，房間名沒改。
  const roomTitleBefore = rows.share_previews[0] ? cloudRooms.get(rows.share_previews[0].room_id)?.title : null;
  await A.click("button:has-text('自訂分享內容')");
  await A.waitForSelector(".m-share-custom", { timeout: 10000 });
  await A.fill(".m-share-custom input.m-input", "期初茶會文宣｜對外版");
  await A.fill(".m-share-custom textarea", "只要看標題排版就好，其他不用動。");
  await A.click("button:has-text('儲存分享內容')");
  await A.waitForFunction(
    () => (document.querySelector(".m-share-preview-title")?.textContent ?? "").includes("對外版"),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  check(
    "PR30. 自訂標題寫進 share_previews",
    rows.share_previews[0]?.title === "期初茶會文宣｜對外版",
    JSON.stringify(rows.share_previews[0]?.title),
  );
  check(
    "PR30. 自訂說明寫進 share_previews",
    rows.share_previews[0]?.description === "只要看標題排版就好，其他不用動。",
    JSON.stringify(rows.share_previews[0]?.description),
  );
  check(
    "PR30. 自訂標題不會改到房間名稱",
    cloudRooms.get(rows.share_previews[0].room_id)?.title === roomTitleBefore,
    `${roomTitleBefore} → ${cloudRooms.get(rows.share_previews[0].room_id)?.title}`,
  );
  check("PR30. 自訂後 title_customized 為 true", rows.share_previews[0]?.title_customized === true);
  {
    const href = (await A.getAttribute("a.m-row-line", "href")) ?? "";
    check(
      "PR30. LINE 文案用的是自訂標題",
      decodeURIComponent(href).includes("期初茶會文宣｜對外版"),
      decodeURIComponent(href).slice(0, 60),
    );
  }

  // 4) 關掉 ShareSheet 再打開，自訂內容要還在（來源是雲端，不是本機草稿）。
  await A.click(".m-close");
  await openShareSheet(A);
  await A.waitForSelector("input.m-share-url", { timeout: 30000 });
  await A.click("button:has-text('自訂分享內容')");
  check(
    "PR30. 重開 ShareSheet 後自訂標題還在",
    (await A.inputValue(".m-share-custom input.m-input")) === "期初茶會文宣｜對外版",
  );
  check(
    "PR30. 重開 ShareSheet 後自訂說明還在",
    (await A.inputValue(".m-share-custom textarea")) === "只要看標題排版就好，其他不用動。",
  );

  // 5) 自訂封面：上傳的圖被 render 成 1200×630 衍生檔，原圖不進 bucket。
  requestLog.length = 0;
  await A.setInputFiles("input.m-share-file", { name: "cover.png", mimeType: "image/png", buffer: POSTER2 });
  await A.waitForFunction(
    () => document.querySelector('input[value="custom"]')?.checked === true,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  check("PR30. 自訂封面把 cover_source 設成 custom", rows.share_previews[0]?.cover_source === "custom", String(rows.share_previews[0]?.cover_source));
  check(
    "PR30. 自訂封面上傳到 share-previews，不是 room-assets",
    requestLog.some((r) => r.startsWith("POST /storage/v1/object/share-previews/")) &&
      !requestLog.some((r) => r.startsWith("POST /storage/v1/object/room-assets/")),
    requestLog.filter((r) => r.includes("/storage/")).join(" | "),
  );
  {
    const previewId = rows.share_previews[0].id;
    const card = await fetch(`http://127.0.0.1:${MOCK_PORT}/functions/v1/share-preview/${previewId}`, {
      headers: { "user-agent": "facebookexternalhit/1.1" },
      cache: "no-store",
    }).then((res) => res.text());
    check(
      "PR30. 自訂封面之後 og:image 指向自訂封面",
      /og:image[^>]*share-previews/.test(card) && !card.includes("og-cover.png"),
      /<meta property="og:image" content="([^"]*)"/.exec(card)?.[1] ?? "",
    );
    check("PR30. 自訂封面之後 og:title 是自訂標題", card.includes("期初茶會文宣｜對外版"));
  }

  // 6) 不顯示封面：檔案真的刪掉，卡片退回通用封面。
  await A.click('.m-share-covers input[value="none"]');
  await A.waitForFunction(
    () => Boolean(document.querySelector(".m-share-preview-thumb.is-generic")) &&
      !document.querySelector(".m-share-preview-thumb.is-generic").textContent.includes("準備中"),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  check("PR30. 不顯示封面把 cover_source 設成 none", rows.share_previews[0]?.cover_source === "none", String(rows.share_previews[0]?.cover_source));
  check("PR30. 不顯示封面會刪掉公開的縮圖檔", !rows.share_previews[0]?.thumbnail_path, JSON.stringify(rows.share_previews[0]?.thumbnail_path));
  check("PR30. 不顯示封面時 show_thumbnail 也跟著關", rows.share_previews[0]?.show_thumbnail === false);

  // 7) 恢復預設：標題／說明回到房間預設，封面回到 auto。
  await A.click("button:has-text('恢復預設')");
  await A.waitForFunction(
    () => Boolean(document.querySelector("img.m-share-preview-thumb")),
    null,
    { timeout: 30000 },
  ).catch(() => {});
  check("PR30. 恢復預設後 cover_source 回到 auto", rows.share_previews[0]?.cover_source === "auto", String(rows.share_previews[0]?.cover_source));
  check("PR30. 恢復預設後標題回到房間名", rows.share_previews[0]?.title === roomTitleBefore, JSON.stringify(rows.share_previews[0]?.title));
  check("PR30. 恢復預設後 title_customized 回到 false", rows.share_previews[0]?.title_customized === false);
  check(
    "PR30. 恢復預設後說明回到文宣預設文案",
    (rows.share_previews[0]?.description ?? "").includes("這張文宣"),
    JSON.stringify(rows.share_previews[0]?.description),
  );

  // 8) 進階 fallback：原始安全連結仍拿得到，但不是主要操作。
  await A.click("button.m-link:has-text('更多')");
  await A.waitForSelector(".m-share-advanced", { timeout: 10000 });
  const advancedText = (await A.textContent(".m-share-advanced")) ?? "";
  check("PR30. 「複製原始安全連結」放在更多裡面", advancedText.includes("複製原始安全連結"));
  check(
    "PR30. 主要操作區沒有原始安全連結",
    !((await A.textContent(".m-more > button.m-row-primary")) ?? "").includes("原始"),
  );
  await A.click(".m-close");
  await openShareSheet(A);
  await A.waitForSelector("input.m-share-url", { timeout: 30000 });

  const localRoomId = await A.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith("duigao.cloudmap."))
      .map((k) => k.slice("duigao.cloudmap.".length))[0],
  );
  check("A. owner 本機留下 local→cloud mapping", Boolean(localRoomId), `local room ${localRoomId}`);

  // -------------------------------------------- D: legacy owner auto-upgrade
  // A fresh open of the old link (as it arrives from LINE), not a same-document
  // hash change: the upgrade runs at boot, before React reads the address bar.
  await A.goto(`${APP}#room=${localRoomId}`, { waitUntil: "domcontentloaded" });
  await A.reload({ waitUntil: "domcontentloaded" });
  await A.waitForFunction(() => location.hash.includes("&invite="), null, { timeout: 15000 }).catch(() => {});
  const upgraded = await A.evaluate(() => location.hash);
  const cloudRoomId = cloudRoomIdOf(shareUrl);
  check(
    "D. 舊版 #room=<6碼> 在 owner 裝置自動升級成 room+invite",
    upgraded.startsWith(`#room=${cloudRoomId}`) && upgraded.includes("&invite="),
    upgraded.replace(/invite=.*/, "invite=<redacted>"),
  );

  // A closes the page entirely — the host is now offline.
  await ctxA.close();

  // ------------------------------------------------ A: guest opens from LINE
  const ctxB = await browser.newContext(phone(430, 932, LINE_UA));
  const B = await ctxB.newPage();
  await B.goto(shareUrl, { waitUntil: "domcontentloaded" });
  await B.fill("input.text-input", "夥伴B");
  await B.click("button.btn-primary");
  const loaded = await B.waitForSelector("button.m-share", { timeout: 30000 }).catch(() => null);
  const bodyText = (await B.textContent("body")) ?? "";
  check(
    "A. 主辦方關頁後，夥伴從 LINE 開連結仍載入房間",
    Boolean(loaded) && !bodyText.includes("目前暫時無法載入"),
    bodyText.includes("目前暫時無法載入") ? "still showing the generic failure" : "room rendered",
  );
  check("A. 430×932 夥伴視圖沒有水平溢出", await noHorizontalOverflow(B));
  const storagePosterLoaded = await B.waitForFunction(
    () => {
      const img = [...document.images].find((item) => item.src.includes("/storage/"));
      return Boolean(img && img.complete && img.naturalWidth > 0);
    },
    null,
    { timeout: 10000 },
  ).then(() => true).catch(() => false);
  check(
    "A. 夥伴看到的海報真的從雲端 Storage 載入",
    storagePosterLoaded,
  );
  await ctxB.close();

  // ------------------------------------------ security: invite still required
  const ctxF = await browser.newContext(phone(390, 844, ANDROID_UA));
  const F = await ctxF.newPage();
  await F.goto(shareUrl.replace(/invite=.*/, "invite=this-token-is-wrong-but-long-enough"), {
    waitUntil: "domcontentloaded",
  });
  await F.fill("input.text-input", "冒充者F");
  await F.click("button.btn-primary");
  await F.waitForSelector("text=分享連結無效或已失效", { timeout: 30000 }).catch(() => {});
  const fText = (await F.textContent(".onboard-card")) ?? "";
  check("安全. 竄改 invite 進不了房間", fText.includes("分享連結無效或已失效") && !(await F.$("button.m-share")));
  await ctxF.close();

  const ctxG = await browser.newContext(phone(390, 844, ANDROID_UA));
  const G = await ctxG.newPage();
  await G.goto(shareUrl.replace(/&invite=.*/, ""), { waitUntil: "domcontentloaded" });
  await G.fill("input.text-input", "冒充者G");
  await G.click("button.btn-primary");
  await G.waitForTimeout(4000);
  check(
    "安全. 只知道 room id、沒有 invite 也讀不到房間",
    !(await G.$("button.m-share")) && !((await G.textContent("body")) ?? "").includes("初稿"),
  );
  await ctxG.close();

  // ----------------------------------------- B: cloud create failure path
  const ctxC = await browser.newContext(phone(390, 844, ANDROID_UA));
  const C = await ctxC.newPage();
  await C.route("**/rpc/create_room_with_invite", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }),
  );
  await newRoomWithPoster(C, APP, "主辦方C");
  await openShareSheet(C);
  await C.waitForSelector("text=暫時無法建立分享連結", { timeout: 30000 }).catch(() => {});
  const cText = (await C.textContent(".m-more")) ?? "";
  const cHtml = (await C.innerHTML(".m-more")) ?? "";
  check("B. cloud 建立失敗顯示「暫時無法建立分享連結」", cText.includes("暫時無法建立分享連結"));
  check("B. cloud 建立失敗提供「再試一次」", cText.includes("再試一次"));
  check("B. cloud 建立失敗不提供任何可複製連結", !(await C.$("input.m-share-url")) && !/#room=/.test(cHtml));
  await ctxC.close();

  // ------------------------------------ C: production build without cloud env
  const ctxD = await browser.newContext(phone(390, 844, ANDROID_UA));
  const D = await ctxD.newPage();
  await newRoomWithPoster(D, APP_NOCLOUD, "主辦方D");
  await openShareSheet(D);
  const dText = (await D.textContent(".m-more")) ?? "";
  const dHtml = (await D.innerHTML(".m-more")) ?? "";
  check("C. 沒有 cloud env 的 production build 不宣稱分享已建立", !dText.includes("分享連結已建立"));
  check("C. 沒有 cloud env 時說明分享服務無法使用", dText.includes("分享服務目前無法使用"));
  check("C. 沒有 cloud env 時不產生 #room= 連結", !/#room=/.test(dHtml) && !(await D.$("input.m-share-url")));
  await ctxD.close();

  // --------------------------- D: legacy guest, no mapping, host not online
  const ctxE = await browser.newContext(phone(390, 844, LINE_UA));
  const E = await ctxE.newPage();
  await E.goto(`${APP}#room=k7m2xq`, { waitUntil: "domcontentloaded" });
  await E.fill("input.text-input", "夥伴E");
  await E.click("button.btn-primary");
  await E.waitForSelector("text=這是舊版分享連結", { timeout: 60000 }).catch(() => {});
  const eText = (await E.textContent(".onboard-card")) ?? "";
  check("D. 舊版連結 + host 離線 → 顯示「這是舊版分享連結」", eText.includes("這是舊版分享連結"));
  check("D. 舊版連結不再給 generic「目前暫時無法載入」重試", !eText.includes("目前暫時無法載入"));
  check("D. 舊版連結指引向主辦方索取新版連結", eText.includes("取得新版分享連結"));
  await ctxE.close();
} finally {
  await browser.close();
  for (const s of [mock, app, nocloud]) s.close();
  rmSync(out, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
