#!/usr/bin/env node
/**
 * PR #21 acceptance run for the share-preview Open Graph endpoint.
 *
 * The whole point of this feature is a security invariant that is easy to
 * break by accident: **the invite token must never reach the preview server.**
 * It lives in the URL fragment, browsers never transmit a fragment, and the
 * function is therefore structurally unable to see it. This suite pins that
 * down, plus everything a social crawler needs.
 *
 * It runs the REAL Edge Function source (`supabase/functions/share-preview/
 * index.ts`), transpiled with the TypeScript already in devDependencies and
 * loaded against a tiny `Deno` shim, so there is nothing to keep in sync with a
 * hand-written copy. Supabase itself is stood in for by a mock that implements
 * exactly one route — `get_share_preview` — which also lets the run prove the
 * function touches nothing else.
 *
 *   node scripts/e2e/share-preview.mjs
 *
 * The browser leg (fragment survives the redirect) needs Playwright; when it is
 * missing that leg is skipped and the rest still runs.
 */
import http from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import ts from "typescript";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FN_SOURCE = join(ROOT, "supabase", "functions", "share-preview", "index.ts");
const MIGRATION = join(ROOT, "supabase", "migrations", "0005_share_previews.sql");
const MIGRATION_0011 = join(ROOT, "supabase", "migrations", "0011_share_preview_customization.sql");
const THUMB_SOURCE = join(ROOT, "src", "cloud", "shareThumbnail.ts");

/** The secret that must never, ever appear in a preview response. */
const INVITE_SECRET = "VERY_SECRET_TEST_VALUE";
const ROOM_ID = "11111111-2222-3333-4444-555555555555";

const APP_ORIGIN_PORT = 4185;
const MOCK_PORT = 54401;
const FN_PORT = 54402;
const APP_ORIGIN = `http://127.0.0.1:${APP_ORIGIN_PORT}`;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

let failures = 0;
let checks = 0;
function ok(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------- fixtures
/**
 * Stand-in for Supabase PostgREST implementing only the share-card projections,
 * with the same visibility rules as the SQL:
 *
 *   get_share_preview     (0005) — disabled previews return no rows at all
 *   get_share_preview_v3  (0011) — answers for disabled previews too, but with
 *                                  every content field nulled; only media_type
 *                                  survives, so the card can pick the right
 *                                  brand instead of calling a cut 「文宣討論區」
 *
 * Previews with the cover turned off return no image in either.
 *
 * `v3Available` lets the run prove the deploy-order story: the function must
 * still render real cards on a project that has not applied 0011 yet.
 */
const previews = new Map();
const rpcLog = [];
let v3Available = true;

const mock = http.createServer(async (req, res) => {
  rpcLog.push(`${req.method} ${req.url}`);
  const v3 = req.url === "/rest/v1/rpc/get_share_preview_v3";
  const v1 = req.url === "/rest/v1/rpc/get_share_preview";
  if ((!v1 && !v3) || req.method !== "POST" || (v3 && !v3Available)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "no such route" }));
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const row = previews.get(body.p_preview_id);
  res.writeHead(200, { "content-type": "application/json" });
  if (!row) {
    res.end("[]");
    return;
  }
  if (v3) {
    res.end(
      JSON.stringify([
        {
          title: row.enabled ? row.title : null,
          description: row.enabled ? row.description : null,
          image_path: row.enabled && row.show_thumbnail ? row.thumbnail_path : null,
          media_type: row.media_type === "video" ? "video" : "image",
          updated_at: row.updated_at,
          version_archived: false,
          revoked: !row.enabled,
        },
      ]),
    );
    return;
  }
  res.end(
    JSON.stringify(
      row.enabled
        ? [
            {
              title: row.title,
              description: row.description,
              image_path: row.show_thumbnail ? row.thumbnail_path : null,
              updated_at: row.updated_at,
            },
          ]
        : [],
    ),
  );
});

/** A stand-in for the deployed app: records where the redirect landed. */
let lastLanding = null;
const appOrigin = http.createServer((req, res) => {
  lastLanding = req.url;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>app</title><body>app</body>");
});

// ------------------------------------------------------- load the function
async function loadHandler(tmp) {
  const source = await readFile(FN_SOURCE, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "index.ts",
  }).outputText;
  const file = join(tmp, "share-preview.mjs");
  await writeFile(file, js, "utf8");

  let handler = null;
  globalThis.Deno = {
    env: {
      get: (key) =>
        ({
          SUPABASE_URL: MOCK_URL,
          SUPABASE_ANON_KEY: "anon-test-key",
          APP_ORIGIN,
        })[key],
    },
    serve: (fn) => {
      handler = fn;
      return { finished: Promise.resolve() };
    },
  };
  await import(pathToFileURL(file).href);
  if (!handler) throw new Error("the function did not register a handler");
  return handler;
}

const CRAWLERS = {
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  twitter: "Twitterbot/1.0",
  line: "Mozilla/5.0 (compatible; LineBot/1.0; +https://line.me)",
  generic: "curl/8.4.0",
};

const meta = (html, key) => {
  const re = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`, "i");
  return re.exec(html)?.[1] ?? null;
};

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), "duigao-preview-"));
  await new Promise((r) => mock.listen(MOCK_PORT, r));
  await new Promise((r) => appOrigin.listen(APP_ORIGIN_PORT, r));
  const handler = await loadHandler(tmp);

  const livePreview = randomUUID();
  const offPreview = randomUUID();
  const revokedPreview = randomUUID();
  const injectedPreview = randomUUID();
  const unknownPreview = randomUUID();
  const videoPreview = randomUUID();
  const videoOffPreview = randomUUID();
  const videoRevokedPreview = randomUUID();

  previews.set(livePreview, {
    title: "期初演講討論",
    description: "幫我看一下這張文宣，點需要調整的位置留一句話就可以，不用改原稿。",
    thumbnail_path: `${livePreview}/cover.webp`,
    show_thumbnail: true,
    enabled: true,
    updated_at: "2026-08-20T00:00:00.000Z",
    room_id: ROOM_ID,
  });
  previews.set(offPreview, { ...previews.get(livePreview), show_thumbnail: false, title: "關掉縮圖的文宣" });
  previews.set(revokedPreview, { ...previews.get(livePreview), enabled: false, title: "已撤銷的文宣" });
  previews.set(injectedPreview, {
    ...previews.get(livePreview),
    title: `"><script>alert('xss')</script>`,
    description: `<img src=x onerror="alert('xss')">`,
  });

  // A production video room: poster frame in the bucket, a title the host typed
  // themselves, and the time-based invitation.
  previews.set(videoPreview, {
    title: "小華招生短片｜第一剪",
    description: "幫我看一下這支影片，在需要調整的時間點留一句話就可以。",
    thumbnail_path: `${videoPreview}/cover.webp`,
    show_thumbnail: true,
    enabled: true,
    media_type: "video",
    updated_at: "2026-08-21T00:00:00.000Z",
    room_id: ROOM_ID,
  });
  previews.set(videoOffPreview, { ...previews.get(videoPreview), show_thumbnail: false });
  previews.set(videoRevokedPreview, { ...previews.get(videoPreview), enabled: false });

  const get = (id, ua = CRAWLERS.generic, method = "GET") =>
    handler(
      new Request(`https://project.supabase.co/share-preview/${id}`, {
        method,
        headers: { "user-agent": ua },
      }),
    );

  // ------------------------------------------------------------- crawlers
  section("爬蟲：不執行 JavaScript 也拿得到 Open Graph");
  for (const [name, ua] of Object.entries(CRAWLERS)) {
    const res = await get(livePreview, ua);
    const html = await res.text();
    ok(`${name}: 200 + text/html`, res.status === 200 && /text\/html/.test(res.headers.get("content-type") ?? ""));
    ok(`${name}: og:title 是房間標題`, meta(html, "og:title") === "期初演講討論", meta(html, "og:title"));
    ok(`${name}: og:description 有值`, (meta(html, "og:description") ?? "").length > 8);
    ok(
      `${name}: og:image 指向 share-previews bucket`,
      (meta(html, "og:image") ?? "").includes(`/storage/v1/object/public/share-previews/${livePreview}/cover.webp`),
      meta(html, "og:image"),
    );
    ok(`${name}: og:type=website`, meta(html, "og:type") === "website");
    ok(`${name}: og:url 沒有 fragment`, !(meta(html, "og:url") ?? "").includes("#"));
    ok(
      `${name}: og:url 是可以真的打開的 canonical 連結`,
      (meta(html, "og:url") ?? "").endsWith(`/functions/v1/share-preview/${livePreview}`),
      meta(html, "og:url"),
    );
    ok(`${name}: twitter:card=summary_large_image`, meta(html, "twitter:card") === "summary_large_image");
    ok(`${name}: twitter:title/description/image 齊全`, Boolean(meta(html, "twitter:title") && meta(html, "twitter:description") && meta(html, "twitter:image")));
    const scriptAt = html.indexOf("<script");
    ok(
      `${name}: meta 不靠 JS render`,
      scriptAt === -1 || html.indexOf('property="og:title"') < scriptAt,
      "og meta must be in the served HTML, before any script",
    );
  }

  {
    const res = await get(livePreview, CRAWLERS.facebook, "HEAD");
    ok("HEAD 也回 200 text/html", res.status === 200 && /text\/html/.test(res.headers.get("content-type") ?? ""));
  }

  // -------------------------------------------------------------- security
  section("安全：invite 永遠不會出現在預覽回應裡");
  {
    // The crawler request the function actually receives — note there is no
    // way to even put the fragment on it: browsers do not transmit one.
    const res = await get(livePreview, CRAWLERS.line);
    const html = await res.text();
    ok(`HTML 不包含 ${INVITE_SECRET}`, !html.includes(INVITE_SECRET));
    ok("HTML 不包含 invite / invite_hash 欄位名", !/invite_hash|[?&#]invite=/i.test(html));
    ok("HTML 不包含 room id", !html.includes(ROOM_ID));
    ok("HTML 不包含 room 資料表名", !/\b(comments|messages|visual_proposals|comment_supports|comment_replies)\b/.test(html));
    ok("HTML 不包含 room-assets 私有 bucket", !html.includes("room-assets"));

    // Even if a caller tries to smuggle the secret in, it must not be echoed.
    const smuggled = await handler(
      new Request(`https://project.supabase.co/share-preview/${livePreview}?invite=${INVITE_SECRET}`, {
        headers: { "user-agent": CRAWLERS.facebook, referer: `https://x/#invite=${INVITE_SECRET}` },
      }),
    );
    const smuggledHtml = await smuggled.text();
    ok("夾帶在 query / referer 的 invite 不會被回顯", !smuggledHtml.includes(INVITE_SECRET));
  }

  section("安全：只知道 previewId 讀不到房間");
  {
    rpcLog.length = 0;
    await get(livePreview, CRAWLERS.facebook);
    const nonPreviewCalls = rpcLog.filter((r) => !r.startsWith("POST /rest/v1/rpc/get_share_preview"));
    ok("只呼叫 get_share_preview，沒有碰任何資料表", nonPreviewCalls.length === 0, nonPreviewCalls.join(", "));
    ok("整次請求只有一次後端呼叫", rpcLog.length === 1, String(rpcLog.length));
  }

  section("安全：HTML escape");
  {
    const res = await get(injectedPreview, CRAWLERS.facebook);
    const html = await res.text();
    ok("標題裡的 <script> 被 escape", !html.includes("<script>alert('xss')</script>"));
    ok("標題裡的引號被 escape", html.includes("&quot;&gt;&lt;script&gt;"));
    ok("description 的 onerror 被 escape", !/<img src=x onerror=/.test(html));
  }

  // --------------------------------------------------------- preview 開關
  section("顯示文宣縮圖：關閉後只剩通用封面");
  {
    const res = await get(offPreview, CRAWLERS.line);
    const html = await res.text();
    ok("og:image 指向通用封面", meta(html, "og:image") === `${APP_ORIGIN}/og-cover.png`, meta(html, "og:image"));
    ok("完全沒有文宣縮圖路徑", !html.includes("share-previews/"));
    ok("標題仍然顯示", meta(html, "og:title") === "關掉縮圖的文宣");
  }

  section("撤銷預覽：舊連結只看到品牌卡片");
  {
    const res = await get(revokedPreview, CRAWLERS.facebook);
    const html = await res.text();
    ok("撤銷後 og:title 回到品牌名", meta(html, "og:title") === "文宣討論區");
    ok("撤銷後 og:image 是通用封面", meta(html, "og:image") === `${APP_ORIGIN}/og-cover.png`);
    ok("撤銷後看不到原本的文宣標題", !html.includes("已撤銷的文宣"));
  }

  section("未知 / 損壞的 previewId：仍然回 200 通用卡片");
  {
    for (const [label, id] of [
      ["未建立過的 uuid", unknownPreview],
      ["不是 uuid", "not-a-uuid"],
      ["空的", ""],
    ]) {
      const res = await get(id, CRAWLERS.generic);
      const html = await res.text();
      ok(`${label}: 200 通用卡片`, res.status === 200 && meta(html, "og:title") === "文宣討論區");
    }
  }

  // ------------------------------------------------------------- redirect
  section("真人點擊：fragment 原封不動帶回 App");
  {
    const res = await get(livePreview, "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile");
    const html = await res.text();
    ok("一般瀏覽器會拿到 redirect script", html.includes("location.replace"));
    ok("redirect 目標是 APP_ORIGIN", html.includes(JSON.stringify(APP_ORIGIN)));
    ok("redirect 直接使用 location.hash，不重組", html.includes("location.hash"));
    ok("整份 HTML 完全沒有 invite 這個字（含註解）", !/invite/i.test(html));

    const crawler = await get(livePreview, CRAWLERS.facebook);
    const crawlerHtml = await crawler.text();
    ok("爬蟲不會被 redirect 帶走", !crawlerHtml.includes("location.replace"));
    // A real person wrongly matched as a bot must still get a working button:
    // the server-rendered href cannot carry the fragment on its own.
    ok("即使被判成爬蟲，按鈕仍會補上 fragment", crawlerHtml.includes('open.setAttribute("href", target)'));
    ok("被判成爬蟲時整份 HTML 一樣沒有 invite", !/invite/i.test(crawlerHtml));

    // In-app browsers must not be mistaken for unfurlers.
    for (const [label, ua] of [
      ["WhatsApp（unfurler 與 in-app 瀏覽器同 UA，一律當真人）", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 WhatsApp/2.24.6.78 A"],
      ["Yandex 手機瀏覽器", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 YaBrowser/24.1 YandexSearch/24.1 Mobile Safari/537.36"],
      ["Pinterest App", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Pinterest for iOS/12.5"],
    ]) {
      const res = await get(livePreview, ua);
      const html2 = await res.text();
      ok(`${label} 會被當成真人（會自動導回 App）`, html2.includes("location.replace"));
    }
  }

  // ------------------------------------------------------- 影片／文宣分流
  section("影片房：卡片講的是影片，不是文宣 (PR #30)");
  {
    for (const [name, ua] of Object.entries(CRAWLERS)) {
      const res = await get(videoPreview, ua);
      const html = await res.text();
      ok(`${name}: og:title 是自訂的影片標題`, meta(html, "og:title") === "小華招生短片｜第一剪", meta(html, "og:title"));
      ok(
        `${name}: og:description 是影片文案`,
        (meta(html, "og:description") ?? "").includes("在需要調整的時間點留一句話"),
        meta(html, "og:description"),
      );
      ok(
        `${name}: og:image 是影片 poster 衍生縮圖`,
        (meta(html, "og:image") ?? "").includes(`/storage/v1/object/public/share-previews/${videoPreview}/cover.webp`),
        meta(html, "og:image"),
      );
      ok(`${name}: og:site_name 是「影片對稿」`, meta(html, "og:site_name") === "影片對稿", meta(html, "og:site_name"));
    }

    const html = await (await get(videoPreview, CRAWLERS.line)).text();
    ok("影片卡片完全沒有「這張文宣」", !html.includes("這張文宣"));
    ok("影片卡片完全沒有「文宣討論區」", !html.includes("文宣討論區"));
    ok("影片卡片沒有把原始影片公開", !/\.(mp4|webm|mov|m4v)/i.test(html));
    ok("影片卡片按鈕寫「開啟影片對稿」", html.includes("開啟影片對稿"));
  }

  section("影片房：關閉封面／撤銷後退到「影片對稿」通用卡片");
  {
    const off = await (await get(videoOffPreview, CRAWLERS.facebook)).text();
    ok("關閉封面後 og:image 是影片通用封面", meta(off, "og:image") === `${APP_ORIGIN}/og-video-cover.png`, meta(off, "og:image"));
    ok("關閉封面後不再暴露任何縮圖路徑", !off.includes("share-previews/"));
    ok("關閉封面後標題仍然是影片標題", meta(off, "og:title") === "小華招生短片｜第一剪");

    const revoked = await (await get(videoRevokedPreview, CRAWLERS.facebook)).text();
    ok("撤銷後 og:title 是「影片對稿」而不是「文宣討論區」", meta(revoked, "og:title") === "影片對稿", meta(revoked, "og:title"));
    ok("撤銷後 og:image 是影片通用封面", meta(revoked, "og:image") === `${APP_ORIGIN}/og-video-cover.png`);
    ok("撤銷後看不到原本的影片標題", !revoked.includes("小華招生短片"));
    ok("撤銷後仍然不含 invite", !/invite/i.test(revoked));
  }

  section("圖片房不受影響：仍然是「文宣討論區」");
  {
    const html = await (await get(livePreview, CRAWLERS.facebook)).text();
    ok("圖片卡片沒有「這支影片」", !html.includes("這支影片"));
    ok("圖片卡片 og:site_name 仍是文宣討論區", meta(html, "og:site_name") === "文宣討論區");
    const off = await (await get(offPreview, CRAWLERS.facebook)).text();
    ok("圖片關閉縮圖後用的是文宣通用封面", meta(off, "og:image") === `${APP_ORIGIN}/og-cover.png`);
  }

  section("部署順序：沒有 0011 的專案照樣出得了卡片");
  {
    v3Available = false;
    try {
      rpcLog.length = 0;
      const html = await (await get(livePreview, CRAWLERS.facebook)).text();
      ok("v3 不存在時回退到舊的 get_share_preview", meta(html, "og:title") === "期初演講討論", meta(html, "og:title"));
      ok(
        "回退真的打了兩支 RPC（先 v3 再 v1）",
        rpcLog.filter((r) => r.includes("get_share_preview_v3")).length === 1 &&
          rpcLog.filter((r) => r.endsWith("/get_share_preview")).length === 1,
        rpcLog.join(" | "),
      );
      const videoHtml = await (await get(videoPreview, CRAWLERS.facebook)).text();
      ok(
        "沒有 media_type 可讀時退回圖片預設（而不是壞掉）",
        meta(videoHtml, "og:site_name") === "文宣討論區" && meta(videoHtml, "og:title") === "小華招生短片｜第一剪",
        meta(videoHtml, "og:site_name"),
      );
    } finally {
      v3Available = true;
    }
  }

  section("Edge Function 的文案與 App 的 presentation 是同一份");
  {
    // Duplicated strings are fine; silently DIVERGING strings are not. If the
    // app ever says 「影片對稿」 while the card says something else, the person
    // who clicks the link lands somewhere that does not look like what they
    // were promised.
    const app = await readFile(join(ROOT, "src", "lib", "sharePresentation.ts"), "utf8");
    const fn = await readFile(FN_SOURCE, "utf8");
    const constOf = (src, name) => new RegExp(`${name} = "([^"]*)"`).exec(src)?.[1] ?? null;
    for (const [name, inFn] of [
      ["IMAGE_BRAND", "文宣討論區"],
      ["VIDEO_BRAND", "影片對稿"],
      ["IMAGE_SHARE_DESCRIPTION", "幫我看一下這張文宣，點需要調整的位置留一句話就可以，不用改原稿。"],
      ["VIDEO_SHARE_DESCRIPTION", "幫我看一下這支影片，在需要調整的時間點留一句話就可以。"],
      ["IMAGE_GENERIC_COVER", "og-cover.png"],
      ["VIDEO_GENERIC_COVER", "og-video-cover.png"],
    ]) {
      ok(`${name} 兩邊一致`, constOf(app, name) === inFn && fn.includes(inFn), `${constOf(app, name)} vs ${inFn}`);
    }
  }

  section("通用封面：影片有自己的一張，而且不含任何房間畫面");
  {
    const cover = join(ROOT, "public", "og-video-cover.png");
    const bytes = await readFile(cover);
    ok("public/og-video-cover.png 有 commit", bytes.length > 1000);
    ok("是 PNG", bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    // IHDR width/height live at a fixed offset in every PNG.
    ok("是 1200×630", bytes.readUInt32BE(16) === 1200 && bytes.readUInt32BE(20) === 630, `${bytes.readUInt32BE(16)}×${bytes.readUInt32BE(20)}`);
    const gen = await readFile(join(ROOT, "scripts", "make-og-cover.mjs"), "utf8");
    ok("產生它的 script 也 commit 了（資產可重現）", gen.includes("og-video-cover.png"));
  }

  await browserLeg(livePreview, handler);
  await thumbnailLeg(tmp);

  // ------------------------------------------------------------ migration
  section("Migration：public projection 不外洩房間欄位");
  {
    const sql = await readFile(MIGRATION, "utf8");
    const returns = /returns table \(([\s\S]*?)\)\s*language sql/i.exec(sql)?.[1] ?? "";
    ok("get_share_preview 有定義", returns.length > 0);
    for (const forbidden of ["room_id", "version_id", "created_by", "invite"]) {
      ok(`回傳欄位不含 ${forbidden}`, !new RegExp(`\\b${forbidden}\\b`).test(returns));
    }
    ok("只 grant execute 給 anon / authenticated", /grant execute on function public\.get_share_preview\(uuid\) to anon, authenticated;/.test(sql));
    ok("share_previews 有 RLS", /alter table public\.share_previews enable row level security/.test(sql));
    ok("share_previews 寫入要 is_room_member", /share_previews_all[\s\S]*?is_room_member\(room_id\)/.test(sql));
    ok("沒有把 room-assets 改成 public", !/room-assets[^\n]*public\s*=\s*true/.test(sql) && !/'room-assets',\s*true/.test(sql));
    ok("share-previews bucket 與 room-assets 分離", /insert into storage\.buckets[\s\S]*?'share-previews'/.test(sql));
  }

  section("Migration 0011：media-aware projection 一樣不外洩房間欄位");
  {
    const sql = await readFile(MIGRATION_0011, "utf8");
    const returns = /returns table \(([\s\S]*?)\)\s*language sql/i.exec(sql)?.[1] ?? "";
    ok("get_share_preview_v3 有定義", returns.length > 0);
    ok("回傳 media_type", /\bmedia_type\b/.test(returns));
    for (const forbidden of ["room_id", "version_id", "created_by", "invite"]) {
      ok(`v3 回傳欄位不含 ${forbidden}`, !new RegExp(`\\b${forbidden}\\b`).test(returns));
    }
    ok(
      "只 grant execute 給 anon / authenticated",
      /grant execute on function public\.get_share_preview_v3\(uuid\) to anon, authenticated;/.test(sql),
    );
    ok(
      "先明確 revoke 再 grant（跟 0010 同一套 ACL 收斂）",
      /revoke execute on function public\.get_share_preview_v3\(uuid\) from public, anon, authenticated;/.test(sql),
    );
    ok("沒有改掉舊的 get_share_preview / _v2 型別", !/create or replace function public\.get_share_preview\(/.test(sql) && !/create or replace function public\.get_share_preview_v2\(/.test(sql));
    ok("cover_source 只允許 auto/custom/none", /cover_source in \('auto', 'custom', 'none'\)/.test(sql));
    ok("media_type 只允許 image/video", /media_type in \('image', 'video'\)/.test(sql));
    ok(
      "沒有把 room-assets 改成 public",
      !/room-assets[^\n]*public\s*=\s*true/.test(sql) && !/'room-assets',\s*true/.test(sql),
    );
    ok("沒有新增任何 storage bucket", !/insert into storage\.buckets/.test(sql));
    ok("欄位新增是 if not exists（可重複套用）", /add column if not exists media_type/.test(sql));
  }

  section("PWA：service worker 不攔截跨網域的預覽端點");
  {
    const sw = await readFile(join(ROOT, "public", "sw.js"), "utf8");
    ok("sw 對非同源請求直接放行", /url\.origin !== self\.location\.origin\)\s*return;/.test(sw));
  }

  await rm(tmp, { recursive: true, force: true });
  mock.close();
  appOrigin.close();

  console.log(`\n${checks - failures}/${checks} 通過`);
  if (failures) {
    console.error(`${failures} 項失敗`);
    process.exit(1);
  }
}

/** Drive the real redirect in a real browser, if Playwright is around. */
async function browserLeg(previewId, handler) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    section("真人點擊（瀏覽器）");
    console.log("  – 略過：未安裝 playwright（npm i -D playwright && npx playwright install chromium）");
    return;
  }

  const fnServer = http.createServer(async (req, res) => {
    const request = new Request(`http://127.0.0.1:${FN_PORT}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
    });
    const out = await handler(request);
    const body = await out.text();
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    res.end(body);
  });
  await new Promise((r) => fnServer.listen(FN_PORT, r));

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const seen = [];
    page.on("request", (r) => {
      if (r.isNavigationRequest()) seen.push(r.url());
    });

    const fragment = `#room=${ROOM_ID}&invite=${INVITE_SECRET}`;
    await page.goto(`http://127.0.0.1:${FN_PORT}/share-preview/${previewId}${fragment}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL((u) => u.origin === APP_ORIGIN, { timeout: 10000 }).catch(() => undefined);
    const final = page.url();

    section("真人點擊（瀏覽器）");
    ok("最後停在 App origin", final.startsWith(`${APP_ORIGIN}/`), final);
    ok("fragment 一字不差", final.endsWith(fragment), final);
    ok("沒有重複的 #", (final.match(/#/g) ?? []).length === 1, final);
    ok("room 沒有掉", final.includes(`room=${ROOM_ID}`));
    ok("invite 沒有掉", final.includes(`invite=${INVITE_SECRET}`));
    ok(
      "invite 從未離開瀏覽器（沒有任何 request URL 帶到它）",
      seen.every((u) => !u.split("#")[0].includes(INVITE_SECRET)),
      seen.join(" | "),
    );
    ok(
      "preview server 只收到 /share-preview/<id>",
      lastLanding !== null && !String(lastLanding).includes(INVITE_SECRET),
      String(lastLanding),
    );
  } finally {
    await browser.close();
    fnServer.close();
  }
}

/**
 * 直式 / 橫式 文宣: the card must CONTAIN the poster, never cover-crop it.
 *
 * Each fixture carries a distinctly coloured pixel in all four corners. A
 * cover-crop of a portrait poster eats the top and bottom — i.e. the title and
 * the date / QR — so "all four corner colours survive" is a precise test for
 * the thing that would actually go wrong. The measured rectangle then proves
 * the scale was uniform (no stretching).
 */
async function thumbnailLeg(tmp) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    section("縮圖幾何（瀏覽器）");
    console.log("  – 略過：未安裝 playwright");
    return;
  }

  const source = await readFile(THUMB_SOURCE, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "shareThumbnail.ts",
  }).outputText;
  const modulePath = join(tmp, "shareThumbnail.mjs");
  await writeFile(modulePath, js, "utf8");

  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("    browser:", m.text());
  });
  await page.goto("about:blank");
  // The module is ESM, so the page imports it from a data: URL.
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`;

  const CORNERS = { tl: [255, 0, 0], tr: [0, 255, 0], bl: [0, 0, 255], br: [255, 255, 0] };

  const run = async (label, w, h) => {
    const result = await page.evaluate(
      async ({ moduleUrl, w, h, CORNERS }) => {
        const mod = await import(moduleUrl);
        // Build the fixture poster in-page so nothing is re-encoded on the way in.
        const src = document.createElement("canvas");
        src.width = w;
        src.height = h;
        const sctx = src.getContext("2d");
        sctx.fillStyle = "#8a8a8a";
        sctx.fillRect(0, 0, w, h);
        const marks = [
          [CORNERS.tl, 0, 0],
          [CORNERS.tr, w - 6, 0],
          [CORNERS.bl, 0, h - 6],
          [CORNERS.br, w - 6, h - 6],
        ];
        for (const [[r, g, b], x, y] of marks) {
          sctx.fillStyle = `rgb(${r},${g},${b})`;
          sctx.fillRect(x, y, 6, 6);
        }
        const dataUrl = src.toDataURL("image/png");

        const { blob, mime } = await mod.renderShareThumbnail(dataUrl);
        const bmp = await createImageBitmap(blob);
        const out = document.createElement("canvas");
        out.width = bmp.width;
        out.height = bmp.height;
        out.getContext("2d").drawImage(bmp, 0, 0);
        const data = out.getContext("2d").getImageData(0, 0, out.width, out.height).data;

        // Find each marker: nearest pixel to the pure colour wins.
        const found = {};
        for (const [name, [r, g, b]] of Object.entries(CORNERS)) {
          let best = { d: Infinity, x: -1, y: -1 };
          for (let y = 0; y < out.height; y += 1) {
            for (let x = 0; x < out.width; x += 1) {
              const i = (y * out.width + x) * 4;
              const d = (data[i] - r) ** 2 + (data[i + 1] - g) ** 2 + (data[i + 2] - b) ** 2;
              if (d < best.d) best = { d, x, y };
            }
          }
          found[name] = best;
        }
        return {
          size: blob.size,
          mime,
          width: out.width,
          height: out.height,
          found,
          expected: mod.containRect(w, h),
        };
      },
      { moduleUrl, w, h, CORNERS },
    );

    section(`縮圖幾何（瀏覽器）：${label} ${w}×${h}`);
    ok("輸出就是 1200×630", result.width === 1200 && result.height === 630, `${result.width}×${result.height}`);
    ok("編碼成 WebP 或 JPEG", ["image/webp", "image/jpeg"].includes(result.mime), result.mime);
    ok("檔案小於 1MB", result.size < 1024 * 1024, `${Math.round(result.size / 1024)}KB`);

    // Lossy encoding shifts colours a little; 60 per channel is a wide margin
    // that still separates the four markers from each other and the backdrop.
    const TOL = 60 * 60 * 3;
    for (const name of Object.keys(CORNERS)) {
      ok(`${name} 角落沒有被裁掉`, result.found[name].d < TOL, `distance ${Math.round(Math.sqrt(result.found[name].d))}`);
    }

    const { tl, tr, bl } = result.found;
    const drawnW = tr.x - tl.x;
    const drawnH = bl.y - tl.y;
    const expected = result.expected;
    ok(
      "沒有被拉伸（比例與原圖一致）",
      Math.abs(drawnW / drawnH - (expected.w - 6) / (expected.h - 6)) < 0.06,
      `drawn ${drawnW}×${drawnH}, expected ~${expected.w}×${expected.h}`,
    );
    ok("整張文宣都在畫布內", tl.x >= 0 && tl.y >= 0 && tr.x <= 1200 && bl.y <= 630);
    ok("有留白（letterbox，不是滿版裁切）", tl.x >= 0 && tl.y >= 0 && (tl.x > 0 || tl.y > 0));
  };

  try {
    await run("直式海報", 800, 1200);
    await run("橫式海報", 1600, 900);
    await run("正方形", 1000, 1000);
  } finally {
    await browser.close();
  }
}

await main();
