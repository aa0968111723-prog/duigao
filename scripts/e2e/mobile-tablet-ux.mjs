#!/usr/bin/env node
/** First-layer chrome at the required phone/tablet viewports. */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { start as startMock } from "./mock-supabase.mjs";
import { ensureRoomMore } from "./room-more.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = Number(process.env.DUIGAO_UX_MOCK_PORT || 54428);
const APP_PORT = Number(process.env.DUIGAO_UX_APP_PORT || 4198);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const ARTIFACTS = process.env.DUIGAO_UX_ARTIFACTS || "/opt/cursor/artifacts";
const VIEWPORTS = [
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
];

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

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-ux-"));
const dist = join(tempRoot, "cloud");
let mock;
let app;
let browser;

try {
  mkdirSync(ARTIFACTS, { recursive: true });
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
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", "UX 測試者");
  await page.click("button.btn-primary");
  await page.waitForSelector(".home-picks", { timeout: 20000 });
  await page.getByRole("button", { name: /建立活動房/ }).click();
  await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 15000 });

  for (const { width, height } of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const first = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
      overview: document.querySelectorAll('[data-testid="open-overview-pane"]').length,
      ai: document.querySelectorAll('[data-testid="room-ai-launcher"]').length,
      more: document.querySelectorAll('[data-testid="room-more"]').length,
      chat: [...document.querySelectorAll("button")].some((el) => el.textContent === "對話"),
      board: [...document.querySelectorAll("button")].some((el) => el.textContent === "白板"),
      split: document.querySelector('[data-testid="multi-branch-room"]')?.getAttribute("data-tablet-split") === "true",
    }));
    check(`${width}×${height} 第一層沒有常駐總覽／AI`, first.overview === 0 && first.ai === 0);
    check(`${width}×${height} 第一層有返回／更多／對話／白板`, first.more === 1 && first.chat && first.board);
    check(`${width}×${height} 沒有水平溢出`, first.overflow);
    await page.screenshot({ path: join(ARTIFACTS, `gap04-first-${width}x${height}.png`), fullPage: false });
    await ensureRoomMore(page);
    const more = await page.evaluate(() => ({
      overview: document.querySelectorAll('[data-testid="open-overview-pane"]').length,
      split: document.querySelector('[data-testid="multi-branch-room"]')?.getAttribute("data-tablet-split") === "true",
      overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
    }));
    check(`${width}×${height} 更多打開後看得到總覽`, more.overview === 1);
    if (width >= 768) check(`${width}×${height} 更多打開時 tablet split`, more.split);
    else check(`${width}×${height} 手機更多不是 split`, more.split === false);
    check(`${width}×${height} 更多打開仍無水平溢出`, more.overflow);
    await page.screenshot({ path: join(ARTIFACTS, `gap04-more-${width}x${height}.png`), fullPage: false });
    await page.getByTestId("room-more").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="room-more-sheet"]'), null, { timeout: 5000 });
  }

  const failed = results.filter((item) => !item.pass);
  if (failed.length) {
    console.error(`\n${failed.length} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n${results.length} checks passed`);
  }
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => app?.close(() => resolve()));
  await mock?.close?.();
  rmSync(tempRoot, { recursive: true, force: true });
}
