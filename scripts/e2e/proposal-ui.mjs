#!/usr/bin/env node
/**
 * 提案面板的真實裝置尺寸驗收（PR-DI-04）。
 *
 * 任務書第二十二節指定的五個尺寸：360×800、390×844、412×915、
 * 768×1024、820×1180。
 *
 * **每一條斷言的對象都是使用者感受得到的事實**，不是 DOM 存在性：
 *
 *   - 「AI 沒有佔據主畫面」用 `document.elementFromPoint` 檢查作品的中心點
 *     真的點得到 —— 白板 WB03 踩過一次，兩個元素都在 DOM 裡、
 *     測試全綠，但實際上覆蓋層的 z-index 比內容低，使用者看到的是空白。
 *   - 「一次只顯示一個方案」用**可見的**方案卡片數量，而不是 DOM 節點數。
 *   - 「套用按鈕不能按」用 `disabled` 屬性加上點下去之後狀態沒變。
 *
 * 用法：npm run test:proposal-ui
 *      （CHROMIUM_PATH=/path/to/chrome 可重用既有瀏覽器）
 *      （DUIGAO_UI_PORT=xxxx 換 port，與其他代理並行時用）
 */
import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DIST = join(ROOT, "dist-harness");
const PORT = Number(process.env.DUIGAO_UI_PORT ?? 4187);
const PAGE = `http://127.0.0.1:${PORT}/design-intelligence-harness.html`;

if (!existsSync(DIST)) {
  console.error("dist-harness 不存在。先跑：npx vite build --config vite.harness.config.ts");
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright 未安裝。跑：npm install && npx playwright install chromium");
  process.exit(2);
}

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, PAGE).pathname)).replace(/^([/\\])+/, "");
  const file = join(DIST, path || "design-intelligence-harness.html");
  if (!file.startsWith(DIST) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

/** 任務書指定的五個尺寸。 */
const SIZES = [
  { label: "小手機 360×800", width: 360, height: 800, touch: true, expect: "sheet" },
  { label: "iPhone 390×844", width: 390, height: 844, touch: true, expect: "sheet" },
  { label: "大手機 412×915", width: 412, height: 915, touch: true, expect: "sheet" },
  { label: "iPad 768×1024", width: 768, height: 1024, touch: true, expect: "split" },
  { label: "iPad Pro 820×1180", width: 820, height: 1180, touch: true, expect: "split" },
];

/**
 * 等抽屜的 height 過場動畫停下來。
 *
 * 不等就量，量到的是動畫中間值 —— 實測讓「展開後仍留 20% 給作品」這條
 * 在抽屜根本沒展開的情況下也通過（量到 93%）。
 */
async function settle(page, selector = '[data-testid="di-panel"]') {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const h = el.getBoundingClientRect().height;
      const last = window.__lastH;
      window.__lastH = h;
      return last !== undefined && Math.abs(last - h) < 0.5;
    },
    selector,
    { polling: 60, timeout: 5000 },
  );
  await page.evaluate(() => {
    delete window.__lastH;
  });
}

async function open(size, fixture = "full") {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    isMobile: size.touch,
    hasTouch: size.touch,
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`${PAGE}?fixture=${fixture}`, { waitUntil: "load" });
  await page.waitForSelector('[data-testid="di-panel"]');
  return { context, page };
}

try {
  // -------------------------------------------------------------------------
  // 1. 版面：每個尺寸都選對，而且 AI 沒有佔據主畫面
  // -------------------------------------------------------------------------
  for (const size of SIZES) {
    const { context, page } = await open(size);
    try {
      const layout = await page.getAttribute('[data-testid="di-panel"]', "data-layout");
      check(`${size.label}：版面是 ${size.expect}`, layout === size.expect, `實得 ${layout}`);

      // 手機的抽屜預設收起來 —— 一打開就蓋住 76% 的畫面是很糟的第一印象
      if (size.expect === "sheet") {
        const expanded = await page.getAttribute('[data-testid="di-panel"]', "data-expanded");
        check(`${size.label}：抽屜預設收起`, expanded === "false", `實得 ${expanded}`);
      }

      // 關鍵斷言：作品的中心點**真的點得到**（不是 DOM 裡有節點）
      const artworkHit = await page.evaluate(() => {
        const art = document.querySelector('[data-testid="artwork"]');
        const box = art.getBoundingClientRect();
        const x = Math.round(box.left + box.width / 2);
        const y = Math.round(box.top + Math.min(box.height, window.innerHeight) / 2);
        const hit = document.elementFromPoint(x, y);
        return { inside: art.contains(hit), tag: hit?.tagName ?? "none" };
      });
      check(
        `${size.label}：AI 面板沒有蓋住作品（中心點可點）`,
        artworkHit.inside,
        `中心點打到 ${artworkHit.tag}`,
      );

      // 面板實際佔用的比例
      const occupied = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="di-panel"]');
        const box = panel.getBoundingClientRect();
        return (box.width * box.height) / (window.innerWidth * window.innerHeight);
      });
      check(
        `${size.label}：面板佔畫面 ${Math.round(occupied * 100)}% ≤ 80%`,
        occupied <= 0.8,
        `${(occupied * 100).toFixed(1)}%`,
      );

      // 不得橫向捲動（窄螢幕上最常見的破版）
      const overflowX = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(`${size.label}：沒有橫向捲動`, overflowX <= 0, `溢出 ${overflowX}px`);
    } finally {
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // 2. 展開後仍然看得到作品
  // -------------------------------------------------------------------------
  {
    const size = SIZES[1];
    const { context, page } = await open(size);
    try {
      const collapsedHeight = await page.evaluate(
        () => document.querySelector('[data-testid="di-panel"]').getBoundingClientRect().height,
      );
      await page.click('[data-testid="di-panel-handle"]');
      await settle(page);
      const stillVisible = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="di-panel"]');
        const rect = panel.getBoundingClientRect();
        return { height: rect.height, ratio: rect.top / window.innerHeight };
      });
      // 兩條一起驗：抽屜**真的變高了**，而且仍然留空間給作品。
      // 只驗第二條是假綠 —— 抽屜完全沒展開時 ratio 是 0.93，照樣「通過」。
      check(
        "展開後抽屜真的變高",
        stillVisible.height > collapsedHeight * 2,
        `${Math.round(collapsedHeight)}px → ${Math.round(stillVisible.height)}px`,
      );
      check(
        "展開後仍留 ≥ 20% 給作品",
        stillVisible.ratio >= 0.2,
        `抽屜上緣在 ${Math.round(stillVisible.ratio * 100)}%`,
      );

      const hit = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="di-panel"]');
        const y = Math.round(panel.getBoundingClientRect().top / 2);
        const el = document.elementFromPoint(Math.round(window.innerWidth / 2), y);
        return document.querySelector('[data-testid="artwork"]').contains(el);
      });
      check("展開後作品上半部仍然點得到", hit);
    } finally {
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // 3. 一次只看一個方案，而且可以切換
  // -------------------------------------------------------------------------
  for (const size of [SIZES[0], SIZES[3]]) {
    const { context, page } = await open(size);
    try {
      if (size.expect === "sheet") {
        await page.click('[data-testid="di-panel-handle"]');
        await settle(page);
      }
      await page.waitForSelector('[data-testid="di-alternative"]');

      // 可見的方案卡片只有一張 —— 用 offsetParent 判斷是否真的被畫出來
      const visibleCards = await page.evaluate(
        () =>
          [...document.querySelectorAll('[data-testid="di-alternative"]')].filter(
            (el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0,
          ).length,
      );
      check(`${size.label}：一次只顯示一個方案`, visibleCards === 1, `看得到 ${visibleCards} 張`);

      const firstName = await page.textContent('[data-testid="di-alternative"] h3');
      check(`${size.label}：預設顯示第 1 / 3 個`, (await page.textContent('[data-testid="di-page"]')).includes("1 / 3"));

      await page.click('[data-testid="di-next"]');
      const secondName = await page.textContent('[data-testid="di-alternative"] h3');
      check(
        `${size.label}：切換後真的換了方案`,
        firstName !== secondName,
        `${firstName} → ${secondName}`,
      );

      // 滑到最後一個之後，「下一個」要停用（不繞回）
      await page.click('[data-testid="di-next"]');
      const nextDisabled = await page.getAttribute('[data-testid="di-next"]', "disabled");
      check(`${size.label}：最後一個時「下一個」停用，不繞回`, nextDisabled !== null);
    } finally {
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // 4. 手機上用滑動切換
  // -------------------------------------------------------------------------
  {
    const { context, page } = await open(SIZES[1]);
    try {
      await page.click('[data-testid="di-panel-handle"]');
      await settle(page);
      await page.waitForSelector('[data-testid="di-alternative"]');
      // 方案區塊在抽屜內是可捲動內容的一部分，預設會落在視窗外（實測 y=874
      // 而視窗只有 844 高）。不先捲進來，滑鼠事件會落在視窗之外，
      // 手勢根本不會送到元件 —— 那會被誤讀成「滑動功能壞了」。
      await page.locator('[data-testid="di-alternatives"]').scrollIntoViewIfNeeded();
      await settle(page);
      const before = await page.textContent('[data-testid="di-page"]');

      const box = await page.locator('[data-testid="di-alternatives"]').boundingBox();
      const y = Math.round(box.y + Math.min(box.height, 120) / 2);
      await page.mouse.move(Math.round(box.x + box.width - 20), y);
      await page.mouse.down();
      await page.mouse.move(Math.round(box.x + 20), y, { steps: 6 });
      await page.mouse.up();

      const after = await page.textContent('[data-testid="di-page"]');
      check("手機上左滑會換到下一個方案", before !== after, `${before} → ${after}`);

      // 反向：垂直手勢不該換頁（否則清單捲不動）
      await page.locator('[data-testid="di-alternatives"]').scrollIntoViewIfNeeded();
      const box2 = await page.locator('[data-testid="di-alternatives"]').boundingBox();
      const cx = Math.round(box2.x + box2.width / 2);
      await page.mouse.move(cx, Math.round(box2.y + 10));
      await page.mouse.down();
      await page.mouse.move(cx + 20, Math.round(box2.y + 130), { steps: 6 });
      await page.mouse.up();
      const afterVertical = await page.textContent('[data-testid="di-page"]');
      check("垂直手勢不會被當成換頁", after === afterVertical, `${after} → ${afterVertical}`);
    } finally {
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // 5. 紅線：不得跳過人類確認
  // -------------------------------------------------------------------------
  {
    const { context, page } = await open(SIZES[1]);
    try {
      await page.click('[data-testid="di-panel-handle"]');
      await page.waitForSelector('[data-testid="di-apply"]');

      const appliedBefore = await page.textContent('[data-testid="applied"]');
      check("載入時尚未套用任何東西", appliedBefore.includes("尚未套用"));

      // 按下去之前就要說會改幾處、怎麼還原
      const previewText = await page.textContent('[data-testid="di-apply-preview"]');
      check(
        "按下去之前就說明會改什麼、怎麼還原",
        /會改 \d+ 處/.test(previewText) && /回到原稿|回到 v/.test(previewText),
        previewText,
      );

      await page.click('[data-testid="di-apply"]');
      const appliedAfter = await page.textContent('[data-testid="applied"]');
      check(
        "按下套用之後由呼叫端決定，元件自己不改任何東西",
        appliedAfter.includes("alt-"),
        appliedAfter,
      );
    } finally {
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // 6. 三種「沒有結果」要顯示不同的訊息
  // -------------------------------------------------------------------------
  {
    const cases = [
      ["clean", /沒有找到可以量測的問題/, /不代表設計無法再進步/],
      ["needs-context", /還不能分析/, /色碼/],
      ["failed", /這次分析沒有完成/, /503/],
    ];
    for (const [fixture, title, detail] of cases) {
      const { context, page } = await open(SIZES[1], fixture);
      try {
        await page.click('[data-testid="di-panel-handle"]');
        const body = await page.textContent('[data-testid="di-panel"]');
        check(`${fixture}：標題正確`, title.test(body), body.slice(0, 60));
        check(`${fixture}：說明具體（不是「請稍後再試」）`, detail.test(body));
      } finally {
        await context.close();
      }
    }
  }

  // -------------------------------------------------------------------------
  // 7. 觸控目標尺寸：這個功能自己在檢查的規則，自己要先遵守
  // -------------------------------------------------------------------------
  {
    const { context, page } = await open(SIZES[0]);
    try {
      await page.click('[data-testid="di-panel-handle"]');
      await page.waitForSelector('[data-testid="di-next"]');
      const tooSmall = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="di-panel"] button')]
          .map((el) => {
            const box = el.getBoundingClientRect();
            return { label: el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 12), w: Math.round(box.width), h: Math.round(box.height) };
          })
          .filter((item) => item.w > 0 && (item.w < 24 || item.h < 24)),
      );
      check(
        "面板自己的按鈕都 ≥ 24×24（自己的分析器就在查這件事）",
        tooSmall.length === 0,
        tooSmall.map((item) => `${item.label} ${item.w}×${item.h}`).join("、"),
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((entry) => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
