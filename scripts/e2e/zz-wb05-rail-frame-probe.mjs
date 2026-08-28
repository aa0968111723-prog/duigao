import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { start as startMock } from "./mock-supabase.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = 54433;
const APP_PORT = 4197;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const { chromium } = await import("playwright");

function serveStatic(root, port) {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    const file = join(root, normalize(pathname === "/" ? "/index.html" : pathname));
    try {
      const buffer = await read(file);
      res.writeHead(200, { "content-type": {
        ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
      }[extname(file)] ?? "application/octet-stream" });
      res.end(buffer);
    } catch {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await read(join(root, "index.html")));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const SAMPLER = `
window.__frames = [];
window.__sampling = false;
window.__startSampling = (budget) => {
  window.__frames = [];
  window.__sampling = true;
  const tick = () => {
    if (!window.__sampling) return;
    const f = document.querySelector('.wb-focus');
    const r = document.querySelector('.wb-side-rail');
    const cs = f ? getComputedStyle(f) : null;
    const rs = r ? getComputedStyle(r) : null;
    let under = null;
    if (f && cs && parseFloat(cs.left) > 10) {
      const el = document.elementFromPoint(Math.min(170, parseFloat(cs.left) / 2), Math.floor(window.innerHeight / 2));
      under = el ? (el.tagName + '.' + (el.className && el.className.toString ? el.className.toString().slice(0, 60) : '')) : 'none';
    }
    window.__frames.push({
      t: Math.round(performance.now()),
      focus: !!f,
      left: cs ? cs.left : null,
      rail: !!r,
      railDisplay: rs ? rs.display : null,
      railW: r ? Math.round(r.getBoundingClientRect().width) : 0,
      under,
    });
    if (window.__frames.length < budget) requestAnimationFrame(tick);
    else window.__sampling = false;
  };
  requestAnimationFrame(tick);
};
`;

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-rail-"));
const dist = join(tempRoot, "cloud");
console.log("building…");
execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], {
  cwd: ROOT, stdio: "pipe", shell: process.platform === "win32",
  env: { ...process.env, VITE_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_mock_key_000000" },
});
const mock = await startMock(MOCK_PORT);
const app = await serveStatic(dist, APP_PORT);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
const page = await context.newPage();
await page.addInitScript(SAMPLER);
page.on("pageerror", (e) => console.log("PAGE_ERR", String(e).slice(0, 200)));

const report = (label, frames) => {
  const bad = frames.filter((f) => f.focus && f.left === "340px" && (!f.rail || f.railDisplay === "none" || f.railW < 300));
  const good = frames.filter((f) => f.focus && f.rail && f.railW >= 300);
  console.log(`\n=== ${label} ===`);
  console.log(`frames=${frames.length}  firstFocusFrame=${frames.findIndex((f) => f.focus)}  focusFrames=${frames.filter((f) => f.focus).length}  goodFrames=${good.length}`);
  console.log(`BAD (focus offset 340px, rail missing/hidden) = ${bad.length}`);
  if (bad.length) console.log("bad samples:", JSON.stringify(bad.slice(0, 6)));
  const around = frames.map((f, i) => ({ i, ...f })).filter((f) => f.focus).slice(0, 4);
  console.log("first focus frames:", JSON.stringify(around));
  return bad.length;
};

let badTotal = 0;
try {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", "側欄探針");
  await page.click("button.btn-primary");
  await page.waitForSelector(".home-picks", { timeout: 30000 });
  await page.getByRole("button", { name: /建立活動房/ }).click();
  await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 15000 });
  await page.getByRole("button", { name: "白板", exact: true }).click();
  await page.getByLabel("白板名稱").fill("探針板");
  await page.getByRole("button", { name: "建立白板" }).click();
  await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
  console.log("rail after create:", await page.evaluate(() => {
    const r = document.querySelector('.wb-side-rail');
    const f = document.querySelector('.wb-focus');
    return { rail: !!r, railW: r ? r.getBoundingClientRect().width : 0, left: f ? getComputedStyle(f).left : null };
  }));

  // back to list
  await page.locator(".wb-focus-top .project-back-button").click();
  await page.waitForSelector(".wb-list", { timeout: 10000 });

  // ---- Scenario A: open a board by clicking its card (repeat to catch a flaky frame) ----
  for (let round = 1; round <= 5; round += 1) {
    await page.evaluate(() => window.__startSampling(150));
    await page.waitForTimeout(50);
    await page.locator(".wb-card").first().click();
    await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
    await page.waitForTimeout(900);
    const frames = await page.evaluate(() => { window.__sampling = false; return window.__frames; });
    badTotal += report(`A${round} click board card`, frames);
    await page.locator(".wb-focus-top .project-back-button").click();
    await page.waitForSelector(".wb-list", { timeout: 10000 });
  }

  // ---- Scenario B: cold reload while a board is open (deep-link-ish mount) ----
  await page.locator(".wb-card").first().click();
  await page.waitForSelector('[data-testid="wb-canvas"]', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.addInitScript(`${SAMPLER}; window.__startSampling(240);`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const framesB = await page.evaluate(() => { window.__sampling = false; return window.__frames || []; });
  badTotal += report("B cold reload", framesB);
  console.log("after reload state:", await page.evaluate(() => {
    const r = document.querySelector('.wb-side-rail');
    const f = document.querySelector('.wb-focus');
    return { rail: !!r, focus: !!f, left: f ? getComputedStyle(f).left : null };
  }));

  console.log(`\nTOTAL BAD FRAMES = ${badTotal}`);
} catch (error) {
  console.log("ERR", error?.stack?.slice(0, 600));
} finally {
  await browser.close();
  app.close();
  mock.close?.();
  process.exit(0);
}
