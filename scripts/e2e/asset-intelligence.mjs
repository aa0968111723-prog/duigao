#!/usr/bin/env node
/** Mobile acceptance for the room AI bottom sheet.
 *
 * The room/review flow is real and the Supabase stand-in is used for auth and
 * room creation. Intelligence rows and the provider response are intercepted
 * with bounded fixtures so this test never needs a real model key or private
 * Storage object.
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile as read } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { start as startMock } from "./mock-supabase.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const MOCK_PORT = 54409;
const APP_PORT = 4181;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const INTELLIGENCE_ASSET = "11111111-1111-4111-8111-111111111111";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed. Run npm install && npx playwright install chromium");
  process.exit(2);
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
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
      res.writeHead(200, { "content-type": {
        ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
      }[extname(file)] ?? "application/octet-stream" });
      res.end(buffer);
    } catch {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await read(join(root, "index.html")));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

const tempRoot = mkdtempSync(join(process.env.TEMP ?? process.cwd(), "duigao-ai-e2e-"));
const dist = join(tempRoot, "dist");
let mock;
let app;
let browser;

try {
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
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
  });
  const page = await context.newPage();

  await page.route("**/rest/v1/intelligent_assets*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{
      id: INTELLIGENCE_ASSET,
      room_id: "22222222-2222-4222-8222-222222222222",
      branch_id: null,
      version_id: null,
      asset_type: "image",
      title: "擺攤照片 03",
      original_filename: "IMG_2838.jpg",
      mime_type: "image/jpeg",
      storage_path: "rooms/private/asset.jpg",
      source: "upload",
      status: "ready",
      analysis_version: "1.0",
      analysis_provider: "fixture",
      analysis_updated_at: "2026-01-01T00:00:00.000Z",
      ai_readable: true,
      external_ai_allowed: false,
      content_hash: "hash",
      metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }]),
  }));
  await page.route("**/rest/v1/asset_analysis*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{ asset_id: INTELLIGENCE_ASSET, summary: "戶外社團活動照片，適合活動紀錄與社群貼文。", detected_text: "加入招生", topics: ["學生", "戶外"], keywords: ["主視覺"], structured_data: { headline: "加入招生", possibleUses: ["活動紀錄", "社群貼文"] }, updated_at: "2026-01-01T00:00:00.000Z" }]),
  }));
  await page.route("**/rest/v1/asset_regions*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/asset_video_segments*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/asset_document_chunks*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/asset_human_metadata*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/asset_analysis_jobs*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/rest/v1/asset_relations*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/functions/v1/room-ai-context", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        room: { id: body.roomId, title: "淡江招生企劃房" },
        query: body.query,
        context: [{ sourceId: INTELLIGENCE_ASSET, assetId: INTELLIGENCE_ASSET, title: "擺攤照片 03", assetType: "image", isCurrent: true, archived: false, topics: ["學生", "戶外"], keywords: ["主視覺"], summary: "戶外社團活動照片，適合活動紀錄與社群貼文。" }],
        sources: [{ sourceId: INTELLIGENCE_ASSET, assetId: INTELLIGENCE_ASSET, title: "擺攤照片 03", assetType: "image", excerpt: "戶外社團活動照片" }],
        relations: [],
        permissions: { role: "owner", canAsk: true, selectedCount: 0 },
        truncated: false,
        answer: {
          text: "這張照片適合當擺攤活動紀錄或社群貼文；若作主視覺，請留意背景資訊較多。",
          citations: [{ sourceId: INTELLIGENCE_ASSET }],
          actions: [
            { type: "add_whiteboard_node", label: "把主視覺放上白板", payload: { text: "擺攤主視覺", nodeType: "text" } },
            { type: "create_comment", label: "把這句留到討論", payload: { body: "這張適合當擺攤紀錄" } },
          ],
        },
        agent: { provider: "none", status: "unconfigured" },
      }),
    });
  });

  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.fill("input.text-input", "AI 手機測試者");
  await page.click("button.btn-primary");
  await page.waitForSelector(".home-picks", { timeout: 20000 });
  await page.getByRole("button", { name: /建立活動房/ }).click();
  await page.waitForSelector('[data-testid="multi-branch-room"]', { timeout: 15000 });
  check("Android 390px 房間仍能載入", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByTestId("room-ai-launcher").click();
  await page.waitForSelector('[data-testid="room-ai-sheet"]', { timeout: 10000 });
  check("手機 AI 入口是 bottom sheet，且活動房只有一個 AI 入口", await page.locator('[data-testid="room-ai-sheet"]').isVisible() && await page.getByTestId("room-ai-launcher").count() === 1);
  await page.waitForFunction(() => document.querySelector(".asset-ai-assets-toggle")?.textContent?.includes("1 項"), null, { timeout: 10000 });
  await page.getByRole("button", { name: "素材理解" }).click();
  check("素材理解預設收起、點擊才展開", await page.locator('[data-testid^="ai-asset-"]').count() === 1);
  check("文宣理解卡顯示結構化重點", await page.getByText("主標題").isVisible() && await page.getByText("加入招生").isVisible());
  await page.getByRole("button", { name: "設定" }).click();
  check("owner 可在手機素材卡管理 AI policy 與人工標記", await page.getByText("允許 AI 讀取").isVisible() && await page.getByText("人工修正").isVisible());
  await page.getByRole("button", { name: "這次企劃還缺什麼？" }).click();
  await page.waitForSelector('[data-testid="room-ai-answer"]', { timeout: 10000 });
  check("快速提問能顯示房間證據與答案", (await page.getByTestId("room-ai-answer").innerText()).includes("這張照片適合"));
  check("AI 回答保留可點擊來源", await page.locator(".asset-ai-citations button").count() === 1);
  check("AI 提案先預覽、不會自動寫入", await page.getByTestId("ai-proposal").count() === 2 && await page.getByTestId("apply-proposal").count() === 2);
  await page.getByTestId("apply-proposal").nth(1).click();
  await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=ai-proposal]")].some((el) => el.textContent?.includes("已套用")), null, { timeout: 8000 });
  check("套用討論提案會寫入而不改原稿", await page.getByText("已套用。原稿沒有被改寫。").count() === 1);
  await page.getByTestId("apply-proposal").first().click();
  await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=ai-proposal]")].filter((el) => el.textContent?.includes("已套用")).length >= 2, null, { timeout: 8000 });
  check("套用白板提案走 0014 production node", await page.getByTestId("apply-proposal").count() === 0);
  await page.getByLabel("關閉 AI").click();
  await page.waitForSelector('[data-testid="whiteboard-workspace"]', { timeout: 8000 });
  await page.waitForFunction(() => Number(document.querySelector("[data-testid=wb-stats]")?.getAttribute("data-nodes") || 0) >= 1, null, { timeout: 8000 });
  const nodeValue = await page.locator('[data-testid^="wb-node-"] textarea').first().inputValue().catch(() => "");
  const nodeLabel = await page.locator('[data-testid^="wb-node-"]').first().innerText().catch(() => "");
  check("白板出現套用後的 production 節點", nodeValue.includes("擺攤主視覺") || nodeLabel.includes("擺攤主視覺"));
  await page.getByRole("button", { name: "對話" }).click();
  check("討論看得到套用後的留言", (await page.locator("body").innerText()).includes("這張適合當擺攤紀錄"));
  await page.screenshot({ path: join(tempRoot, "asset-intelligence-android.png"), fullPage: false });
  await context.close();
} finally {
  if (browser) await browser.close();
  if (app) await new Promise((resolve) => app.close(resolve));
  if (mock) await mock.close();
  rmSync(tempRoot, { recursive: true, force: true });
}

if (results.some((item) => !item.pass)) process.exit(1);
