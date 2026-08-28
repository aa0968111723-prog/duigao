/**
 * canva-bridge — Canva 文宣匯入的 OAuth＋匯出橋（PR-05 第一階段）。
 *
 * 為什麼是 edge function：Canva Connect 的 client secret 與使用者
 * access/refresh token 永遠不進瀏覽器。token 存 canva_connections
 * （service role 專用、零 policy、grant 全收 — 0020），client 只拿得到
 * 「連了沒」的布林與匯入結果。
 *
 * 第一階段動作（刻意最小，與 cutos-bridge 同紀律）：
 *  - health：env 齊備才 ok — client 以此決定入口存不存在。
 *  - status / connect-url / disconnect：OAuth 連結生命週期。
 *    connect-url 走 authorization code + PKCE（S256）；state＋verifier
 *    存 canva_oauth_states，callback 一次性消費。
 *  - list-designs：呼叫者自己的 Canva 設計清單（誠實子集：id / 標題 /
 *    縮圖 / 更新時間），給匯入 picker 用。
 *  - import-design：對指定設計開 PNG export job → 有界輪詢 → 下載
 *    （串流計量，上限 25MB）→ 以呼叫者 JWT 寫成房間新圖片版本
 *    （RLS 全程是唯一權威）。
 *
 * 安全邊界：
 *  - callback 是瀏覽器 redirect（無 JWT）→ verify_jwt=false，其餘動作
 *    在函式內自驗 JWT（與 share-preview 同模式）。
 *  - 上游錯誤永不轉述原文；回應永不含 token、client id/secret。
 *  - fetch 一律 redirect:"manual"＋timeout（Grok 07 F1 同理：302 出去
 *    可能把憑證帶到任意 Location）。例外：匯出檔下載 follow redirect —
 *    Canva 的 export url 是裸簽名 URL，request 不帶任何憑證頭。
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const EXPORT_POLL_MS = 1000;
const EXPORT_POLL_LIMIT = 30; // 30 秒內沒完成就誠實說「還在轉檔」
const STATE_TTL_MINUTES = 15;
const TOKEN_REFRESH_SKEW_SECONDS = 60;
const OAUTH_SCOPES = "design:meta:read design:content:read";

function apiBase(): string {
  return (Deno.env.get("CANVA_API_BASE") ?? "https://api.canva.com").replace(/\/+$/, "");
}
function oauthBase(): string {
  return (Deno.env.get("CANVA_OAUTH_BASE") ?? "https://www.canva.com").replace(/\/+$/, "");
}

function responseHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders() });
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** Canva design id：字母數字/底線/連字號，防 path traversal 進上游 URL。 */
const isSafeDesignId = (value: string): boolean => /^[A-Za-z0-9_-]{1,80}$/.test(value);

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type CanvaEnv = { clientId: string; clientSecret: string };

function canvaEnv(): CanvaEnv | null {
  const clientId = (Deno.env.get("CANVA_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("CANVA_CLIENT_SECRET") ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** token 讀寫走 service role：canva_connections 對 client 是不存在的表。 */
function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function callbackUrl(): string {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  return `${url}/functions/v1/canva-bridge/callback`;
}

type TokenSet = { accessToken: string; refreshToken: string; expiresAt: string };

async function exchangeToken(
  env: CanvaEnv,
  form: Record<string, string>,
): Promise<TokenSet | { failure: "rejected" | "unreachable" }> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/rest/v1/oauth/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
  } catch {
    return { failure: "unreachable" };
  }
  // 4xx＝授權端明確拒絕（invalid_grant 等）；其他非 2xx（5xx、redirect）
  // 是暫時性 — 兩者的後果天差地遠（Grok 05 F3），呼叫端必須分得出來。
  if (!res.ok) return { failure: res.status >= 400 && res.status < 500 ? "rejected" : "unreachable" };
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const accessToken = text(data?.access_token);
  const refreshToken = text(data?.refresh_token);
  const expiresIn = Number(data?.expires_in ?? 0);
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { failure: "rejected" };
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

const isTokenSet = (value: TokenSet | { failure: string }): value is TokenSet =>
  !("failure" in value);

/**
 * 取可用 access token：快過期（60 秒 skew）就 refresh 並落盤新的一組
 * （Canva 的 refresh token 會輪替 — 舊的用一次就失效，不落盤等於斷線）。
 * refresh 失敗＝連結已死：刪列，讓 status 誠實回未連結。
 */
async function getAccessToken(
  env: CanvaEnv,
  service: NonNullable<ReturnType<typeof serviceClient>>,
  userId: string,
): Promise<string | null> {
  const { data: row } = await service
    .from("canva_connections")
    .select("access_token,refresh_token,token_expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return null;
  const expiresAt = Date.parse(text(row.token_expires_at));
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_SKEW_SECONDS * 1000) {
    return text(row.access_token) || null;
  }
  const usedRefreshToken = text(row.refresh_token);
  const refreshed = await exchangeToken(env, {
    grant_type: "refresh_token",
    refresh_token: usedRefreshToken,
  });
  if (!isTokenSet(refreshed)) {
    // 暫時性失敗（網路、5xx）不等於連結已死：這次回未連結，列留著，
    // 下次再試（Grok 05 F3 — 原本任何失敗都刪列，會把好連結誤殺）。
    if (refreshed.failure === "unreachable") return null;
    // 明確拒絕：可能真的失效，也可能是並發 refresh 的輸家（Canva 會
    // 輪替 RT — 贏家已寫入新的一顆）。重讀一次分辨：RT 變了就用新的
    // 再試一回，沒變才刪列。
    const { data: latest } = await service
      .from("canva_connections")
      .select("access_token,refresh_token,token_expires_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (latest && text(latest.refresh_token) !== usedRefreshToken) {
      const retryExpires = Date.parse(text(latest.token_expires_at));
      if (Number.isFinite(retryExpires) && retryExpires - Date.now() > TOKEN_REFRESH_SKEW_SECONDS * 1000) {
        return text(latest.access_token) || null;
      }
      const retry = await exchangeToken(env, {
        grant_type: "refresh_token",
        refresh_token: text(latest.refresh_token),
      });
      if (isTokenSet(retry)) {
        await service
          .from("canva_connections")
          .update({
            access_token: retry.accessToken,
            refresh_token: retry.refreshToken,
            token_expires_at: retry.expiresAt,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);
        return retry.accessToken;
      }
      return null;
    }
    await service.from("canva_connections").delete().eq("user_id", userId);
    return null;
  }
  await service
    .from("canva_connections")
    .update({
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      token_expires_at: refreshed.expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  return refreshed.accessToken;
}

async function canvaGet(accessToken: string, path: string): Promise<Response | null> {
  try {
    return await fetch(`${apiBase()}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
  } catch {
    return null;
  }
}

/** OAuth callback：state 一次性消費 → code+PKCE 換 token → 落盤 → 極簡回報頁。 */
async function handleCallback(request: Request): Promise<Response> {
  const env = canvaEnv();
  const service = serviceClient();
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const fail = (message: string) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>Canva 連結</title><body style="font-family:system-ui;padding:2rem;max-width:28rem;margin:auto"><h1 style="font-size:1.1rem">連結沒有完成</h1><p>${message}</p><p>回到 duigao 再按一次「連結 Canva 帳號」。</p></body>`,
      { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  if (!env || !service) return fail("Canva 整合尚未設定。");
  if (!code || !state) return fail("授權回跳缺少必要參數（可能是取消了授權）。");

  const { data: stateRow } = await service
    .from("canva_oauth_states")
    .select("user_id,code_verifier,created_at")
    .eq("state", state)
    .maybeSingle();
  // 先刪再換：同一個 state 只有一次機會，重放拿到的是 404 級失敗。
  await service.from("canva_oauth_states").delete().eq("state", state);
  if (!stateRow) return fail("這個授權連結已使用過或已過期。");
  const createdAt = Date.parse(text(stateRow.created_at));
  if (Number.isFinite(createdAt) && Date.now() - createdAt > STATE_TTL_MINUTES * 60 * 1000) {
    return fail("授權連結已過期（超過 15 分鐘）。");
  }

  const tokens = await exchangeToken(env, {
    grant_type: "authorization_code",
    code,
    code_verifier: text(stateRow.code_verifier),
    redirect_uri: callbackUrl(),
  });
  if (!isTokenSet(tokens)) return fail("和 Canva 交換憑證失敗。");

  const { error: upsertError } = await service.from("canva_connections").upsert(
    {
      user_id: text(stateRow.user_id),
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_expires_at: tokens.expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (upsertError) return fail("儲存連結狀態失敗。");

  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Canva 已連結</title><body style="font-family:system-ui;padding:2rem;max-width:28rem;margin:auto"><h1 style="font-size:1.1rem">Canva 已連結 ✓</h1><p>回到 duigao 的分頁，按「我連好了」繼續匯入。這個分頁可以關掉。</p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function handle(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders() });

  const requestPath = new URL(request.url).pathname;
  if (request.method === "GET" && /\/callback\/?$/.test(requestPath)) {
    return handleCallback(request);
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: responseHeaders() });

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!token || !url || !anonKey) return jsonResponse({ ok: false, code: "UNAUTHENTICATED" }, 401);
  const supabase = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return jsonResponse({ ok: false, code: "UNAUTHENTICATED" }, 401);
  const userId = authData.user.id;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
  }

  const env = canvaEnv();
  const service = serviceClient();
  const action = text(body.action);

  if (action === "health") {
    return jsonResponse(env && service ? { ok: true } : { ok: false, code: "CANVA_NOT_CONFIGURED" });
  }
  if (!env || !service) return jsonResponse({ ok: false, code: "CANVA_NOT_CONFIGURED" });

  if (action === "status") {
    const { data: row } = await service
      .from("canva_connections")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    return jsonResponse({ ok: true, connected: Boolean(row) });
  }

  if (action === "connect-url") {
    // 舊 state 清理：15 分鐘前的都掃掉（機會式，失敗不擋主流程）。
    await service
      .from("canva_oauth_states")
      .delete()
      .lt("created_at", new Date(Date.now() - STATE_TTL_MINUTES * 60 * 1000).toISOString());
    const verifierBytes = new Uint8Array(48);
    crypto.getRandomValues(verifierBytes);
    const codeVerifier = base64url(verifierBytes);
    const challengeBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)),
    );
    const state = crypto.randomUUID();
    const { error: stateError } = await service
      .from("canva_oauth_states")
      .insert({ state, user_id: userId, code_verifier: codeVerifier });
    if (stateError) return jsonResponse({ ok: false, code: "CONNECT_FAILED" });
    const authorize = new URL(`${oauthBase()}/api/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", env.clientId);
    authorize.searchParams.set("scope", OAUTH_SCOPES);
    authorize.searchParams.set("code_challenge", base64url(challengeBytes));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("redirect_uri", callbackUrl());
    return jsonResponse({ ok: true, url: authorize.toString() });
  }

  if (action === "disconnect") {
    await service.from("canva_connections").delete().eq("user_id", userId);
    return jsonResponse({ ok: true });
  }

  if (action === "list-designs") {
    const accessToken = await getAccessToken(env, service, userId);
    if (!accessToken) return jsonResponse({ ok: false, code: "NOT_CONNECTED" });
    const res = await canvaGet(accessToken, "/rest/v1/designs?limit=20&sort_by=modified_descending");
    if (!res) return jsonResponse({ ok: false, code: "CANVA_UNREACHABLE" });
    if (res.status === 401 || res.status === 403) return jsonResponse({ ok: false, code: "NOT_CONNECTED" });
    if (!res.ok) return jsonResponse({ ok: false, code: "CANVA_UNREACHABLE" });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const items = Array.isArray(data?.items) ? (data.items as Record<string, unknown>[]) : [];
    // 誠實子集：client 只需要挑選所需的欄位，其他一概不轉送。
    const designs = items.map((item) => ({
      id: text(item.id),
      title: text(item.title) || "未命名設計",
      thumbnailUrl: text((item.thumbnail as Record<string, unknown> | undefined)?.url),
      updatedAt: Number(item.updated_at ?? 0) || null,
    })).filter((item) => isSafeDesignId(item.id));
    return jsonResponse({ ok: true, designs });
  }

  if (action === "import-design") {
    const roomId = text(body.roomId);
    const designId = text(body.designId);
    const branchId = text(body.branchId);
    const label = text(body.label).slice(0, 80) || "Canva 文宣";
    if (!isUuid(roomId) || !isSafeDesignId(designId) || (branchId && !isUuid(branchId))) {
      return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
    }

    // 前置角色檢查（誠實錯誤碼用；RLS 才是權威 — 版本寫入用呼叫者 JWT，
    // 繞過這裡也繞不過 policy）。
    const { data: roleData } = await supabase.rpc("room_role", { p_room_id: roomId });
    const role = text(roleData);
    if (!role) return jsonResponse({ ok: false, code: "ROOM_NOT_FOUND" }, 404);
    if (role === "reviewer") return jsonResponse({ ok: false, code: "FORBIDDEN" }, 403);
    if (branchId) {
      const { data: branchRow } = await supabase
        .from("room_branches")
        .select("id")
        .eq("id", branchId)
        .eq("room_id", roomId)
        .maybeSingle();
      if (!branchRow) return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
    }

    const accessToken = await getAccessToken(env, service, userId);
    if (!accessToken) return jsonResponse({ ok: false, code: "NOT_CONNECTED" });

    // 開 export job（PNG 第一頁組）→ 有界輪詢。
    let jobRes: Response;
    try {
      jobRes = await fetch(`${apiBase()}/rest/v1/exports`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ design_id: designId, format: { type: "png" } }),
        signal: AbortSignal.timeout(15000),
        redirect: "manual",
      });
    } catch {
      return jsonResponse({ ok: false, code: "CANVA_UNREACHABLE" });
    }
    if (jobRes.status === 401 || jobRes.status === 403) return jsonResponse({ ok: false, code: "NOT_CONNECTED" });
    if (!jobRes.ok) return jsonResponse({ ok: false, code: "EXPORT_FAILED" });
    const jobData = (await jobRes.json().catch(() => null)) as Record<string, unknown> | null;
    let job = (jobData?.job ?? null) as Record<string, unknown> | null;
    const jobId = text(job?.id);
    if (!jobId) return jsonResponse({ ok: false, code: "EXPORT_FAILED" });

    let downloadUrl = "";
    for (let attempt = 0; attempt < EXPORT_POLL_LIMIT; attempt += 1) {
      const status = text(job?.status);
      if (status === "success") {
        const urls = (job?.urls ?? null) as unknown;
        downloadUrl = Array.isArray(urls) ? text(urls[0]) : "";
        break;
      }
      if (status === "failed") return jsonResponse({ ok: false, code: "EXPORT_FAILED" });
      await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS));
      const pollRes = await canvaGet(accessToken, `/rest/v1/exports/${jobId}`);
      if (!pollRes || !pollRes.ok) return jsonResponse({ ok: false, code: "CANVA_UNREACHABLE" });
      const pollData = (await pollRes.json().catch(() => null)) as Record<string, unknown> | null;
      job = (pollData?.job ?? null) as Record<string, unknown> | null;
    }
    if (!downloadUrl) return jsonResponse({ ok: false, code: "EXPORT_PENDING" });
    // SSRF 邊界（Grok 05 F4：光看 scheme 擋不住 https://127.0.0.1）：
    // host 必須是 apiBase 自己（e2e 假上游）或 *.canva.com（真簽名 URL
    // 都在 Canva 網域），其他一律拒絕 — IP literal、localhost、內網名
    // 全都到不了 fetch。
    let downloadHost = "";
    try {
      downloadHost = new URL(downloadUrl).hostname.toLowerCase();
    } catch {
      return jsonResponse({ ok: false, code: "EXPORT_FAILED" });
    }
    const apiHost = new URL(apiBase()).hostname.toLowerCase();
    const hostAllowed =
      downloadUrl.startsWith(apiBase() + "/") ||
      (downloadUrl.startsWith("https://") &&
        (downloadHost === apiHost || downloadHost === "canva.com" || downloadHost.endsWith(".canva.com")));
    if (!hostAllowed) {
      return jsonResponse({ ok: false, code: "EXPORT_FAILED" });
    }

    // 下載匯出檔。這裡 follow redirect：Canva export URL 是簽名 URL，
    // request 不帶任何 Authorization（credential 無外洩面）；串流計量同
    // cutos F2 — CL 可缺可謊，讀多少算多少。
    let fileRes: Response;
    try {
      fileRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(60000) });
    } catch {
      return jsonResponse({ ok: false, code: "CANVA_UNREACHABLE" });
    }
    if (!fileRes.ok || !fileRes.body) return jsonResponse({ ok: false, code: "EXPORT_FAILED" });
    const declared = Number(fileRes.headers.get("content-length") ?? "0");
    if (declared > MAX_IMPORT_BYTES) return jsonResponse({ ok: false, code: "TOO_LARGE" });
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = fileRes.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_IMPORT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return jsonResponse({ ok: false, code: "TOO_LARGE" });
      }
      chunks.push(value);
    }
    if (received === 0) return jsonResponse({ ok: false, code: "EXPORT_FAILED" });
    const bytes = new Uint8Array(received);
    {
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    const versionId = crypto.randomUUID();
    const imagePath = `rooms/${roomId}/versions/${versionId}/poster.png`;
    const upload = await supabase.storage.from("room-assets").upload(imagePath, bytes, {
      contentType: "image/png",
      upsert: false,
    });
    if (upload.error) return jsonResponse({ ok: false, code: "IMPORT_FAILED" });

    const { data: sortRows } = await supabase
      .from("versions")
      .select("sort_order")
      .eq("room_id", roomId)
      .order("sort_order", { ascending: false })
      .limit(1);
    const sortOrder = (Array.isArray(sortRows) && sortRows[0] ? Number(sortRows[0].sort_order) : -1) + 1;
    const { error: insertError } = await supabase.from("versions").insert({
      id: versionId,
      room_id: roomId,
      label,
      sort_order: sortOrder,
      image_path: imagePath,
      mime_type: "image/png",
      ...(branchId ? { branch_id: branchId } : {}),
    });
    if (insertError) {
      // 半成品清理：列沒落地就把 bytes 收回（同 videoRoom 的孤兒紀律）。
      await supabase.storage.from("room-assets").remove([imagePath]).catch(() => undefined);
      return jsonResponse({ ok: false, code: "IMPORT_FAILED" });
    }
    return jsonResponse({ ok: true, versionId, label, fileSize: bytes.byteLength });
  }

  return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
}

Deno.serve(handle);
