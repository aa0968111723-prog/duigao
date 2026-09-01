#!/usr/bin/env node
/**
 * Poster room → 編輯這張. Asserts compose chrome and writes 390 / desktop shots.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { start as startMock } from "./mock-supabase.mjs";
import { openRoomPane } from "./room-more.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const ARTIFACTS = process.env.DUIGAO_COMPOSE_SHOTS || join(ROOT, "output", "playwright");
const MOCK_PORT = Number(process.env.DUIGAO_COMPOSE_SHOT_MOCK || 54458);
const APP_PORT = Number(process.env.DUIGAO_COMPOSE_SHOT_APP || 4288);
const APP = `http://127.0.0.1:${APP_PORT}/`;
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed");
  process.exit(2);
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

function serveStatic(root, port) {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const file = join(root, normalize(pathname === "/" ? "/index.html" : pathname));
    try {
      const buffer = await read(file);
      res.writeHead(200, {
        "content-type": {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".webmanifest": "application/manifest+json",
        }[extname(file)] ?? "application/octet-stream",
      });
      res.end(buffer);
    } catch {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await read(join(root, "index.html")));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function enterPosterReview(page) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", "截圖測試者");
  await page.click("button.btn-primary");
  await page.waitForSelector(".home-picks", { timeout: 20000 });
  await page.getByRole("button", { name: /建立活動房/ }).click();
  await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 15000 });
  await openRoomPane(page, "open-content-pane");
  await page.getByRole("button", { name: /新增文宣/ }).click();
  const sheet = page.getByTestId("create-content-sheet");
  await sheet.getByTestId("create-poster-upload").click();
  await sheet.locator('input:not([type="file"])').first().fill("胸章文宣");
  await sheet.locator('input[type="file"]').setInputFiles({ name: "poster.png", mimeType: "image/png", buffer: TINY_PNG });
  await sheet.locator("button.project-submit").click();
  await page.waitForSelector("img.stage-img", { timeout: 20000 });
  await page.waitForFunction(() => (document.querySelector("img.stage-img")?.naturalWidth ?? 0) > 0, null, { timeout: 20000 });
}

async function assertCompose(page, label) {
  await page.getByTestId("poster-edit-toggle").click();
  await page.waitForSelector('[data-testid="compose-exit"]', { timeout: 15000 });
  const chrome = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="editor-mode"]');
    const pinTools = [...document.querySelectorAll("button")].filter((el) => {
      const text = (el.textContent || "").replace(/\s+/g, "");
      return text === "修改點" || el.getAttribute("data-tool") === "pin";
    });
    return {
      mode: root?.getAttribute("data-mode") || "",
      exit: document.querySelectorAll('[data-testid="compose-exit"]').length,
      pinCount: pinTools.length,
      img: (document.querySelector("img.stage-img")?.naturalWidth ?? 0) > 0,
    };
  });
  console.log(label, chrome);
  if (chrome.mode !== "compose") throw new Error(`${label}: editor-mode=${chrome.mode}`);
  if (chrome.exit < 1) throw new Error(`${label}: missing compose-exit`);
  if (chrome.pinCount > 0) throw new Error(`${label}: pin/修改點 still visible (${chrome.pinCount})`);
  if (!chrome.img) throw new Error(`${label}: poster image gone`);
  return chrome;
}

async function assertReview(page, label, reviewName) {
  await page.getByTestId("compose-exit").click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="editor-mode"]')?.getAttribute("data-mode") === "review",
    null,
    { timeout: 10000 },
  );
  const chrome = await page.evaluate((name) => {
    const root = document.querySelector('[data-testid="editor-mode"]');
    const reviewBtn = [...document.querySelectorAll("button")].some((el) => (el.textContent || "").replace(/\s+/g, "") === name);
    return {
      mode: root?.getAttribute("data-mode") || "",
      exit: document.querySelectorAll('[data-testid="compose-exit"]').length,
      reviewBtn,
      img: (document.querySelector("img.stage-img")?.naturalWidth ?? 0) > 0,
    };
  }, reviewName);
  console.log(label, "after exit", chrome);
  if (chrome.mode !== "review") throw new Error(`${label}: still compose after 完成 (${chrome.mode})`);
  if (chrome.exit !== 0) throw new Error(`${label}: compose-exit still mounted`);
  if (!chrome.reviewBtn) throw new Error(`${label}: ${reviewName} not visible after 完成`);
  if (!chrome.img) throw new Error(`${label}: poster image gone after 完成`);
  return chrome;
}

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-compose-shot-"));
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

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: ANDROID_UA,
  });
  const phonePage = await phone.newPage();
  await enterPosterReview(phonePage);
  if (!(await phonePage.getByRole("button", { name: "修改" }).count())) {
    throw new Error("390 review: 修改 tool missing");
  }
  await assertCompose(phonePage, "390");
  await phonePage.screenshot({ path: join(ARTIFACTS, "compose-390.png"), fullPage: false });
  console.log("wrote", join(ARTIFACTS, "compose-390.png"));
  await assertReview(phonePage, "390", "修改");
  await phonePage.screenshot({ path: join(ARTIFACTS, "compose-390-review.png"), fullPage: false });
  await phone.close();

  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const deskPage = await desk.newPage();
  await enterPosterReview(deskPage);
  if (!(await deskPage.getByRole("button", { name: "修改點" }).count())) {
    throw new Error("desktop review: 修改點 missing");
  }
  await assertCompose(deskPage, "desktop");
  await deskPage.screenshot({ path: join(ARTIFACTS, "compose-desktop.png"), fullPage: false });
  console.log("wrote", join(ARTIFACTS, "compose-desktop.png"));
  await assertReview(deskPage, "desktop", "修改點");
  await deskPage.screenshot({ path: join(ARTIFACTS, "compose-desktop-review.png"), fullPage: false });
  await desk.close();

  writeFileSync(
    join(ARTIFACTS, "compose-shots.log"),
    "PASS compose then 完成→review on 390 and desktop; editor-mode=review; 修改/修改點 visible; compose-exit gone\n",
    "utf8",
  );
  console.log("PASS");
} catch (err) {
  const msg = String(err && err.stack ? err.stack : err);
  writeFileSync(join(ARTIFACTS, "compose-shots-fail.log"), msg, "utf8");
  console.error(msg);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => (app ? app.close(() => resolve()) : resolve()));
  await mock?.close?.();
  rmSync(tempRoot, { recursive: true, force: true });
}
