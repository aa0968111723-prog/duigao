/**
 * 對稿 — share preview landing page (PR #21, media-aware since #30)
 *
 * WHY THIS EXISTS AT ALL
 * A permanent share link keeps its secret in the URL fragment:
 *   https://<app>/#room=<uuid>&invite=<token>
 * Browsers never send a fragment to any server, which is exactly what makes
 * that link safe (PR #12/#16). It is also why LINE / Facebook / Messenger show
 * a bare URL instead of a card: their crawlers do not execute SPA JavaScript,
 * so the app's runtime <meta> edits are invisible to them.
 *
 * So the shared URL becomes:
 *   https://<project>.supabase.co/functions/v1/share-preview/<previewId>#room=…&invite=…
 *
 * The crawler's HTTP request carries ONLY `/share-preview/<previewId>`. The
 * fragment stays in the reader's browser. This function therefore renders a
 * card from a public, room-free projection (`get_share_preview`) and hands the
 * fragment straight back to the app with a two-line client-side redirect.
 *
 * INVARIANTS
 *   1. This function never sees, stores, logs or emits an invite token — it is
 *      structurally incapable of doing so, because the token never arrives.
 *   2. previewId is an independent random UUID. `get_share_preview` returns no
 *      room_id, so a preview id cannot be walked back to a room, and this
 *      endpoint is never an authentication shortcut.
 *   3. It reads with the ANON key through one narrow RPC. No service role, no
 *      table access, no writes.
 *   4. If the lookup fails for any reason, the page still redirects a human
 *      with the fragment intact — a broken preview degrades to a plain
 *      redirector, never to a broken share link.
 *
 * Deploy with JWT verification OFF (crawlers send no Authorization header):
 *   supabase functions deploy share-preview --no-verify-jwt
 * (`supabase/config.toml` sets `verify_jwt = false` for local + CLI deploys.)
 */

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
/**
 * Where a real person is sent, fragment intact. The production origin is a
 * public URL (it is in every share link), not a secret — so it lives here as
 * the default and the APP_ORIGIN env var stays as the override for previews
 * and future domain moves.
 */
const PRODUCTION_APP_ORIGIN = "https://duigao-k7q2.zeabur.app";
const APP_ORIGIN = ((Deno.env.get("APP_ORIGIN") ?? "").trim() || PRODUCTION_APP_ORIGIN).replace(/\/+$/, "");

/**
 * Media-aware fallbacks (PR #30).
 *
 * A card with no room-specific content still has to say what it is. Before
 * this, every fallback said 文宣討論區 — so a revoked or cover-less VIDEO card
 * advertised itself as a poster review. The function still knows nothing about
 * the room: `media_type` is the single extra field the public projection
 * returns, and it carries no room, version or invite identity with it.
 *
 * These strings are the server-side half of `src/lib/sharePresentation.ts`;
 * they are duplicated rather than imported because an Edge Function cannot
 * reach into the app bundle, and they are asserted equal in
 * scripts/e2e/share-preview.mjs so they cannot drift apart silently.
 */
type MediaType = "image" | "video";

const COPY: Record<MediaType, { brand: string; description: string; cover: string; open: string }> = {
  image: {
    brand: "文宣討論區",
    description: "幫我看一下這張文宣，點需要調整的位置留一句話就可以，不用改原稿。",
    cover: `${APP_ORIGIN}/og-cover.png`,
    open: "開啟文宣討論區",
  },
  video: {
    brand: "影片對稿",
    description: "幫我看一下這支影片，在需要調整的時間點留一句話就可以。",
    cover: `${APP_ORIGIN}/og-video-cover.png`,
    open: "開啟影片對稿",
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!APP_ORIGIN) {
  // Without it there is nowhere to send a real person and the generic card has
  // no absolute image URL. Fail loudly in the logs rather than silently badly.
  console.error("[share-preview] APP_ORIGIN is not set: set it as a function secret before deploying.");
}

/**
 * Crawlers do not run JavaScript, so the auto-redirect is already a no-op for
 * them. This list only exists so the rare unfurler that *does* render a page
 * reads this card instead of chasing the redirect into the SPA.
 *
 * Only unambiguous bot tokens belong here. WhatsApp's unfurler and its in-app
 * browser both send `WhatsApp/2.x`, so it is left out entirely: a bot ignores
 * the redirect anyway (the meta tags are already in <head>, ahead of any
 * script), while a person gets the seamless jump. Same reasoning for the
 * Pinterest and Yandex apps — only their `…bot` forms are listed.
 *
 * Even so, a person wrongly matched here must still be able to get through,
 * which is why the link-fixing half of the script below runs for everyone.
 */
const CRAWLER_UA =
  /facebookexternalhit|facebookcatalog|meta-externalagent|twitterbot|linebot|line-podcast|slackbot|discordbot|telegrambot|skypeuripreview|pinterestbot|redditbot|embedly|quora link preview|bitlybot|nuzzel|vkshare|w3c_validator|google-inspectiontool|bingbot|googlebot|applebot|yandexbot|yandeximages|developers\.google\.com\/\+\/web\/snippet/i;

type Preview = {
  title: string | null;
  description: string | null;
  image_path: string | null;
  /** Present from get_share_preview_v3 onwards; absent on the older RPCs. */
  media_type?: string | null;
  updated_at: string;
};

function mediaTypeOf(preview: Preview | null): MediaType {
  return preview?.media_type === "video" ? "video" : "image";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Keep card text to one readable line rather than dumping a whole title. */
function clamp(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function previewIdFrom(url: URL): string | null {
  // Supabase routes `/functions/v1/share-preview/<id>`; the runtime may present
  // it with or without the `/functions/v1` prefix depending on invocation.
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  return UUID_RE.test(last) ? last : null;
}

/**
 * The canonical URL of this card. Built from SUPABASE_URL rather than from the
 * incoming request: the hosted runtime may present the path with or without the
 * `/functions/v1` prefix, and og:url has to be a link that actually resolves.
 */
function canonicalUrl(previewId: string | null, fallback: string): string {
  if (!previewId || !SUPABASE_URL) return fallback;
  return `${SUPABASE_URL}/functions/v1/share-preview/${previewId}`;
}

/** The public thumbnail lives in the `share-previews` bucket, never room-assets. */
function publicImageUrl(path: string, version: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${SUPABASE_URL}/storage/v1/object/public/share-previews/${encoded}?v=${encodeURIComponent(version)}`;
}

async function callRpc(fn: string, previewId: string): Promise<Preview[] | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: ANON_KEY,
      authorization: `Bearer ${ANON_KEY}`,
    },
    body: JSON.stringify({ p_preview_id: previewId }),
    signal: AbortSignal.timeout(4000),
  });
  // 404 is the one status worth telling apart: it means this project has not
  // run 0011 yet, which is a deploy-order fact, not a broken preview.
  if (res.status === 404) return null;
  if (!res.ok) return [];
  const rows = (await res.json()) as Preview[] | null;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Read the public card projection.
 *
 * Deliberately forward- AND backward-compatible: the function may be deployed
 * before migration 0011 lands (or rolled back after it), so a missing
 * `get_share_preview_v3` falls through to the original RPC instead of turning
 * every card into a redirector. The older RPC returns no media_type, which is
 * exactly the 圖片 default.
 */
async function loadPreview(previewId: string): Promise<Preview | null> {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  try {
    let rows = await callRpc("get_share_preview_v3", previewId);
    if (rows === null) rows = (await callRpc("get_share_preview", previewId)) ?? [];
    return rows.length > 0 ? rows[0] : null;
  } catch {
    // A preview is an enhancement. Losing it must never lose the redirect.
    return null;
  }
}

function renderHtml(opts: {
  title: string;
  description: string;
  image: string;
  pageUrl: string;
  redirect: boolean;
  media: MediaType;
}): string {
  const copy = COPY[opts.media];
  const title = escapeHtml(opts.title);
  const description = escapeHtml(opts.description);
  const image = escapeHtml(opts.image);
  const pageUrl = escapeHtml(opts.pageUrl);
  const appOrigin = escapeHtml(APP_ORIGIN || "/");
  // JSON-encoded so the origin can never break out of the string literal.
  const originLiteral = JSON.stringify(APP_ORIGIN);

  // Two halves, deliberately separated:
  //
  //   * fixing the button's href runs for EVERY user agent. The server-rendered
  //     anchor cannot carry the fragment (the server never sees one), so if a
  //     real person is misclassified as a crawler, this is the only thing that
  //     keeps their room+secret reachable at all.
  //   * the automatic jump is what the crawler list suppresses.
  //
  // The script is comment-free on purpose: the served HTML must not contain the
  // substring "invite" anywhere, in any form, so that "no secret ever reaches
  // this page" is checkable by grep as well as by argument. The reasoning lives
  // here instead — `location.hash` is handed over byte for byte, with no
  // parsing, re-encoding or rebuilding.
  const script = `<script>(function(){
  var origin = ${originLiteral};
  if (!origin) return;
  var target = origin + "/" + (location.hash || "");
  var open = document.getElementById("open");
  if (open) open.setAttribute("href", target);
${opts.redirect ? "  location.replace(target);\n" : ""}})();</script>`;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(copy.brand)}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${title}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:locale" content="zh_TW">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${image}">
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    padding: 24px; background: #141210; color: #efe7dd;
    font: 16px/1.6 "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
  }
  .card { max-width: 420px; text-align: center; }
  .card img { width: 100%; height: auto; border-radius: 14px; display: block; margin: 0 0 18px; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 20px; color: rgba(239, 231, 221, 0.72); font-size: 14px; }
  a {
    display: inline-block; min-height: 46px; padding: 12px 22px; border-radius: 12px;
    background: #c45c4a; color: #fff; text-decoration: none; font-weight: 600;
  }
</style>
</head>
<body>
<div class="card">
<img src="${image}" alt="${title}" width="1200" height="630">
<h1>${title}</h1>
<p>${description}</p>
<a id="open" href="${appOrigin}">${escapeHtml(copy.open)}</a>
</div>
${script}
</body>
</html>
`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET,HEAD,OPTIONS",
      },
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD, OPTIONS" } });
  }

  const url = new URL(req.url);
  const previewId = previewIdFrom(url);
  const preview = previewId ? await loadPreview(previewId) : null;

  // Unknown, revoked, or cover-less previews all land on the generic card — but
  // on the RIGHT generic card. A revoked video preview still reports its
  // media_type (and nothing else), so it says 影片對稿 rather than pretending to
  // be a poster. The redirect below works in every one of those cases, so a
  // stale link keeps opening the room.
  const media = mediaTypeOf(preview);
  const copy = COPY[media];
  const title = clamp(preview?.title?.trim() || copy.brand, 70);
  const description = clamp(preview?.description?.trim() || copy.description, 160);
  const image = preview?.image_path
    ? publicImageUrl(preview.image_path, String(Date.parse(preview.updated_at) || 0))
    : copy.cover;

  const ua = req.headers.get("user-agent") ?? "";
  const isCrawler = CRAWLER_UA.test(ua);

  // Supabase 在 *.supabase.co 網域把 edge function 的 HTML 回應強制改成
  // text/plain＋sandbox CSP（反釣魚）：真人點開只會看到原始碼，頁內的
  // JS 轉跳也被 sandbox 封死（2026-08-28 正式站實測）。所以真人直接吃
  // 302 — Location 不帶 fragment，瀏覽器會把原網址的 #room=…&invite=…
  // 原封接回去，secret 一樣從不經過伺服器。HTML 卡片只留給 OG 爬蟲：
  // 它們不執行 JS、也不在乎 content-type，unfurl 照常。
  if (!isCrawler && APP_ORIGIN) {
    return new Response(null, {
      status: 302,
      headers: new Headers({
        location: `${APP_ORIGIN}/`,
        "cache-control": "public, max-age=60",
        "referrer-policy": "no-referrer",
        "access-control-allow-origin": "*",
      }),
    });
  }

  const html = renderHtml({
    title,
    description,
    image,
    media,
    pageUrl: canonicalUrl(previewId, `${url.origin}${url.pathname}`),
    redirect: !isCrawler,
  });

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    // Deliberately short. Turning 顯示文宣縮圖 / 顯示影片封面 off deletes the
    // thumbnail immediately, so the real protection is the missing object — but
    // the card itself should stop advertising it quickly too, and an unfurl
    // burst is still absorbed. It is also what lets a freshly customised title
    // reach LINE without waiting out a long cache.
    "cache-control": "public, max-age=60",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  });

  return new Response(req.method === "HEAD" ? null : html, { status: 200, headers });
});
