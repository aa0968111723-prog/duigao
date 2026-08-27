import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  asObject,
  asText,
  hmacSignature,
  jsonResponse,
  sanitizeRegion,
  stripSecrets,
  stringList,
} from "../_shared/roomContext.ts";

type Row = Record<string, unknown>;
type Runtime = typeof globalThis & { EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void } };

function row(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function arrayRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(row) : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function analysisErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("abort") || message.includes("timeout")) return "ANALYSIS_TIMEOUT";
  if (message.includes("permission") || message.includes("row-level security") || message.includes("rls")) return "PERMISSION_DENIED";
  if (message.includes("size") || message.includes("too large")) return "FILE_TOO_LARGE";
  if (message.includes("transcri")) return "TRANSCRIPT_FAILED";
  if (message.includes("ocr") || message.includes("text recognition")) return "OCR_FAILED";
  return "PROVIDER_UNAVAILABLE";
}

function scrub(value: string, max = 10000): string {
  return value.replace(/https?:\/\/[^\s)]+/gi, "[連結已省略]").slice(0, max);
}

function mimeType(value: string): "image" | "video" | "audio" | "document" | "plan" | "whiteboard" | "other" {
  if (["image", "video", "audio", "document", "plan", "whiteboard"].includes(value)) return value as ReturnType<typeof mimeType>;
  if (value.startsWith("image/")) return "image";
  if (value.startsWith("video/")) return "video";
  if (value.startsWith("audio/")) return "audio";
  if (value === "application/pdf" || value.includes("word") || value.includes("text/") || value.includes("markdown")) return "document";
  return "other";
}

function chunkText(content: string, assetId: string, page?: number): Array<Record<string, unknown>> {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const max = 3000;
  const chunks: Array<Record<string, unknown>> = [];
  for (let offset = 0, index = 0; offset < normalized.length; offset += max, index += 1) {
    const part = normalized.slice(offset, offset + max).trim();
    if (!part) continue;
    chunks.push({
      asset_id: assetId,
      chunk_index: index,
      content: scrub(part),
      ...(page == null ? {} : { page }),
      start_offset: offset,
      end_offset: Math.min(normalized.length, offset + max),
    });
  }
  return chunks;
}

function blocksText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = row(item);
    const prefix = block.kind === "checklist" ? (block.checked ? "[x] " : "[ ] ") : "";
    const link = block.kind === "link" && text(block.url) ? `（${text(block.url)}）` : "";
    return `${prefix}${text(block.text)}${link}`.trim();
  }).filter(Boolean).join("\n");
}

function keywordsFrom(content: string): string[] {
  const words = content.toLocaleLowerCase().split(/[^\p{L}\p{N}\u3400-\u9fff]+/gu).filter((word) => word.length >= 2);
  return [...new Set(words)].slice(0, 30);
}

function jsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function internalAnalysisEnabled(): boolean {
  return ["1", "true", "yes"].includes((Deno.env.get("DUIGAO_INTERNAL_ANALYSIS_ENABLED") || "").trim().toLowerCase());
}

async function callAnalysisProvider(asset: Row, kind: string, signedUrl: string | undefined): Promise<Row | null> {
  const endpointBase = (Deno.env.get("TKU_ZEN_AGENT_URL") || "").trim().replace(/\/$/, "");
  const secret = (Deno.env.get("DUIGAO_AGENT_SHARED_SECRET") || "").trim();
  if (!endpointBase || !secret || !signedUrl) return null;
  // A provider receives an expiring URL only after the asset's policy or an
  // explicitly approved internal provider has allowed processing. The URL is
  // never persisted in Postgres or returned by Room Context API.
  const metadata = asObject(asset.metadata);
  const keyframes = Array.isArray(metadata.keyframes)
    ? (metadata.keyframes as unknown[]).slice(0, 12).map((item) => {
        const value = asObject(item);
        const imageUrl = text(value.imageUrl || value.image_url);
        if (!imageUrl) return null;
        return stripSecrets({
          imageUrl,
          ...(value.startSeconds == null && value.start_seconds == null ? {} : { startSeconds: num(value.startSeconds ?? value.start_seconds) }),
          ...(value.endSeconds == null && value.end_seconds == null ? {} : { endSeconds: num(value.endSeconds ?? value.end_seconds) }),
        });
      }).filter(Boolean)
    : [];
  const bodyValue = {
    assetId: text(asset.id),
    assetType: kind,
    title: text(asset.title),
    mimeType: text(asset.mime_type),
    sourceUrl: signedUrl,
    keyframes,
    textContent: scrub(text(metadata.text_content), 20000),
    durationSeconds: metadata.duration_seconds == null ? null : num(metadata.duration_seconds),
    externalAiAllowed: bool(asset.external_ai_allowed),
  };
  const body = JSON.stringify(bodyValue);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacSignature(body, timestamp, secret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 80_000);
  try {
    const response = await fetch(endpointBase.includes("/api/") ? endpointBase : `${endpointBase}/api/v1/asset-analysis`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-duigao-timestamp": timestamp, "x-duigao-signature": `sha256=${signature}` },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const value = asObject(await response.json());
    return stripSecrets(value);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateJob(supabase: ReturnType<typeof createClient>, jobId: string, patch: Row): Promise<void> {
  await supabase.from("asset_analysis_jobs").update(patch).eq("id", jobId);
}

/**
 * Reuse an analysis only when both the bytes and analysis contract match.
 * Version-linked assets intentionally remain separate rows so citations keep
 * their own provenance; the worker copies metadata/children, never Storage
 * bytes. Human regions are left untouched because they are reviewer input.
 */
async function reuseSiblingAnalysis(
  supabase: ReturnType<typeof createClient>,
  job: Row,
  asset: Row,
): Promise<boolean> {
  const assetId = text(asset.id);
  const contentHash = text(asset.content_hash).trim();
  const analysisVersion = text(job.analysis_version, text(asset.analysis_version, "1.0"));
  if (!assetId || !contentHash) return false;

  const siblingResult = await supabase
    .from("intelligent_assets")
    .select("id,status,analysis_version,analysis_provider,analysis_updated_at")
    .eq("room_id", text(asset.room_id))
    .eq("content_hash", contentHash)
    .eq("analysis_version", analysisVersion)
    .neq("id", assetId)
    .in("status", ["ready", "partial"])
    .order("analysis_updated_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const sibling = row(siblingResult.data);
  if (siblingResult.error || !sibling.id) return false;

  const siblingId = text(sibling.id);
  const [analysisResult, regionsResult, segmentsResult, chunksResult] = await Promise.all([
    supabase.from("asset_analysis").select("summary,detected_text,topics,keywords,language,content_type,confidence,structured_data,model_name,model_version").eq("asset_id", siblingId).maybeSingle(),
    supabase.from("asset_regions").select("region_type,label,text_content,x,y,width,height,confidence,source").eq("asset_id", siblingId).eq("source", "ai").order("y", { ascending: true }).limit(100),
    supabase.from("asset_video_segments").select("start_seconds,end_seconds,summary,transcript,topics,detected_text,scene_type,confidence").eq("asset_id", siblingId).order("start_seconds", { ascending: true }).limit(100),
    supabase.from("asset_document_chunks").select("chunk_index,content,page,section,heading,start_offset,end_offset").eq("asset_id", siblingId).order("chunk_index", { ascending: true }).limit(24),
  ]);
  if (analysisResult.error || regionsResult.error || segmentsResult.error || chunksResult.error || !analysisResult.data) return false;

  const sourceAnalysis = row(analysisResult.data);
  const analysis = {
    asset_id: assetId,
    room_id: text(asset.room_id),
    summary: scrub(text(sourceAnalysis.summary), 6000),
    detected_text: scrub(text(sourceAnalysis.detected_text), 20000),
    topics: stringList(sourceAnalysis.topics),
    keywords: stringList(sourceAnalysis.keywords),
    language: text(sourceAnalysis.language) || null,
    content_type: text(sourceAnalysis.content_type) || null,
    confidence: sourceAnalysis.confidence == null ? null : num(sourceAnalysis.confidence),
    structured_data: stripSecrets(asObject(sourceAnalysis.structured_data)),
    model_name: text(sourceAnalysis.model_name, "dedup-reuse"),
    model_version: text(sourceAnalysis.model_version, analysisVersion),
  };
  const regions = arrayRows(regionsResult.data).flatMap((value) => {
    const safe = sanitizeRegion({
      type: value.region_type,
      label: value.label,
      text: value.text_content,
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      confidence: value.confidence,
    });
    return safe ? [{
      asset_id: assetId,
      room_id: text(asset.room_id),
      region_type: safe.type,
      label: safe.label,
      text_content: safe.text ?? "",
      x: safe.x,
      y: safe.y,
      width: safe.width,
      height: safe.height,
      confidence: safe.confidence ?? null,
      source: "ai",
    }] : [];
  });
  const segments = arrayRows(segmentsResult.data).flatMap((value) => {
    const start = Math.max(0, num(value.start_seconds));
    const end = Math.max(start, num(value.end_seconds));
    return end > start ? [{
      asset_id: assetId,
      room_id: text(asset.room_id),
      start_seconds: start,
      end_seconds: end,
      summary: scrub(text(value.summary), 6000),
      transcript: scrub(text(value.transcript), 12000),
      topics: stringList(value.topics),
      detected_text: scrub(text(value.detected_text), 4000),
      scene_type: text(value.scene_type) || null,
      confidence: value.confidence == null ? null : num(value.confidence),
    }] : [];
  });
  const chunks = arrayRows(chunksResult.data).flatMap((value, index) => {
    const content = scrub(text(value.content), 100000);
    return content ? [{
      asset_id: assetId,
      room_id: text(asset.room_id),
      chunk_index: Math.max(0, Math.floor(num(value.chunk_index, index))),
      content,
      page: value.page == null ? null : Math.max(1, Math.floor(num(value.page))),
      section: text(value.section) || null,
      heading: text(value.heading) || null,
      start_offset: value.start_offset == null ? null : Math.max(0, Math.floor(num(value.start_offset))),
      end_offset: value.end_offset == null ? null : Math.max(0, Math.floor(num(value.end_offset))),
    }] : [];
  });

  const analysisWrite = await supabase.from("asset_analysis").upsert(analysis, { onConflict: "asset_id" });
  if (analysisWrite.error) throw analysisWrite.error;
  const regionDelete = await supabase.from("asset_regions").delete().eq("asset_id", assetId).eq("source", "ai");
  if (regionDelete.error) throw regionDelete.error;
  if (regions.length) {
    const result = await supabase.from("asset_regions").insert(regions);
    if (result.error) throw result.error;
  }
  const segmentDelete = await supabase.from("asset_video_segments").delete().eq("asset_id", assetId);
  if (segmentDelete.error) throw segmentDelete.error;
  if (segments.length) {
    const result = await supabase.from("asset_video_segments").insert(segments);
    if (result.error) throw result.error;
  }
  const chunkDelete = await supabase.from("asset_document_chunks").delete().eq("asset_id", assetId);
  if (chunkDelete.error) throw chunkDelete.error;
  if (chunks.length) {
    const result = await supabase.from("asset_document_chunks").insert(chunks);
    if (result.error) throw result.error;
  }

  const now = new Date().toISOString();
  await supabase.from("intelligent_assets").update({
    status: text(sibling.status, "partial"),
    analysis_provider: text(sibling.analysis_provider, "dedup-reuse"),
    analysis_updated_at: now,
  }).eq("id", assetId);
  await updateJob(supabase, text(job.id), {
    status: "completed",
    progress: 100,
    stage: "dedupe",
    error_code: null,
    provider: "dedup-reuse",
    model: text(sibling.analysis_provider, "existing-analysis"),
    input_type: mimeType(text(asset.asset_type) === "other" ? text(asset.mime_type) : text(asset.asset_type)),
    processing_ms: 0,
    completed_at: now,
  });
  return true;
}

async function processJob(
  supabase: ReturnType<typeof createClient>,
  job: Row,
  asset: Row,
): Promise<void> {
  const startedAt = Date.now();
  const assetId = text(asset.id);
  const jobId = text(job.id);
  // Claim the queue row atomically. Opening the same room in two tabs can
  // enqueue/kick the same job at once; only the caller that changed queued ->
  // processing may spend provider budget.
  const claim = await supabase.from("asset_analysis_jobs").update({ status: "processing", progress: 5, stage: "metadata", started_at: new Date().toISOString() }).eq("id", jobId).eq("status", "queued").select("id").maybeSingle();
  if (claim.error) throw claim.error;
  if (!claim.data) return;
  await supabase.from("intelligent_assets").update({ status: "processing" }).eq("id", assetId);
  try {
    if (await reuseSiblingAnalysis(supabase, job, asset)) return;
    const kind = mimeType(text(asset.asset_type) === "other" ? text(asset.mime_type) : text(asset.asset_type));
    const metadata = asObject(asset.metadata);
    const textContent = scrub(text(metadata.text_content), 50000);
    let analysis: Row = {
      asset_id: assetId,
      room_id: text(asset.room_id),
      summary: "",
      detected_text: "",
      topics: [],
      keywords: [],
      content_type: kind,
      structured_data: {},
      model_name: "duigao-tier-1",
      model_version: text(asset.analysis_version, "1.0"),
    };
    let chunks: Array<Record<string, unknown>> = [];
    let regions: Array<Record<string, unknown>> = [];
    let segments: Array<Record<string, unknown>> = [];
    let finalStatus: "ready" | "partial" = "partial";
    let errorCode: string | null = null;

    if (kind === "plan") {
      const { data: plan } = await supabase.from("plan_documents").select("title,description,blocks").eq("room_id", asset.room_id).eq("branch_id", asset.branch_id).maybeSingle();
      const planRow = row(plan);
      const content = [text(planRow.description), blocksText(planRow.blocks)].filter(Boolean).join("\n");
      chunks = chunkText(content, assetId);
      analysis = {
        ...analysis,
        summary: `企劃「${text(planRow.title, text(asset.title))}」的文字與清單已建立索引。`,
        detected_text: scrub(content, 20000),
        topics: keywordsFrom(content).slice(0, 12),
        keywords: keywordsFrom(content),
        structured_data: stripSecrets({ title: text(planRow.title), hasChecklist: Array.isArray(planRow.blocks) && planRow.blocks.some((item) => row(item).kind === "checklist") }),
      };
      finalStatus = "ready";
    } else if (kind === "document") {
      let extractedText = textContent;
      let documentProvider: Row | null = null;
      // Text already supplied by an importer is handled locally. A binary PDF
      // or DOCX may opt into the approved document parser through the same
      // short-lived URL boundary; it is never embedded in an AI prompt here.
      if (!extractedText && (bool(asset.external_ai_allowed) || internalAnalysisEnabled()) && text(asset.storage_path)) {
        const signedResult = await supabase.storage.from("room-assets").createSignedUrl(text(asset.storage_path), 120);
        documentProvider = await callAnalysisProvider(asset, kind, signedResult.data?.signedUrl);
        extractedText = scrub(text(documentProvider?.detectedText ?? documentProvider?.detected_text), 50000);
      }
      chunks = documentProvider && Array.isArray(documentProvider.documentChunks)
        ? documentProvider.documentChunks.slice(0, 24).map((item) => {
            const value = row(item);
            return {
              asset_id: assetId,
              chunk_index: Math.max(0, Math.floor(num(value.chunkIndex ?? value.chunk_index))),
              content: scrub(text(value.content), 100000),
              ...(value.page == null ? {} : { page: Math.max(1, Math.floor(num(value.page))) }),
              ...(text(value.heading) ? { heading: text(value.heading) } : {}),
              ...(text(value.section) ? { section: text(value.section) } : {}),
              ...(value.startOffset == null && value.start_offset == null ? {} : { start_offset: Math.max(0, Math.floor(num(value.startOffset ?? value.start_offset))) }),
              ...(value.endOffset == null && value.end_offset == null ? {} : { end_offset: Math.max(0, Math.floor(num(value.endOffset ?? value.end_offset))) }),
            };
          })
        : chunkText(extractedText, assetId);
      analysis = { ...analysis, summary: chunks.length ? "文件文字已抽取並建立段落索引。" : "文件尚未提供可抽取文字；原檔仍可使用。", detected_text: extractedText, keywords: keywordsFrom(extractedText), topics: keywordsFrom(extractedText).slice(0, 12) };
      finalStatus = chunks.length ? "ready" : "partial";
      errorCode = chunks.length ? null : "UNSUPPORTED_FORMAT";
    } else if (kind === "whiteboard") {
      const nodes = Array.isArray(metadata.nodes) ? metadata.nodes : [];
      const edges = Array.isArray(metadata.edges) ? metadata.edges : [];
      const nodeText = nodes.map((item) => text(row(item).content)).filter(Boolean).join("\n");
      chunks = chunkText(nodeText, assetId);
      analysis = { ...analysis, summary: `白板包含 ${nodes.length} 個節點與 ${edges.length} 條連線。`, detected_text: scrub(nodeText), topics: keywordsFrom(nodeText), structured_data: stripSecrets({ nodeCount: nodes.length, edgeCount: edges.length, nodes, edges }) };
      finalStatus = "ready";
    } else if (kind === "image" || kind === "video" || kind === "audio") {
      await updateJob(supabase, jobId, { progress: 20, stage: kind === "video" ? "keyframes" : kind === "audio" ? "transcript" : "ocr" });
      let signed: string | undefined;
      let providerAsset = asset;
      const providerAllowed = bool(asset.external_ai_allowed) || internalAnalysisEnabled();
      if (providerAllowed) {
        const signedResult = await supabase.storage.from("room-assets").createSignedUrl(text(asset.storage_path), 120);
        signed = signedResult.data?.signedUrl;
        if (kind === "video") {
          const posterPath = text(metadata.poster_storage_path);
          if (posterPath) {
            const posterResult = await supabase.storage.from("room-assets").createSignedUrl(posterPath, 120);
            const posterUrl = posterResult.data?.signedUrl;
            if (posterUrl) {
              const existing = Array.isArray(metadata.keyframes) ? metadata.keyframes : [];
              providerAsset = {
                ...asset,
                metadata: {
                  ...metadata,
                  keyframes: [{ imageUrl: posterUrl, startSeconds: 0, endSeconds: 1 }, ...existing].slice(0, 12),
                },
              };
            }
          }
        }
      }
      const provider = await callAnalysisProvider(providerAsset, kind, signed);
      if (provider) {
        const providerRegions = Array.isArray(provider.regions) ? provider.regions.slice(0, 100).map(sanitizeRegion).filter(Boolean) : [];
        regions = providerRegions.map((region) => ({ asset_id: assetId, region_type: text(row(region).type, "other"), label: text(row(region).label), text_content: text(row(region).text), x: num(row(region).x), y: num(row(region).y), width: num(row(region).width), height: num(row(region).height), confidence: row(region).confidence == null ? null : num(row(region).confidence), source: "ai" }));
        const providerSegments = Array.isArray(provider.segments) ? provider.segments.slice(0, 100) : [];
        segments = providerSegments.map((segment) => ({ asset_id: assetId, start_seconds: Math.max(0, num(row(segment).startSeconds ?? row(segment).start_seconds)), end_seconds: Math.max(0, num(row(segment).endSeconds ?? row(segment).end_seconds)), summary: scrub(text(row(segment).summary)), transcript: scrub(text(row(segment).transcript)), topics: stringList(row(segment).topics), detected_text: scrub(text(row(segment).detectedText ?? row(segment).detected_text)), scene_type: text(row(segment).sceneType ?? row(segment).scene_type) || null, confidence: row(segment).confidence == null ? null : num(row(segment).confidence) })).filter((segment) => segment.end_seconds > segment.start_seconds);
        analysis = { ...analysis, summary: scrub(text(provider.summary), 6000), detected_text: scrub(text(provider.detectedText ?? provider.detected_text), 20000), topics: stringList(provider.topics), keywords: stringList(provider.keywords), structured_data: stripSecrets(asObject(provider.structuredData ?? provider.structured_data)), model_name: text(provider.modelName ?? provider.model_name, "approved-provider"), model_version: text(provider.modelVersion ?? provider.model_version, text(asset.analysis_version, "1.0")) };
        const providerError = text(provider.errorCode ?? provider.error_code) || null;
        finalStatus = providerError ? "partial" : "ready";
        errorCode = providerError;
      } else if (!providerAllowed) {
        analysis = { ...analysis, summary: "已建立素材與版本索引；這份素材禁止送到外部 AI，因此尚未讀取畫面內容。" };
        errorCode = "EXTERNAL_AI_BLOCKED";
      } else {
        analysis = { ...analysis, summary: "已建立素材與版本索引；目前沒有可用的核准理解 provider。原稿沒有被修改。" };
        errorCode = "PROVIDER_UNAVAILABLE";
      }
    } else {
      analysis = { ...analysis, summary: "已建立檔案 metadata；這種格式目前沒有可用的分析器。" };
      errorCode = "UNSUPPORTED_FORMAT";
    }

    await supabase.from("asset_analysis").upsert(analysis, { onConflict: "asset_id" });
    await supabase.from("asset_document_chunks").delete().eq("asset_id", assetId);
    if (chunks.length) await supabase.from("asset_document_chunks").insert(chunks);
    await supabase.from("asset_regions").delete().eq("asset_id", assetId).eq("source", "ai");
    if (regions.length) await supabase.from("asset_regions").insert(regions);
    await supabase.from("asset_video_segments").delete().eq("asset_id", assetId);
    if (segments.length) await supabase.from("asset_video_segments").insert(segments);
    await supabase.from("intelligent_assets").update({ status: finalStatus, analysis_provider: text(analysis.model_name), analysis_updated_at: new Date().toISOString() }).eq("id", assetId);
    await updateJob(supabase, jobId, {
      status: "completed",
      progress: 100,
      stage: "completed",
      error_code: errorCode,
      provider: text(analysis.model_name) || null,
      model: text(analysis.model_name) || null,
      input_type: kind,
      processing_ms: Date.now() - startedAt,
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    await supabase.from("intelligent_assets").update({ status: "failed" }).eq("id", assetId);
    await updateJob(supabase, jobId, { status: "failed", progress: 100, stage: "failed", error_code: analysisErrorCode(error), error_detail: error instanceof Error ? error.message.slice(0, 400) : "analysis failed", processing_ms: Date.now() - startedAt, completed_at: new Date().toISOString() });
  }
}

async function handle(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: jsonHeaders() });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: jsonHeaders() });
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!token || !url || !anonKey) return jsonResponse({ error: "UNAUTHENTICATED" }, 401);
  const supabase = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return jsonResponse({ error: "UNAUTHENTICATED" }, 401);
  let input: Row;
  try { input = asObject(await request.json()); } catch { return jsonResponse({ error: "INVALID_REQUEST" }, 400); }
  const assetId = text(input.assetId);
  const action = text(input.action, "enqueue");
  if (!assetId || !["enqueue", "process", "retry"].includes(action)) return jsonResponse({ error: "INVALID_REQUEST" }, 400);
  const { data: asset, error: assetError } = await supabase.from("intelligent_assets").select("*").eq("id", assetId).maybeSingle();
  if (assetError || !asset) return jsonResponse({ error: "ASSET_NOT_FOUND" }, 404);
  const assetRow = row(asset);
  const { data: membership } = await supabase.from("room_members").select("role").eq("room_id", text(assetRow.room_id)).eq("user_id", authData.user.id).maybeSingle();
  const role = text(row(membership).role);
  if (!role) return jsonResponse({ error: "PERMISSION_DENIED" }, 403);
  if (role === "reviewer") return jsonResponse({ error: "PERMISSION_DENIED" }, 403);
  if (!bool(assetRow.ai_readable, true)) return jsonResponse({ error: "AI_READABLE_DISABLED" }, 403);
  if (action === "retry") {
    const { data: latestJob } = await supabase.from("asset_analysis_jobs").select("id,retry_count,status").eq("asset_id", assetId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const retryCount = num(row(latestJob).retry_count) + 1;
    const { error: retryError } = await supabase.from("asset_analysis_jobs")
      .update({ status: "queued", progress: 0, stage: "queued", error_code: null, error_detail: null, retry_count: retryCount })
      .eq("asset_id", assetId).in("status", ["failed", "completed"]);
    if (retryError) return jsonResponse({ error: "QUEUE_FAILED" }, 503);
  }
  let { data: job } = await supabase.from("asset_analysis_jobs").select("*").eq("asset_id", assetId).in("status", ["queued", "processing"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!job) {
    const dedupeKey = `${assetId}:${text(assetRow.analysis_version, "1.0")}:${text(assetRow.content_hash)}:${action === "retry" ? Date.now() : "1"}`;
    const result = await supabase.from("asset_analysis_jobs").insert({ asset_id: assetId, room_id: text(assetRow.room_id), tier: Math.max(0, Math.min(3, Math.floor(num(input.tier, 1)))), status: "queued", progress: 0, stage: "queued", analysis_version: text(assetRow.analysis_version, "1.0"), content_hash: text(assetRow.content_hash) || null, dedupe_key, created_by: authData.user.id }).select("*").single();
    if (result.error) return jsonResponse({ error: "QUEUE_FAILED" }, 503);
    job = result.data;
  }
  const task = processJob(supabase, row(job), assetRow);
  if (action === "process") await task;
  else (globalThis as Runtime).EdgeRuntime?.waitUntil(task);
  return new Response(JSON.stringify({ assetId, jobId: text(row(job).id), status: action === "process" ? "completed" : "queued" }), { status: 202, headers: jsonHeaders() });
}

Deno.serve((request) => handle(request).catch(() => jsonResponse({ error: "ANALYSIS_UNAVAILABLE" }, 503)));
