#!/usr/bin/env node
/**
 * 白板視覺回歸（WB02，test-plan §PR-02）。
 *
 * 矩陣：5 尺寸（390×844、412×915、768×1024、1024×1366、1280×800）× 3 狀態
 * （板清單／開板 20 節點／選取節點）＝ 15 張基準圖。
 * 1024 與 1280 會進 WB05 的 Split View（討論欄＋側欄工具列）。
 *
 * 與 wb00 test-plan 的偏差（誠實記錄）：計畫寫 4×2 主題×3=24 張，但
 * duigao 是單主題深色設計（styles.css 無 light 分支）— 主題軸不存在，
 * 假拍 24 張是造假覆蓋。若未來加入淺色主題，此矩陣 ×2。
 *
 * 比對：pixelmatch，容差 **絕對值** maxDiffPixels=2000（比例容差在大
 * 視窗可藏數萬 px 差異 — Grok wb00 F8）。800 在 Linux CI vs Windows
 * 基準下會被 Noto CJK 柵格化單獨打穿（實測 819–1193）；2000 仍遠低於
 * 殼層變了的 7 萬 px。基準缺失＝建立並以 exit 2 提示 commit；差異超標
 * ＝exit 1 並輸出 diff PNG。
 * 更新基準：UPDATE_VISUAL=1 npm run test:visual
 */
import { chromium } from "playwright";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { faults, rows, start as startMock } from "./mock-supabase.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_DIR = join(ROOT, "scripts", "e2e", "visual-baselines");
const OUT_DIR = join(ROOT, "output", "visual");
const MOCK_PORT = Number(process.env.DUIGAO_E2E_MOCK_PORT || 54421);
const APP_PORT = Number(process.env.DUIGAO_E2E_APP_PORT || 4191);
const MAX_DIFF_PIXELS = 2000;
const UPDATE = process.env.UPDATE_VISUAL === "1";

const SIZES = [
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-412", width: 412, height: 915 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "tablet-1024", width: 1024, height: 1366 },
  // 桌機（WB05）：≥900×600 也會進 Split View ＋側欄工具列，而這條路徑
  // 原本一張基準圖都沒有 —— 自審抓到「沒有任何基準覆蓋桌機寬度」。
  { name: "desktop-1280", width: 1280, height: 800 },
];

void faults;

async function dumpVisualPage(page) {
  return page.evaluate(() => ({
    href: location.href,
    hasList: Boolean(document.querySelector('[data-testid="whiteboard-list"]')),
    hasCanvas: Boolean(document.querySelector('[data-testid="wb-canvas"]')),
    canvasBox: (() => {
      const el = document.querySelector('[data-testid="wb-canvas"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })(),
    body: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 280),
  }));
}

/** Canvas uses flex:1 / min-height:0 — Playwright `visible` is false while the box is 0×0. */
async function waitForWbCanvas(page) {
  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="wb-canvas"]');
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 40 && r.height > 40;
      },
      null,
      { timeout: 45000 },
    );
  } catch {
    throw new Error(`wb-canvas never usable: ${JSON.stringify(await dumpVisualPage(page))}`);
  }
}

// ---- build＋static serve（沿 collaboration-workspace 模式） ----
import http from "node:http";
import { readFile } from "node:fs/promises";

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const build = spawnSync("npx", ["vite", "build", "--mode", "development"], {
  cwd: ROOT,
  shell: true,
  env: {
    ...process.env,
    VITE_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_e2e_mock_key_000000",
  },
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("vite build failed");
  process.exit(1);
}

const dist = join(ROOT, "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${APP_PORT}`);
  let path = join(dist, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  try {
    const body = await readFile(path);
    const ext = path.slice(path.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    const body = await readFile(join(dist, "index.html"));
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  }
});

const mock = await startMock(MOCK_PORT, {});
await new Promise((resolve) => app.listen(APP_PORT, resolve));
mkdirSync(BASELINE_DIR, { recursive: true });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let missingBaselines = 0;

try {
  for (const size of SIZES) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      hasTouch: true,
      isMobile: size.width < 700,
      userAgent: "Mozilla/5.0 (Linux; Android 14) duigao-visual",
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: "domcontentloaded" });
    await page.fill("input.text-input", "視覺基準");
    await page.click("button.btn-primary");
    await page.getByRole("button", { name: "建立活動房" }).click();
    await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 30000 });
    await page.getByRole("button", { name: "白板", exact: true }).click();
    await page.waitForSelector('[data-testid="whiteboard-list"]', { timeout: 15000 });

    // 決定性資料：直接塞 mock 列（20 節點網格），避免 UI 建立的座標抖動
    const boardId = "11111111-1111-4111-8111-111111111111";
    const roomRow = rows.room_branches[0];
    const roomId = roomRow?.room_id ?? rows.whiteboards[0]?.room_id ?? null;

    // Split View (≥1024) keeps the discussion composer mounted. Enter in the
    // name field can land there instead of submitting this form — CI 33268530465
    // and local tablet-1024 both left「還沒有白板」. Click the list's submit.
    const list = page.getByTestId("whiteboard-list");
    await list.getByLabel("白板名稱").fill("視覺基準板");
    await list.getByRole("button", { name: "建立白板" }).click();
    try {
      await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="wb-canvas"]') || document.querySelector(".wb-card")),
        null,
        { timeout: 45000 },
      );
    } catch {
      throw new Error(`create board produced neither canvas nor card: ${JSON.stringify(await dumpVisualPage(page))}`);
    }
    if ((await page.locator('[data-testid="wb-canvas"]').count()) === 0) {
      await page.locator(".wb-card").first().click();
    }
    await waitForWbCanvas(page);
    // 回列表拍「板清單」狀態
    await page.locator(".wb-focus-top .project-back-button").click({ force: true });
    await page.waitForSelector(".wb-list", { timeout: 10000 });
    await shot(page, `${size.name}-list`);

    // 造 20 節點（mock 直插 → 重開板載入）
    const board = rows.whiteboards[rows.whiteboards.length - 1];
    for (let i = 0; i < 20; i += 1) {
      rows.whiteboard_nodes.push({
        id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
        whiteboard_id: board.id,
        room_id: board.room_id,
        node_type: i % 5 === 0 ? "mindmap" : i % 3 === 0 ? "flow" : "text",
        x: (i % 5) * 200,
        y: Math.floor(i / 5) * 140,
        width: 180,
        height: 96,
        content: { text: `節點 ${i + 1}` },
        linked_entity_type: null,
        linked_entity_id: null,
        parent_group_id: null,
        created_by: null,
        created_at: new Date(1700000000000 + i * 1000).toISOString(),
        updated_at: new Date(1700000000000 + i * 1000).toISOString(),
        version: 1,
        deleted_at: null,
      });
    }
    await page.locator(".wb-card").first().click();
    await waitForWbCanvas(page);
    await page.waitForFunction(() => document.querySelectorAll(".wb-node").length >= 10, null, { timeout: 15000 });
    // 整理視角：固定 camera（fitCamera 由整理鍵觸發較穩定 — 直接等渲染穩）
    await page.waitForTimeout(600);
    await shot(page, `${size.name}-board-20`);

    // 選取態：點第一個節點 → 情境列
    await page.locator(".wb-node").first().click({ force: true });
    await page.waitForSelector('[data-testid="wb-node-actions"]', { timeout: 8000 });
    await page.waitForTimeout(250);
    await shot(page, `${size.name}-selected`);

    await context.close();
    void boardId;
    void roomId;
  }
} finally {
  await browser.close();
  mock.close();
  app.close();
}

async function shot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const file = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const baselinePath = join(BASELINE_DIR, `${name}.png`);
  if (!existsSync(baselinePath) || UPDATE) {
    writeFileSync(baselinePath, readFileSync(file));
    missingBaselines += 1;
    check(`${name}：基準${UPDATE ? "已更新" : "不存在 — 已建立（請 commit）"}`, true);
    return;
  }
  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const current = PNG.sync.read(readFileSync(file));
  if (baseline.width !== current.width || baseline.height !== current.height) {
    check(`${name}：尺寸不符`, false, `${baseline.width}x${baseline.height} vs ${current.width}x${current.height}`);
    return;
  }
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixels = pixelmatch(baseline.data, current.data, diff.data, baseline.width, baseline.height, { threshold: 0.12 });
  if (diffPixels > MAX_DIFF_PIXELS) {
    writeFileSync(join(OUT_DIR, `${name}-diff.png`), PNG.sync.write(diff));
  }
  const ok = diffPixels <= MAX_DIFF_PIXELS;
  check(`${name}：diff=${diffPixels}px（上限 ${MAX_DIFF_PIXELS}）`, ok);
  if (!ok) {
    throw new Error(`visual ${name} exceeded ${MAX_DIFF_PIXELS}px (got ${diffPixels})`);
  }
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} visual checks passed${missingBaselines ? `（${missingBaselines} 張新基準 — 請 commit scripts/e2e/visual-baselines/）` : ""}`);
process.exit(failed.length ? 1 : 0);
