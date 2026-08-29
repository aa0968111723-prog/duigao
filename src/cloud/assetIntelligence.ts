import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomBranch, Version } from "../lib/types";
import {
  ASSET_STATUSES,
  ASSET_TYPES,
  ANALYSIS_JOB_STATUSES,
  contextCacheKey,
  latestVersionForBranch,
  normalizeAssetRegion,
  type AnalysisErrorCode,
  type AssetAnalysis,
  type AssetAnalysisJob,
  type AssetDocumentChunk,
  type AssetHumanMetadata,
  type AssetRelation,
  type AssetRelationType,
  type AssetStatus,
  type AssetType,
  type AssetVideoSegment,
  type IntelligentAsset,
  type RoomContextRequest,
  type RoomContextResponse,
} from "../lib/assetIntelligence";
import { DocumentUnderstandingProvider, PdfReader } from "../ai/documentUnderstanding";
import { VideoUnderstandingProvider } from "../ai/videoUnderstanding";
import { answerDuigaoRoomContext } from "../ai/aiOsRoomContext";
import { ensureSession } from "./auth";
import { getSupabase } from "./client";
import { isCloudConfigured } from "./config";
import { acceptAssetAnalysisPayload } from "./assetAnalysisPayload";
import { invokeErrorContentType, looksLikeSpaHtml, parseFunctionPayload } from "./apiResponse";
import { loadAiContext, saveAiContext } from "../lib/store";

type Row = Record<string, unknown>;

const ASSET_SELECT = [
  "id", "room_id", "branch_id", "version_id", "asset_type", "title",
  "original_filename", "mime_type", "storage_path", "source", "status",
  "analysis_version", "analysis_provider", "analysis_updated_at",
  "ai_readable", "external_ai_allowed", "content_hash", "metadata",
  "created_by", "created_at", "updated_at",
].join(",");

function row(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value: unknown): string | undefined {
  const result = text(value).trim();
  return result ? result : undefined;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function enumValue<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T[number] : fallback;
}

function analysisFromRow(raw: unknown): AssetAnalysis {
  const value = row(raw);
  return {
    assetId: text(value.asset_id),
    summary: text(value.summary),
    detectedText: text(value.detected_text),
    topics: list(value.topics),
    keywords: list(value.keywords),
    language: optionalText(value.language),
    contentType: optionalText(value.content_type),
    confidence: value.confidence == null ? undefined : number(value.confidence),
    structuredData: object(value.structured_data),
    modelName: optionalText(value.model_name),
    modelVersion: optionalText(value.model_version),
    updatedAt: text(value.updated_at, new Date(0).toISOString()),
  };
}

function humanFromRow(raw: unknown): AssetHumanMetadata {
  const value = row(raw);
  return {
    assetId: text(value.asset_id),
    title: optionalText(value.title),
    summary: optionalText(value.summary),
    tags: list(value.tags),
    structuredData: object(value.structured_data),
    updatedAt: text(value.updated_at, new Date(0).toISOString()),
  };
}

function segmentFromRow(raw: unknown): AssetVideoSegment {
  const value = row(raw);
  return {
    id: text(value.id),
    assetId: text(value.asset_id),
    startSeconds: Math.max(0, number(value.start_seconds)),
    endSeconds: Math.max(0, number(value.end_seconds)),
    summary: text(value.summary),
    transcript: text(value.transcript),
    topics: list(value.topics),
    detectedText: text(value.detected_text),
    sceneType: optionalText(value.scene_type),
    confidence: value.confidence == null ? undefined : number(value.confidence),
  };
}

function chunkFromRow(raw: unknown): AssetDocumentChunk {
  const value = row(raw);
  return {
    id: text(value.id),
    assetId: text(value.asset_id),
    chunkIndex: Math.max(0, Math.floor(number(value.chunk_index))),
    content: text(value.content),
    page: value.page == null ? undefined : Math.max(1, Math.floor(number(value.page))),
    section: optionalText(value.section),
    heading: optionalText(value.heading),
    startOffset: value.start_offset == null ? undefined : Math.max(0, Math.floor(number(value.start_offset))),
    endOffset: value.end_offset == null ? undefined : Math.max(0, Math.floor(number(value.end_offset))),
  };
}

function jobFromRow(raw: unknown): AssetAnalysisJob {
  const value = row(raw);
  return {
    id: text(value.id),
    assetId: text(value.asset_id),
    roomId: text(value.room_id),
    tier: Math.max(0, Math.min(3, Math.floor(number(value.tier, 1)))) as 0 | 1 | 2 | 3,
    status: enumValue(value.status, ANALYSIS_JOB_STATUSES, "queued") as AssetAnalysisJob["status"],
    progress: Math.max(0, Math.min(100, Math.floor(number(value.progress)))),
    stage: text(value.stage, "queued"),
    errorCode: optionalText(value.error_code) as AnalysisErrorCode | string | undefined,
    retryCount: Math.max(0, Math.floor(number(value.retry_count))),
    provider: optionalText(value.provider),
    model: optionalText(value.model),
    estimatedCost: value.estimated_cost == null ? undefined : number(value.estimated_cost),
    processingMs: value.processing_ms == null ? undefined : Math.max(0, Math.floor(number(value.processing_ms))),
    analysisVersion: text(value.analysis_version, "1.0"),
    createdAt: text(value.created_at, new Date(0).toISOString()),
    updatedAt: text(value.updated_at, new Date(0).toISOString()),
  };
}

function relationFromRow(raw: unknown): AssetRelation {
  const value = row(raw);
  return {
    id: text(value.id),
    roomId: text(value.room_id),
    sourceAssetId: text(value.source_asset_id),
    targetAssetId: text(value.target_asset_id),
    relationType: text(value.relation_type, "related_to") as AssetRelationType,
    createdBy: optionalText(value.created_by),
    createdAt: text(value.created_at, new Date(0).toISOString()),
  };
}

function assetFromRow(raw: unknown, branches: RoomBranch[] | undefined, versions: Version[]): IntelligentAsset {
  const value = row(raw);
  const assetType = enumValue(value.asset_type, ASSET_TYPES, "other") as AssetType;
  const branchId = optionalText(value.branch_id);
  const latest = branchId ? latestVersionForBranch(versions, branchId) : undefined;
  const metadata = object(value.metadata);
  return {
    id: text(value.id),
    roomId: text(value.room_id),
    branchId,
    versionId: optionalText(value.version_id),
    assetType,
    title: text(value.title, "未命名素材"),
    originalFilename: optionalText(value.original_filename),
    mimeType: optionalText(value.mime_type),
    storagePath: optionalText(value.storage_path),
    source: enumValue(value.source, ["upload", "generated", "canva", "room", "external"] as const, "room"),
    status: enumValue(value.status, ASSET_STATUSES, "pending") as AssetStatus,
    analysisVersion: text(value.analysis_version, "1.0"),
    analysisProvider: optionalText(value.analysis_provider),
    analysisUpdatedAt: optionalText(value.analysis_updated_at),
    aiReadable: bool(value.ai_readable, true),
    externalAiAllowed: bool(value.external_ai_allowed, false),
    contentHash: optionalText(value.content_hash),
    metadata,
    createdBy: optionalText(value.created_by),
    createdAt: text(value.created_at, new Date(0).toISOString()),
    updatedAt: text(value.updated_at, new Date(0).toISOString()),
    regions: [],
    videoSegments: [],
    documentChunks: [],
    latestVersion: latest
      ? {
          id: latest.id,
          label: latest.label,
          sortOrder: number(metadata.version_order),
          archived: Boolean(latest.archivedAt),
        }
      : undefined,
  };
}

export type AssetIntelligenceSnapshot = {
  assets: IntelligentAsset[];
  jobs: AssetAnalysisJob[];
  relations: AssetRelation[];
};

export type RegisterAssetInput = {
  roomId: string;
  branchId?: string;
  versionId?: string;
  assetType: AssetType;
  title: string;
  originalFilename?: string;
  mimeType?: string;
  storagePath?: string;
  source?: IntelligentAsset["source"];
  contentHash?: string;
  metadata?: Record<string, unknown>;
};

function assertResponse(value: unknown): RoomContextResponse {
  if (!value || typeof value !== "object") throw new Error("AI context 回應格式不正確");
  const response = value as Partial<RoomContextResponse>;
  if (typeof response.room?.id !== "string" || typeof response.query !== "string" || !Array.isArray(response.context)) {
    throw new Error("AI context 回應缺少必要欄位");
  }
  return response as RoomContextResponse;
}

/**
 * Read only the bounded intelligence slice for a room. No signed media URL is
 * requested here; a review workspace loads media through its existing path.
 */
export async function listIntelligentAssets(
  supabase: SupabaseClient,
  roomId: string,
  options: { branches?: RoomBranch[]; versions?: Version[]; branchId?: string; limit?: number } = {},
): Promise<AssetIntelligenceSnapshot> {
  await ensureSession(supabase);
  const limit = Math.max(1, Math.min(200, options.limit ?? 160));
  let assetQuery = supabase.from("intelligent_assets").select(ASSET_SELECT).eq("room_id", roomId).order("updated_at", { ascending: false }).limit(limit);
  if (options.branchId) assetQuery = assetQuery.eq("branch_id", options.branchId);
  const { data: assetRows, error: assetError } = await assetQuery;
  if (assetError) throw assetError;
  const assets = (assetRows ?? []).map((raw) => assetFromRow(raw, options.branches, options.versions ?? []));
  const ids = assets.map((asset) => asset.id).filter(Boolean);
  if (!ids.length) return { assets, jobs: [], relations: [] };

  const [analysisResult, regionsResult, segmentsResult, chunksResult, humanResult, jobsResult, relationsResult] = await Promise.all([
    supabase.from("asset_analysis").select("*").in("asset_id", ids),
    supabase.from("asset_regions").select("*").in("asset_id", ids).order("y", { ascending: true }),
    supabase.from("asset_video_segments").select("*").in("asset_id", ids).order("start_seconds", { ascending: true }),
    supabase.from("asset_document_chunks").select("*").in("asset_id", ids).order("chunk_index", { ascending: true }),
    supabase.from("asset_human_metadata").select("*").in("asset_id", ids),
    supabase.from("asset_analysis_jobs").select("*").in("asset_id", ids).order("created_at", { ascending: false }).limit(Math.min(400, ids.length * 3)),
    supabase.from("asset_relations").select("*").eq("room_id", roomId).limit(500),
  ]);
  const firstError = [analysisResult, regionsResult, segmentsResult, chunksResult, humanResult, jobsResult, relationsResult].find((result) => result.error)?.error;
  if (firstError) throw firstError;

  const analyses = new Map((analysisResult.data ?? []).map((item) => [text(row(item).asset_id), analysisFromRow(item)]));
  const regions = new Map<string, ReturnType<typeof normalizeAssetRegion>[]>();
  for (const item of regionsResult.data ?? []) {
    const value = row(item);
    const normalized = normalizeAssetRegion({
      id: value.id,
      type: value.region_type,
      label: value.label,
      text: value.text_content,
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      confidence: value.confidence,
    });
    if (!normalized) continue;
    const id = text(value.asset_id);
    regions.set(id, [...(regions.get(id) ?? []), normalized]);
  }
  const segments = new Map<string, AssetVideoSegment[]>();
  for (const item of segmentsResult.data ?? []) {
    const value = segmentFromRow(item);
    segments.set(value.assetId, [...(segments.get(value.assetId) ?? []), value]);
  }
  const chunks = new Map<string, AssetDocumentChunk[]>();
  for (const item of chunksResult.data ?? []) {
    const value = chunkFromRow(item);
    chunks.set(value.assetId, [...(chunks.get(value.assetId) ?? []), value]);
  }
  const humans = new Map((humanResult.data ?? []).map((item) => [text(row(item).asset_id), humanFromRow(item)]));
  const jobs = (jobsResult.data ?? []).map(jobFromRow);
  const latestJob = new Map<string, AssetAnalysisJob>();
  for (const job of jobs) if (!latestJob.has(job.assetId)) latestJob.set(job.assetId, job);
  for (const asset of assets) {
    asset.analysis = analyses.get(asset.id);
    asset.regions = (regions.get(asset.id) ?? []).filter((item): item is NonNullable<typeof item> => Boolean(item));
    asset.videoSegments = segments.get(asset.id) ?? [];
    asset.documentChunks = chunks.get(asset.id) ?? [];
    asset.human = humans.get(asset.id);
    const job = latestJob.get(asset.id);
    if (job && (job.status === "processing" || job.status === "queued")) asset.status = "processing";
    fillLocalUnderstanding(asset);
  }
  return { assets, jobs, relations: (relationsResult.data ?? []).map(relationFromRow) };
}

/**
 * Client-side document / video understanding for assets that already have
 * text or duration but no persisted chunks/segments yet. Original media is
 * never fetched or rewritten.
 */
function fillLocalUnderstanding(asset: IntelligentAsset): void {
  const extracted = typeof asset.metadata.extracted_text === "string"
    ? PdfReader.extractText(asset.metadata.extracted_text)
    : "";
  const textContent = (asset.analysis?.detectedText || asset.human?.summary || extracted).trim();
  if (!asset.documentChunks.length && textContent) {
    const { chunks } = new DocumentUnderstandingProvider().understand({
      assetId: asset.id,
      title: asset.title,
      mimeType: asset.mimeType,
      textContent,
    });
    asset.documentChunks = chunks.map((chunk) => ({
      id: `local-chunk-${asset.id}-${chunk.chunk_index}`,
      assetId: chunk.asset_id,
      chunkIndex: chunk.chunk_index,
      content: chunk.content,
      startOffset: chunk.start_offset,
      endOffset: chunk.end_offset,
    }));
  }
  if (!asset.videoSegments.length && (asset.assetType === "video" || (asset.mimeType ?? "").startsWith("video/"))) {
    const duration = number(asset.metadata.duration_seconds ?? asset.metadata.duration, 0);
    const { segments } = new VideoUnderstandingProvider().understand({
      assetId: asset.id,
      title: asset.title,
      duration_seconds: duration,
      transcript: asset.analysis?.detectedText,
    });
    asset.videoSegments = segments.map((segment, index) => ({
      id: `local-seg-${asset.id}-${index}`,
      assetId: segment.asset_id,
      startSeconds: segment.start_seconds,
      endSeconds: segment.end_seconds,
      summary: segment.summary,
      transcript: segment.transcript,
      topics: segment.topics,
      detectedText: segment.detected_text,
    }));
  }
}

export async function registerIntelligentAsset(supabase: SupabaseClient, input: RegisterAssetInput): Promise<IntelligentAsset> {
  const userId = await ensureSession(supabase);
  // A version is a distinct reviewable asset even when its bytes match another
  // version. Standalone imports can still use their content hash as the
  // idempotency key, while version-linked assets retain separate provenance
  // and let the analysis worker reuse the sibling result safely.
  const sourceKey = input.versionId
    ? `version:${input.versionId}`
    : input.contentHash
      ? `hash:${input.contentHash}`
      : crypto.randomUUID();
  const { data, error } = await supabase
    .from("intelligent_assets")
    .insert({
      room_id: input.roomId,
      branch_id: input.branchId ?? null,
      version_id: input.versionId ?? null,
      asset_type: input.assetType,
      title: input.title.trim().slice(0, 240),
      original_filename: input.originalFilename ?? null,
      mime_type: input.mimeType ?? null,
      storage_path: input.storagePath ?? null,
      source: input.source ?? "upload",
      content_hash: input.contentHash ?? null,
      source_key: sourceKey,
      created_by: userId,
      metadata: input.metadata ?? {},
    })
    .select(ASSET_SELECT)
    .single();
  if (error) throw error;
  return assetFromRow(data, undefined, []);
}

function throwInvokeError(error: unknown): never {
  if (looksLikeSpaHtml(null, invokeErrorContentType(error))) {
    throw Object.assign(new Error("SPA_HTML"), { code: "SPA_HTML" });
  }
  throw error instanceof Error ? error : Object.assign(new Error("FUNCTION_ERROR"), { cause: error });
}

export async function enqueueAssetAnalysis(supabase: SupabaseClient, assetId: string, tier: 0 | 1 | 2 | 3 = 1): Promise<void> {
  const { data, error } = await supabase.functions.invoke("asset-analysis", { body: { assetId, action: "enqueue", tier } });
  if (error) throwInvokeError(error);
  acceptAssetAnalysisPayload(data);
}

export async function retryAssetAnalysis(supabase: SupabaseClient, assetId: string, tier: 0 | 1 | 2 | 3 = 1): Promise<void> {
  const { data, error } = await supabase.functions.invoke("asset-analysis", { body: { assetId, action: "retry", tier } });
  if (error) throwInvokeError(error);
  acceptAssetAnalysisPayload(data);
}

export async function setHumanAssetMetadata(
  supabase: SupabaseClient,
  input: { assetId: string; roomId: string; title?: string; summary?: string; tags?: string[]; structuredData?: Record<string, unknown> },
): Promise<void> {
  const userId = await ensureSession(supabase);
  const { error } = await supabase.from("asset_human_metadata").upsert({
    asset_id: input.assetId,
    room_id: input.roomId,
    title: input.title?.trim() || null,
    summary: input.summary?.trim() || null,
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 30),
    structured_data: input.structuredData ?? {},
    updated_by: userId,
  }, { onConflict: "asset_id" });
  if (error) throw error;
}

/**
 * AI policy is deliberately separate from human metadata. Database RLS limits
 * this mutation to owner/editor roles; reviewers can see the current policy
 * but cannot change where an asset's contents may go.
 */
export async function setAssetAiPolicy(
  supabase: SupabaseClient,
  input: { assetId: string; aiReadable: boolean; externalAiAllowed: boolean },
): Promise<void> {
  await ensureSession(supabase);
  const { error } = await supabase.from("intelligent_assets").update({
    ai_readable: input.aiReadable,
    external_ai_allowed: input.aiReadable ? input.externalAiAllowed : false,
  }).eq("id", input.assetId);
  if (error) throw error;
}

export async function createAssetRelation(
  supabase: SupabaseClient,
  input: { roomId: string; sourceAssetId: string; targetAssetId: string; relationType: AssetRelationType },
): Promise<AssetRelation> {
  const userId = await ensureSession(supabase);
  const { data, error } = await supabase.from("asset_relations").insert({
    room_id: input.roomId,
    source_asset_id: input.sourceAssetId,
    target_asset_id: input.targetAssetId,
    relation_type: input.relationType,
    created_by: userId,
  }).select("*").single();
  if (error) throw error;
  return relationFromRow(data);
}

export async function removeAssetRelation(supabase: SupabaseClient, relationId: string): Promise<void> {
  const { error } = await supabase.from("asset_relations").delete().eq("id", relationId);
  if (error) throw error;
}

/**
 * Context is cached after the server has applied membership and AI-readability
 * filters. The cache key includes analysis versions so re-analysis invalidates
 * stale answers without ever caching Storage bytes.
 */
export async function askRoomContext(
  supabase: SupabaseClient,
  roomId: string,
  request: RoomContextRequest,
  analysisVersions: string[] = [],
): Promise<RoomContextResponse> {
  const key = contextCacheKey(roomId, request, analysisVersions);
  const cached = await loadAiContext(key).catch(() => undefined);
  if (cached) return { ...cached, cached: true };
  const { data, error } = await supabase.functions.invoke("room-ai-context", { body: { roomId, ...request } });
  if (error) throwInvokeError(error);
  const parsed = parseFunctionPayload(data);
  if (parsed.kind === "reject") {
    throw Object.assign(new Error(parsed.code), { code: parsed.code });
  }
  if (typeof parsed.value.error === "string" && parsed.value.error) {
    throw Object.assign(new Error(parsed.value.error), { code: parsed.value.error });
  }
  const response = sanitizeRoomAnswer(request.query, assertResponse(parsed.value));
  await saveAiContext(key, response).catch(() => undefined);
  return response;
}

function sanitizeRoomAnswer(query: string, response: RoomContextResponse): RoomContextResponse {
  if (!response.answer) return response;
  const shaped = answerDuigaoRoomContext(
    { query, context: response.context, sources: response.sources, relations: response.relations },
    { text: response.answer.text, citations: response.answer.citations, actions: response.answer.actions },
  );
  if (!shaped) return { ...response, answer: null };
  return {
    ...response,
    answer: {
      ...response.answer,
      text: shaped.text,
      actions: shaped.actions.flatMap((action) => {
        if (action.type !== "create_comment" && action.type !== "create_poll" && action.type !== "create_plan_draft" && action.type !== "add_whiteboard_node") return [];
        return [{ type: action.type, label: action.label, payload: action.payload ?? {} }];
      }),
    },
  };
}

export function subscribeAssetAnalysis(
  supabase: SupabaseClient,
  roomId: string,
  onStatus: (value: { assetId: string; status: AssetStatus; progress?: number }) => void,
): () => void {
  if (!isCloudConfigured) return () => undefined;
  const channel = supabase.channel(`asset-intelligence:${roomId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "intelligent_assets", filter: `room_id=eq.${roomId}` }, (payload) => {
      const value = row(payload.new);
      onStatus({ assetId: text(value.id), status: enumValue(value.status, ASSET_STATUSES, "pending") as AssetStatus });
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "asset_analysis_jobs", filter: `room_id=eq.${roomId}` }, (payload) => {
      const value = row(payload.new);
      onStatus({ assetId: text(value.asset_id), status: enumValue(value.status, ASSET_STATUSES, "processing") as AssetStatus, progress: number(value.progress) });
    })
    .subscribe();
  return () => { void supabase.removeChannel(channel); };
}

export { getSupabase };
