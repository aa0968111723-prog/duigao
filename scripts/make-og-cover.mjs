#!/usr/bin/env node
/**
 * Renders the two generic 1200×630 cards the share-preview Edge Function falls
 * back to whenever there is no room thumbnail to show (preview revoked, cover
 * turned off, or the lookup failed):
 *
 *   public/og-cover.png        對稿品牌 — 圖片房
 *   public/og-video-cover.png  對稿品牌 — 影片房
 *
 * Two of them, because one generic card cannot be honest about both: a video
 * link that falls back to 「文宣討論區」 tells the reader the wrong thing about
 * what they are about to open. Neither card shows any room content — that is
 * the point of a generic cover, and a video frame in particular must never be
 * published this way.
 *
 * They are committed as PNGs so neither the app build nor the Edge Function
 * depends on a rendering step; this script exists so the assets are
 * reproducible rather than mystery binaries.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/make-og-cover.mjs
 *   (CHROMIUM_PATH=/path/to/chrome to reuse an existing browser)
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("playwright is not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

const cardHtml = (body) => `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; display: grid; place-items: center;
    background:
      radial-gradient(90% 100% at 8% 8%, rgba(139, 131, 255, .24), transparent 58%),
      radial-gradient(80% 90% at 92% 92%, rgba(22, 170, 138, .18), transparent 62%),
      #f7f8fc;
    color: #192237;
    font-family: "Noto Sans TC", "WenQuanYi Zen Hei", "PingFang TC", "Microsoft JhengHei", sans-serif;
  }
  .wrap { text-align: center; padding: 0 96px; }
  .mark { width: 88px; height: 88px; margin: 0 auto 26px; border-radius: 28px; background: linear-gradient(145deg, #8b83ff, #574be5); display: grid; place-items: center; box-shadow: 0 18px 42px rgba(87,75,229,.25); }
  .mark svg { width: 64px; height: 64px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .eyebrow { color: #6157ef; font-size: 19px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
  h1 { margin-top: 12px; font-size: 82px; font-weight: 800; letter-spacing: 0.08em; line-height: 1.1; }
  .kind { display: inline-flex; align-items: center; min-height: 40px; margin-top: 18px; padding: 0 20px; border: 1px solid rgba(97,87,239,.2); border-radius: 999px; background: rgba(97,87,239,.1); color: #6157ef; font-size: 22px; font-weight: 800; letter-spacing: .08em; }
  p { margin-top: 24px; font-size: 29px; line-height: 1.6; color: rgba(25,34,55,.68); }
</style></head><body>${body}</body></html>`;

const BRAND_MARK = `<div class="mark"><svg viewBox="0 0 36 36" aria-hidden="true"><path d="M9.5 7.5h14a5 5 0 0 1 5 5v7.75a5 5 0 0 1-5 5h-7.6L10 30v-4.75h-.5a5 5 0 0 1-5-5V12.5a5 5 0 0 1 5-5Z"/><path d="m12 17 3.25 3.25L23.5 12"/></svg></div>`;

const CARDS = [
  {
    file: "og-cover.png",
    body: `<div class="wrap">
      ${BRAND_MARK}
      <div class="eyebrow">Review together</div>
      <h1>對稿</h1>
      <div class="kind">圖片</div>
      <p>點文宣上需要調整的位置，留一句話就可以</p>
    </div>`,
  },
  {
    file: "og-video-cover.png",
    body: `<div class="wrap">
      ${BRAND_MARK}
      <div class="eyebrow">Review together</div>
      <h1>對稿</h1>
      <div class="kind">影片</div>
      <p>在時間點留下修改建議</p>
    </div>`,
  },
];

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
for (const card of CARDS) {
  const out = join(PUBLIC, card.file);
  await page.setContent(cardHtml(card.body), { waitUntil: "load" });
  await page.screenshot({ path: out, type: "png" });
  console.log(`wrote ${out}`);
}
await browser.close();
