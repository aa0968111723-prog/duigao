/**
 * voice-token — 語音房的 LiveKit access token 鑄造（PR-03，LiveKit 版）。
 *
 * 為什麼是 edge function：LIVEKIT_API_SECRET 是能對整個 LiveKit 專案簽發
 * 任何權限的萬能鑰匙，永遠不進瀏覽器。client 拿到的是**短命、單房、
 * 音訊限定**的 access token（LiveKit 的標準 JWT，HS256）。
 *
 * 邊界：
 *  - 呼叫者必須是該 duigao 房的成員（room_role RPC；RLS 同一權威）。
 *  - LiveKit 房名 = `duigao-<roomId>`：token 只解鎖這一房，跨房無效。
 *  - grant 只有 roomJoin＋canPublish(audio)＋canSubscribe；沒有
 *    roomCreate/roomAdmin/canPublishData 之外的任何管理權。
 *  - TTL 10 分鐘：斷線重連就再要一張，被外洩的 token 很快過期。
 *  - 未設定 env → VOICE_NOT_CONFIGURED，client 以此維持誠實的
 *    「語音房間還在準備」文案 — 不是壞掉，是還沒接。
 *
 * Token 形狀依 LiveKit 公開文件（JWT claims：iss=apiKey、sub=identity、
 * video grant object）；e2e harness 以本檔真實源碼驗證簽名與 claims。
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const TOKEN_TTL_SECONDS = 10 * 60;

function responseHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

/**
 * 預檢：把瀏覽器問的標頭原樣答應。supabase-js 送 x-client-info / apikey，
 * 版本更新還可能再加 — 回應請求裡的清單，之後不會再有「伺服器端測得過、
 * 瀏覽器卻被擋」的落差（curl 不做預檢，所以這種錯只有真瀏覽器抓得到）。
 */
function preflightResponse(request: Request): Response {
  const requested = request.headers.get("access-control-request-headers");
  const headers = responseHeaders();
  if (requested) headers["access-control-allow-headers"] = requested;
  headers["access-control-max-age"] = "86400";
  return new Response(null, { status: 204, headers });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders() });
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

type LiveKitEnv = { url: string; apiKey: string; apiSecret: string };

function liveKitEnv(): LiveKitEnv | null {
  const url = (Deno.env.get("LIVEKIT_URL") ?? "").trim();
  const apiKey = (Deno.env.get("LIVEKIT_API_KEY") ?? "").trim();
  const apiSecret = (Deno.env.get("LIVEKIT_API_SECRET") ?? "").trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const encodeSegment = (obj: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(obj)));

/** LiveKit access token：JWT HS256，claims 形狀依其公開文件。 */
async function mintLiveKitToken(
  env: LiveKitEnv,
  identity: string,
  displayName: string,
  liveKitRoom: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: env.apiKey,
    sub: identity,
    nbf: now - 10,
    exp: now + TOKEN_TTL_SECONDS,
    name: displayName,
    video: {
      room: liveKitRoom,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      // 音訊房：鏡頭/螢幕分享來源一律不開（語音是為了講話，不是開會軟體）
      canPublishSources: ["microphone"],
    },
  };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${base64url(signature)}`;
}

async function handle(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return preflightResponse(request);
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: responseHeaders() });

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!token || !url || !anonKey) return jsonResponse({ ok: false, code: "UNAUTHENTICATED" }, 401);
  const supabase = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return jsonResponse({ ok: false, code: "UNAUTHENTICATED" }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
  }

  const env = liveKitEnv();
  const action = text(body.action) || "token";

  if (action === "health") {
    // health 不驗成員資格（無房參數）：只回可用性布林，不回任何 LiveKit
    // 事實 — 入口要不要渲染，這一個 bit 就夠。
    return jsonResponse({ ok: Boolean(env) , ...(env ? {} : { code: "VOICE_NOT_CONFIGURED" }) });
  }

  if (action === "token") {
    if (!env) return jsonResponse({ ok: false, code: "VOICE_NOT_CONFIGURED" });
    const roomId = text(body.roomId);
    const displayName = text(body.displayName).slice(0, 60) || "夥伴";
    if (!isUuid(roomId)) return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);

    // 成員資格：與其他 bridge 同一線（room_role SECURITY DEFINER helper）。
    const { data: roleData } = await supabase.rpc("room_role", { p_room_id: roomId });
    if (!text(roleData)) return jsonResponse({ ok: false, code: "ROOM_NOT_FOUND" }, 404);

    const liveKitRoom = `duigao-${roomId}`;
    const accessToken = await mintLiveKitToken(env, authData.user.id, displayName, liveKitRoom);
    return jsonResponse({
      ok: true,
      url: env.url,
      token: accessToken,
      liveKitRoom,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });
  }

  return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
}

Deno.serve(handle);
