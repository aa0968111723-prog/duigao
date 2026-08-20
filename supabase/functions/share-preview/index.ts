/**
 * 文宣討論區 — share preview landing page (PR #21)
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
/** Where a real person is sent, fragment intact. Set as a function secret. */
const APP_ORIGIN = (Deno.env.get("APP_ORIGIN") ?? "").replace(/\/+$/, "");

const BRAND = "文宣討論區";
const DEFAULT_DESCRIPTION = "幫我看一下這張文宣，點需要調整的位置留一句話就可以，不用改原稿。";
const GENERIC_COVER = `${APP_ORIGIN}/og-cover.png`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!APP_ORIGIN) {
  // Without it there is nowhere to send a real person and the generic card has
  // no absolute image URL. Fail loudly in the logs rather than silently badly.
  console.error("[share-preview] APP_ORIGIN is not set: set it as a function secret before deploying.");
}

/**
 * Crawlers do not run JavaScript, so the redirect below is a no-op for them.
 * This list only exists so the rare unfurler that *does* render a page reads
 * this card instead of chasing the redirect into the SPA.
 */
const CRAWLER_UA =
  /facebookexternalhit|facebookcatalog|meta-externalagent|twitterbot|linebot|line-podcast|slackbot|discordbot|telegrambot|whatsapp|skypeuripreview|pinterest|redditbot|embedly|quora link preview|bitlybot|nuzzel|vkshare|w3c_validator|google-inspectiontool|bingbot|googlebot|applebot|yandex|developers\.google\.com\/\+\/web\/snippet/i;

type Preview = {
  title: string;
  description: string;
  image_path: string | null;
  updated_at: string;
};

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

async function loadPreview(previewId: string): Promise<Preview | null> {
  if (!SUPABASE_URL || !ANON_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_share_preview`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: ANON_KEY,
        authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ p_preview_id: previewId }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Preview[] | null;
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
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
}): string {
  const title = escapeHtml(opts.title);
  const description = escapeHtml(opts.description);
  const image = escapeHtml(opts.image);
  const pageUrl = escapeHtml(opts.pageUrl);
  const appOrigin = escapeHtml(APP_ORIGIN || "/");
  // JSON-encoded so the origin can never break out of the string literal.
  const originLiteral = JSON.stringify(APP_ORIGIN);

  // The emitted script is deliberately comment-free: the served HTML must not
  // contain the substring "invite" anywhere, in any form, so that "no secret
  // ever reaches this page" is checkable by grep as well as by argument. The
  // reasoning lives here instead — `location.hash` is handed over byte for
  // byte, with no parsing, re-encoding or rebuilding.
  const redirectScript = opts.redirect
    ? `<script>(function(){
  var origin = ${originLiteral};
  if (!origin) return;
  var target = origin + "/" + (location.hash || "");
  var open = document.getElementById("open");
  if (open) open.setAttribute("href", target);
  location.replace(target);
})();</script>`
    : "";

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escapeHtml(BRAND)}">
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
<a id="open" href="${appOrigin}">開啟文宣討論區</a>
</div>
${redirectScript}
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

  // Unknown, revoked, or thumbnail-off previews all land on the generic card.
  // The redirect below still works, so a stale link keeps opening the room.
  const title = clamp(preview?.title?.trim() || BRAND, 70);
  const description = clamp(preview?.description?.trim() || DEFAULT_DESCRIPTION, 160);
  const image = preview?.image_path
    ? publicImageUrl(preview.image_path, String(Date.parse(preview.updated_at) || 0))
    : GENERIC_COVER;

  const ua = req.headers.get("user-agent") ?? "";
  const html = renderHtml({
    title,
    description,
    image,
    pageUrl: canonicalUrl(previewId, `${url.origin}${url.pathname}`),
    redirect: !CRAWLER_UA.test(ua),
  });

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    // Deliberately short. Turning 顯示文宣縮圖 off deletes the thumbnail
    // immediately, so the real protection is the missing object — but the card
    // itself should stop advertising it quickly too, and an unfurl burst is
    // still absorbed.
    "cache-control": "public, max-age=60",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  });

  return new Response(req.method === "HEAD" ? null : html, { status: 200, headers });
});
