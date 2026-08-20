#!/usr/bin/env node
/**
 * Renders `public/og-cover.png` — the generic 1200×630 card the share-preview
 * Edge Function falls back to whenever there is no poster thumbnail to show
 * (preview revoked, 顯示文宣縮圖 turned off, or the lookup failed).
 *
 * It is committed as a PNG so neither the app build nor the Edge Function
 * depends on a rendering step; this script exists so the asset is reproducible
 * rather than a mystery binary.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/make-og-cover.mjs
 *   (CHROMIUM_PATH=/path/to/chrome to reuse an existing browser)
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "og-cover.png");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

const HTML = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; display: grid; place-items: center;
    background:
      radial-gradient(120% 90% at 78% 12%, rgba(196, 92, 74, 0.30), transparent 62%),
      radial-gradient(90% 80% at 12% 92%, rgba(61, 107, 140, 0.24), transparent 60%),
      #141210;
    color: #efe7dd;
    font-family: "Noto Sans TC", "WenQuanYi Zen Hei", "PingFang TC", "Microsoft JhengHei", sans-serif;
  }
  .wrap { text-align: center; padding: 0 96px; }
  .mark {
    width: 74px; height: 74px; margin: 0 auto 34px; border-radius: 22px;
    background: #c45c4a; display: grid; place-items: center;
  }
  .mark span { display: block; width: 26px; height: 26px; border-radius: 50%; background: #efe7dd; }
  h1 { font-size: 82px; font-weight: 700; letter-spacing: 0.06em; line-height: 1.1; }
  p { margin-top: 26px; font-size: 32px; line-height: 1.6; color: rgba(239, 231, 221, 0.74); }
  .rule { width: 96px; height: 4px; margin: 40px auto 0; border-radius: 2px; background: rgba(196, 92, 74, 0.85); }
</style></head><body>
  <div class="wrap">
    <div class="mark"><span></span></div>
    <h1>文宣討論區</h1>
    <p>點文宣上需要調整的位置，留一句話就可以</p>
    <div class="rule"></div>
  </div>
</body></html>`;

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(HTML, { waitUntil: "load" });
await page.screenshot({ path: OUT, type: "png" });
await browser.close();
console.log(`wrote ${OUT}`);
