import type { BranchType, RoomBranch, Version } from "./types";

export const ASSET_TYPES = [
  "image",
  "video",
  "audio",
  "document",
  "plan",
  "whiteboard",
  "canva",
  "link",
  "other",
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_STATUSES = ["pending", "processing", "ready", "partial", "failed"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const ANALYSIS_JOB_STATUSES = ["queued", "processing", "completed", "failed", "cancelled"] as const;
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUSES)[number];

export type AnalysisErrorCode =
  | "UNSUPPORTED_FORMAT"
  | "PROVIDER_UNAVAILABLE"
  | "FILE_TOO_LARGE"
  | "TRANSCRIPT_FAILED"
  | "OCR_FAILED"
  | "PERMISSION_DENIED"
  | "EXTERNAL_AI_BLOCKED"
  | "ANALYSIS_TIMEOUT";

export type NormalizedAssetRegion = {
  id?: string;
  type: string;
  label: string;
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
};

export type AssetAnalysis = {
  assetId: string;
  summary: string;
  detectedText: string;
  topics: string[];
  keywords: string[];
  language?: string;
  contentType?: string;
  confidence?: number;
  structuredData: Record<string, unknown>;
  modelName?: string;
  modelVersion?: string;
  updatedAt: string;
};

export type AssetVideoSegment = {
  id: string;
  assetId: string;
  startSeconds: number;
  endSeconds: number;
  summary: string;
  transcript: string;
  topics: string[];
  detectedText: string;
  sceneType?: string;
  confidence?: number;
};

export type AssetDocumentChunk = {
  id: string;
  assetId: string;
  chunkIndex: number;
  content: string;
  page?: number;
  section?: string;
  heading?: string;
  startOffset?: number;
  endOffset?: number;
};

export type AssetHumanMetadata = {
  assetId: string;
  title?: string;
  summary?: string;
  tags: string[];
  structuredData: Record<string, unknown>;
  updatedAt: string;
};

export type IntelligentAsset = {
  id: string;
  roomId: string;
  branchId?: string;
  versionId?: string;
  assetType: AssetType;
  title: string;
  originalFilename?: string;
  mimeType?: string;
  /** Kept for owner/editor maintenance only. Never put this into agent context. */
  storagePath?: string;
  source: "upload" | "generated" | "canva" | "room" | "external";
  status: AssetStatus;
  analysisVersion: string;
  analysisProvider?: string;
  analysisUpdatedAt?: string;
  aiReadable: boolean;
  externalAiAllowed: boolean;
  contentHash?: string;
  metadata: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  analysis?: AssetAnalysis;
  regions: NormalizedAssetRegion[];
  videoSegments: AssetVideoSegment[];
  documentChunks: AssetDocumentChunk[];
  human?: AssetHumanMetadata;
  latestVersion?: {
    id: string;
    label: string;
    sortOrder: number;
    archived: boolean;
  };
};

export type AssetAnalysisJob = {
  id: string;
  assetId: string;
  roomId: string;
  tier: 0 | 1 | 2 | 3;
  status: AnalysisJobStatus;
  progress: number;
  stage: string;
  errorCode?: AnalysisErrorCode | string;
  retryCount: number;
  provider?: string;
  model?: string;
  estimatedCost?: number;
  processingMs?: number;
  analysisVersion: string;
  createdAt: string;
  updatedAt: string;
};

export type AssetRelationType =
  | "related_to"
  | "used_by"
  | "derived_from"
  | "supports"
  | "references"
  | "same_campaign"
  | "same_branch"
  | "version_of";

export type AssetRelation = {
  id: string;
  roomId: string;
  sourceAssetId: string;
  targetAssetId: string;
  relationType: AssetRelationType;
  createdBy?: string;
  createdAt: string;
};

export type RoomContextRequest = {
  query: string;
  selectedAssetIds?: string[];
  selectedBranchIds?: string[];
  selectedVersionIds?: string[];
  timeRange?: { startSeconds: number; endSeconds: number } | null;
  imagineVideoConfirmed?: boolean;
  focus?: { branchId?: string; versionId?: string };
};

export type ImageCitationLocator = {
  kind: "image-region";
  versionId?: string;
  region: NormalizedAssetRegion;
};

export type VideoCitationLocator = {
  kind: "video-segment";
  versionId?: string;
  startSeconds: number;
  endSeconds: number;
};

export type DocumentCitationLocator = {
  kind: "document" | "plan" | "whiteboard";
  page?: number;
  section?: string;
  blockId?: string;
};

export type ContextCitation = {
  sourceId: string;
  assetId?: string;
  title: string;
  assetType?: AssetType;
  branchId?: string;
  versionId?: string;
  versionLabel?: string;
  excerpt?: string;
  locator?: ImageCitationLocator | VideoCitationLocator | DocumentCitationLocator;
};

export type RoomContextItem = {
  sourceId: string;
  assetId: string;
  title: string;
  assetType: AssetType;
  branchId?: string;
  branchName?: string;
  versionId?: string;
  versionLabel?: string;
  versionOrder?: number;
  isCurrent: boolean;
  archived: boolean;
  summary?: string;
  detectedText?: string;
  topics: string[];
  keywords: string[];
  regions?: NormalizedAssetRegion[];
  segments?: AssetVideoSegment[];
  chunks?: AssetDocumentChunk[];
  humanOverride?: { title?: string; summary?: string; tags: string[] };
};

export type RoomContextAnswer = {
  text: string;
  citations: ContextCitation[];
  actions: Array<{
    type:
      | "create_comment"
      | "create_poll"
      | "create_plan_draft"
      | "add_whiteboard_node"
      | "propose_edit_text"
      | "propose_add_shape"
      | "propose_move_item"
      | "propose_add_image"
      | "imagine_image"
      | "imagine_video"
      | "refuse_with_reason";
    label: string;
    payload: Record<string, unknown>;
  }>;
  provider?: string;
  model?: string;
};

export type RoomContextResponse = {
  room: { id: string; title: string };
  query: string;
  context: RoomContextItem[];
  sources: ContextCitation[];
  relations: Array<{
    sourceId: string;
    targetId: string;
    relationType: AssetRelationType | "branch-related";
  }>;
  permissions: {
    role: "owner" | "editor" | "reviewer" | "member";
    canAsk: boolean;
    selectedCount: number;
  };
  truncated: boolean;
  answer: RoomContextAnswer | null;
  agent?: { provider: "tku-zen-agent" | "ai_os" | "grok-room-agent" | "none"; status: string };
  cached?: boolean;
};

export type RoomContextFocus = {
  assetId: string;
  branchId?: string;
  versionId?: string;
  locator?: ContextCitation["locator"];
};

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  image: "圖片",
  video: "影片",
  audio: "音訊",
  document: "文件",
  plan: "企劃",
  whiteboard: "白板",
  canva: "Canva",
  link: "連結",
  other: "素材",
};

export const ANALYSIS_STATUS_LABEL: Record<AssetStatus, string> = {
  pending: "等待理解",
  processing: "AI 正在理解",
  ready: "已理解",
  partial: "部分理解",
  failed: "理解失敗",
};

export const ANALYSIS_ERROR_LABEL: Record<string, string> = {
  UNSUPPORTED_FORMAT: "這種檔案格式目前還不能理解",
  PROVIDER_UNAVAILABLE: "理解服務暫時忙碌，稍後可重試",
  FILE_TOO_LARGE: "檔案太大，請先縮小再分析",
  TRANSCRIPT_FAILED: "影片／音訊逐字稿沒有完成，但原檔仍可使用",
  OCR_FAILED: "文字辨識沒有完成，但原稿沒有被改動",
  PERMISSION_DENIED: "目前沒有權限讀取這份素材",
  EXTERNAL_AI_BLOCKED: "這份素材禁止送到外部 AI",
  AI_READABLE_DISABLED: "這份素材目前未允許 AI 讀取",
  ANALYSIS_TIMEOUT: "分析逾時，稍後可以重試",
};

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function normalizeAssetRegion(raw: unknown): NormalizedAssetRegion | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const x = clamp01(Number(value.x));
  const y = clamp01(Number(value.y));
  const width = clamp01(Number(value.width));
  const height = clamp01(Number(value.height));
  const boundedWidth = Math.min(width, 1 - x);
  const boundedHeight = Math.min(height, 1 - y);
  if (boundedWidth <= 0 || boundedHeight <= 0) return null;
  const confidence = value.confidence == null ? undefined : clamp01(Number(value.confidence));
  return {
    ...(typeof value.id === "string" && value.id.trim() ? { id: value.id.trim() } : {}),
    type: typeof value.type === "string" && value.type.trim() ? value.type.trim() : "other",
    label: typeof value.label === "string" ? value.label.trim() : "",
    ...(typeof value.text === "string" && value.text.trim() ? { text: value.text.trim() } : {}),
    x,
    y,
    width: boundedWidth,
    height: boundedHeight,
    ...(confidence == null ? {} : { confidence }),
  };
}

export function isNormalizedAssetRegion(value: unknown): value is NormalizedAssetRegion {
  const region = normalizeAssetRegion(value);
  return Boolean(region && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
}

export function branchTypeForAsset(assetType: AssetType): BranchType | undefined {
  if (assetType === "image") return "poster";
  if (assetType === "video") return "video";
  if (assetType === "plan") return "plan";
  return undefined;
}

export function assetLabel(asset: Pick<IntelligentAsset, "title" | "human">): string {
  return asset.human?.title?.trim() || asset.title;
}

export function latestVersionForBranch(versions: Version[], branchId: string): Version | undefined {
  // `loadBranch` preserves the database `sort_order` ordering, while the
  // legacy Version type intentionally does not expose that storage detail.
  // Keep the last active row instead of inventing a client-side order field.
  return versions.filter((version) => version.branchId === branchId && !version.archivedAt).at(-1);
}

/**
 * Choose current assets without ever treating an archived version as current.
 * The database owns sort_order; callers should pass the version rows in their
 * original order when an old client has no explicit sortOrder field.
 */
export function preferCurrentAssets(
  assets: IntelligentAsset[],
  versions: Version[],
  explicitVersionIds: string[] = [],
): IntelligentAsset[] {
  const selected = new Set(explicitVersionIds);
  const currentByBranch = new Map<string, string>();
  const branchVersions = new Map<string, Version[]>();
  for (const version of versions) {
    if (!version.branchId || version.archivedAt) continue;
    const list = branchVersions.get(version.branchId) ?? [];
    list.push(version);
    branchVersions.set(version.branchId, list);
  }
  for (const [branchId, list] of branchVersions) currentByBranch.set(branchId, list.at(-1)!.id);
  return assets.filter((asset) => {
    if (asset.versionId && selected.has(asset.versionId)) return true;
    if (!asset.versionId || !asset.branchId) return true;
    const version = versions.find((item) => item.id === asset.versionId);
    if (!version || version.archivedAt) return false;
    return currentByBranch.get(asset.branchId) === asset.versionId;
  });
}

function lexicalTokens(value: string): string[] {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  const chars = [...normalized.replace(/\s/g, "")];
  const bigrams = chars.length > 1 ? chars.slice(0, -1).map((char, index) => char + chars[index + 1]) : [];
  return [...new Set([...words, ...bigrams])];
}

export function scoreAssetText(query: string, item: Pick<RoomContextItem, "title" | "summary" | "detectedText" | "topics" | "keywords">): number {
  const queryTokens = lexicalTokens(query);
  if (!queryTokens.length) return 0;
  const target = lexicalTokens([
    item.title,
    item.summary ?? "",
    item.detectedText ?? "",
    ...item.topics,
    ...item.keywords,
  ].join(" "));
  const set = new Set(target);
  const matches = queryTokens.reduce((count, token) => count + (set.has(token) ? 1 : 0), 0);
  const exact = item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? 2 : 0;
  return exact + matches / queryTokens.length;
}

export function rankContextItems(query: string, items: RoomContextItem[], limit = 12): RoomContextItem[] {
  return [...items]
    .map((item, index) => ({ item, score: scoreAssetText(query, item), index }))
    .sort((a, b) => b.score - a.score || Number(b.item.isCurrent) - Number(a.item.isCurrent) || a.index - b.index)
    .slice(0, Math.max(1, limit))
    .map(({ item }) => item);
}

/** Return only timeline evidence that intersects the requested video window. */
export function segmentsInRange(
  segments: AssetVideoSegment[],
  range: { startSeconds: number; endSeconds: number } | null | undefined,
): AssetVideoSegment[] {
  if (!range) return [...segments];
  const start = Math.max(0, Math.min(range.startSeconds, range.endSeconds));
  const end = Math.max(start, Math.max(range.startSeconds, range.endSeconds));
  return segments.filter((segment) => segment.endSeconds >= start && segment.startSeconds <= end);
}

export function formatSeconds(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function contextCacheKey(roomId: string, request: RoomContextRequest, analysisVersions: string[] = []): string {
  return JSON.stringify({
    roomId,
    query: request.query.trim(),
    selectedAssetIds: [...(request.selectedAssetIds ?? [])].sort(),
    selectedBranchIds: [...(request.selectedBranchIds ?? [])].sort(),
    selectedVersionIds: [...(request.selectedVersionIds ?? [])].sort(),
    timeRange: request.timeRange ?? null,
    analysisVersions: [...analysisVersions].sort(),
  });
}

export function safeAgentErrorCode(value: unknown): AnalysisErrorCode | undefined {
  return typeof value === "string" && value in ANALYSIS_ERROR_LABEL ? value as AnalysisErrorCode : undefined;
}

export function branchName(branches: RoomBranch[] | undefined, branchId: string | undefined): string | undefined {
  return branchId ? branches?.find((branch) => branch.id === branchId)?.name : undefined;
}
