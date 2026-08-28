/**
 * cutos-bridge — CUTOS 成品匯入的 S2S 橋（PR-07 第一階段，ADR-005 v2）。
 *
 * 為什麼是 edge function：CUTOS 的 editor REST 無認證、AIOS bridge 只有
 * 一把 `CUTOS_API_KEY`。key 與 base URL 只活在這裡的環境變數 — client
 * 永遠拿不到；任何 iframe/proxy 暴露都是 ADR-005 的紅線。
 *
 * 第一階段動作（刻意最小）：
 *  - health：GET /api/aios/manifest（帶 key）→ 協定協商 → 誠實可用性。
 *    未設定 env → CUTOS_NOT_CONFIGURED，client 以此隱藏整個入口。
 *  - import-output：把 CUTOS 已渲染的成品 MP4 抓來、以呼叫者自己的
 *    JWT（RLS 全程生效）上傳成房間的新影片版本。沒有成品 → NO_EXPORT
 *    誠實回報；絕不觸發新的 export（requiresApproval=true 屬 AI 提案層，
 *    之後的 PR）。
 *
 * 安全邊界：
 *  - 呼叫者必須是房間成員且非 reviewer（與 storage 0007 can_manage_media
 *    同一線；上傳與版本列都用呼叫者 JWT 寫入，RLS 是唯一權威，這裡的
 *    前置檢查只是給誠實錯誤碼）。
 *  - 大小上限 200MB（0006 bucket 上限同值）；Content-Length 先驗，
 *    缺頭則以實際 bytes 再驗。
 *  - 回應永不含 CUTOS base URL、key、或上游原始錯誤字串。
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Edge isolate 記憶體 ~256MB：200MB 的 arrayBuffer 是自殺（Grok 07 F2）。
// 第一階段誠實上限 50MB — 超過的成品走一般影片上傳（client 有 XHR 進度
// 與取消），或在 CUTOS 端壓製。串流計量：CL 可缺可謊，讀多少算多少，
// 超線立即中止。
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

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

/** CUTOS 專案 id：字母數字/底線/連字號，防 path traversal 進上游 URL。 */
const isSafeId = (value: string): boolean => /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

type CutosEnv = { baseUrl: string; apiKey: string };

function cutosEnv(): CutosEnv | null {
  const baseUrl = (Deno.env.get("CUTOS_BASE_URL") ?? "").replace(/\/+$/, "");
  const apiKey = Deno.env.get("CUTOS_API_KEY") ?? "";
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

async function cutosHealth(env: CutosEnv): Promise<Record<string, unknown>> {
  let manifest: Record<string, unknown>;
  try {
    const res = await fetch(`${env.baseUrl}/api/aios/manifest`, {
      headers: { authorization: `Bearer ${env.apiKey}` },
      signal: AbortSignal.timeout(8000),
      // 不跟 redirect（Grok 07 F1）：CUTOS 直接供檔；302 出去可能把
      // Authorization 轉送到任意 Location（歷史 Deno CVE），一律拒絕。
      redirect: "manual",
    });
    if (!res.ok) return { ok: false, code: "CUTOS_UNREACHABLE" };
    manifest = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, code: "CUTOS_UNREACHABLE" };
  }
  // 協定協商（cutos.agent.v2 契約）：對不上就大聲失敗，不靜默降級。
  const remoteVersion = text(manifest.protocolVersion);
  const remoteSupported = Array.isArray(manifest.supportedProtocols)
    ? manifest.supportedProtocols.map((item) => String(item))
    : [];
  const speaks = [remoteVersion, ...remoteSupported];
  const negotiated = ["cutos.agent.v2", "cutos.agent.v1"].find((candidate) => speaks.includes(candidate));
  if (!negotiated) return { ok: false, code: "PROTOCOL_VERSION_MISMATCH" };
  // 只回 client 需要的（Grok 07 F7）：版本指紋不進瀏覽器。
  return { ok: true, negotiated };
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

  const env = cutosEnv();
  const action = text(body.action);

  if (action === "health") {
    if (!env) return jsonResponse({ ok: false, code: "CUTOS_NOT_CONFIGURED" });
    return jsonResponse(await cutosHealth(env));
  }

  if (action === "import-output") {
    if (!env) return jsonResponse({ ok: false, code: "CUTOS_NOT_CONFIGURED" });
    const roomId = text(body.roomId);
    const cutosProjectId = text(body.cutosProjectId);
    const branchId = text(body.branchId);
    const label = text(body.label).slice(0, 80) || "CUTOS 成品";
    if (!isUuid(roomId) || !isSafeId(cutosProjectId) || (branchId && !isUuid(branchId))) {
      return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
    }

    // 前置角色檢查（誠實錯誤碼用；RLS 才是權威 — 之後每一筆寫入都用
    // 呼叫者 JWT，繞過這裡也繞不過 policy）。
    const { data: roleData } = await supabase.rpc("room_role", { p_room_id: roomId });
    const role = text(roleData);
    if (!role) return jsonResponse({ ok: false, code: "ROOM_NOT_FOUND" }, 404);
    if (role === "reviewer") return jsonResponse({ ok: false, code: "FORBIDDEN" }, 403);
    if (branchId) {
      // branch 必須屬於這間房（Grok 07 F3）：跨房 branch_id 是髒資料。
      const { data: branchRow } = await supabase
        .from("room_branches")
        .select("id")
        .eq("id", branchId)
        .eq("room_id", roomId)
        .maybeSingle();
      if (!branchRow) return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
    }

    // 抓成品。404＝還沒渲染過 — 這是使用者可行動的答案，不是錯誤堆疊。
    let upstream: Response;
    try {
      upstream = await fetch(`${env.baseUrl}/api/projects/${cutosProjectId}/output`, {
        signal: AbortSignal.timeout(120000),
        redirect: "manual", // 302 出去一律拒（Grok 07 F1）
      });
    } catch {
      return jsonResponse({ ok: false, code: "CUTOS_UNREACHABLE" });
    }
    if (upstream.status === 404) return jsonResponse({ ok: false, code: "NO_EXPORT" });
    if (!upstream.ok || !upstream.body) return jsonResponse({ ok: false, code: "CUTOS_UNREACHABLE" });
    const declared = Number(upstream.headers.get("content-length") ?? "0");
    if (declared > MAX_IMPORT_BYTES) return jsonResponse({ ok: false, code: "TOO_LARGE" });
    // 串流計量（Grok 07 F2）：CL 缺頭或說謊都擋得住 — 讀多少算多少，
    // 超線立即取消上游連線，絕不把未知大小的 body 一口氣進記憶體。
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = upstream.body.getReader();
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
    if (received === 0) return jsonResponse({ ok: false, code: "NO_EXPORT" });
    const bytes = new Uint8Array(received);
    {
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }

    const versionId = crypto.randomUUID();
    const videoPath = `rooms/${roomId}/videos/${versionId}/original.mp4`;
    const upload = await supabase.storage.from("room-assets").upload(videoPath, bytes, {
      contentType: "video/mp4",
      upsert: false,
    });
    if (upload.error) return jsonResponse({ ok: false, code: "IMPORT_FAILED" });

    // 列最後寫（與 videoRoom 同一原則：版本列存在 ⇒ bytes 一定在）。
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
      media_kind: "video",
      image_path: null,
      video_path: videoPath,
      mime_type: "video/mp4",
      file_size: bytes.byteLength,
      duration_seconds: null,
      width: null,
      height: null,
      ...(branchId ? { branch_id: branchId } : {}),
    });
    if (insertError) {
      // 半成品清理：列沒落地就把 bytes 收回（同 videoRoom 的孤兒紀律）。
      await supabase.storage.from("room-assets").remove([videoPath]).catch(() => undefined);
      return jsonResponse({ ok: false, code: "IMPORT_FAILED" });
    }
    return jsonResponse({ ok: true, versionId, label, fileSize: bytes.byteLength });
  }

  return jsonResponse({ ok: false, code: "INVALID_REQUEST" }, 400);
}

Deno.serve(handle);
