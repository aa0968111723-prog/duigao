export type SafeRegion = {
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

export type SafeSegment = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  summary: string;
  transcript: string;
  topics: string[];
  detectedText: string;
  sceneType?: string;
  confidence?: number;
};

export type SafeChunk = {
  id: string;
  chunkIndex: number;
  content: string;
  page?: number;
  section?: string;
  heading?: string;
  startOffset?: number;
  endOffset?: number;
};

export type SafeAsset = {
  sourceId: string;
  assetId: string;
  title: string;
  assetType: string;
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
  structuredData?: Record<string, unknown>;
  regions?: SafeRegion[];
  segments?: SafeSegment[];
  chunks?: SafeChunk[];
  humanOverride?: { title?: string; summary?: string; tags: string[] };
};

export type ContextCitation = {
  sourceId: string;
  assetId?: string;
  title: string;
  assetType?: string;
  branchId?: string;
  versionId?: string;
  versionLabel?: string;
  excerpt?: string;
  locator?: Record<string, unknown>;
};

export type RoomContextPayload = {
  room: { id: string; title: string };
  query: string;
  context: SafeAsset[];
  sources: ContextCitation[];
  relations: Array<{ sourceId: string; targetId: string; relationType: string }>;
  permissions: { role: string; canAsk: boolean; selectedCount: number };
  truncated: boolean;
};

export type AgentAnswer = {
  text: string;
  citations: ContextCitation[];
  actions: Array<{ type: string; label: string; payload: Record<string, unknown> }>;
  provider?: string;
  model?: string;
};

const FORBIDDEN_KEYS = new Set([
  "storage_path", "storagePath", "invite_hash", "inviteHash", "invite", "invite_token",
  "inviteToken", "service_role", "serviceRole", "access_token", "accessToken", "signed_url",
  "signedUrl", "data_url", "dataUrl", "binary", "bytes",
]);

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function stringList(value: unknown, limit = 30): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim().slice(0, 200)).slice(0, limit)
    : [];
}

function boundStructuredValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.slice(0, 5000);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 3) return "[結構資料已省略]";
  if (Array.isArray(value)) return value.slice(0, 120).map((item) => boundStructuredValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, child]) => [key, boundStructuredValue(child, depth + 1)]));
}

export function boundedStructuredData(value: unknown): Record<string, unknown> {
  return asObject(boundStructuredValue(stripSecrets(asObject(value))));
}

export function clamp01(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(1, numeric));
}

export function sanitizeRegion(value: unknown): SafeRegion | null {
  const raw = asObject(value);
  const x = clamp01(raw.x);
  const y = clamp01(raw.y);
  const width = Math.min(clamp01(raw.width), 1 - x);
  const height = Math.min(clamp01(raw.height), 1 - y);
  if (width <= 0 || height <= 0) return null;
  return {
    ...(asText(raw.id) ? { id: asText(raw.id).slice(0, 120) } : {}),
    type: asText(raw.type, "other").slice(0, 80),
    label: asText(raw.label).slice(0, 160),
    ...(asText(raw.text).trim() ? { text: asText(raw.text).slice(0, 1000) } : {}),
    x, y, width, height,
    ...(raw.confidence == null ? {} : { confidence: clamp01(raw.confidence) }),
  };
}

/** Deep-strip values that must never cross the agent boundary. */
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key) || /invite|service.?role|access.?token|signed.?url|data.?url|binary|bytes/i.test(key)) continue;
    out[key] = stripSecrets(child);
  }
  return out as T;
}

export function safeExcerpt(value: unknown, max = 900): string | undefined {
  const cleaned = asText(value).replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

export function tokenise(value: string): string[] {
  const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, " ");
  const words = normalized.split(/\s+/).filter(Boolean);
  const chars = [...normalized.replace(/\s/g, "")];
  const bigrams = chars.length > 1 ? chars.slice(0, -1).map((char, index) => char + chars[index + 1]) : [];
  return [...new Set([...words, ...bigrams])];
}

export function score(query: string, asset: SafeAsset): number {
  const queryTokens = tokenise(query);
  if (!queryTokens.length) return 0;
  const target = new Set(tokenise([
    asset.title, asset.summary ?? "", asset.detectedText ?? "", ...asset.topics, ...asset.keywords,
    ...(asset.segments ?? []).flatMap((segment) => [segment.summary, segment.transcript, ...segment.topics]),
    ...(asset.chunks ?? []).map((chunk) => `${chunk.heading ?? ""} ${chunk.content}`),
  ].join(" ")));
  const matches = queryTokens.reduce((count, token) => count + (target.has(token) ? 1 : 0), 0);
  return (asset.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ? 3 : 0)
    + matches / queryTokens.length
    + (asset.isCurrent ? 0.15 : 0);
}

export function sourceForAsset(asset: SafeAsset): ContextCitation {
  return stripSecrets({
    sourceId: asset.sourceId,
    assetId: asset.assetId,
    title: asset.title,
    assetType: asset.assetType,
    branchId: asset.branchId,
    versionId: asset.versionId,
    versionLabel: asset.versionLabel,
    excerpt: safeExcerpt(asset.summary || asset.detectedText),
  });
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function closeEnough(left: number, right: number, tolerance = 0.01): boolean {
  return Math.abs(left - right) <= tolerance;
}

/**
 * Turn an agent-provided locator into one backed by evidence in this request.
 * A source id alone is not enough: otherwise a model could invent a focus
 * rectangle or timestamp that the client would blindly navigate to.
 */
export function safeAgentLocator(value: unknown, asset: SafeAsset): Record<string, unknown> | undefined {
  const raw = asObject(value);
  const kind = asText(raw.kind || raw.type).trim().toLowerCase();
  if (asset.assetType === "video" && (kind === "video-segment" || !kind)) {
    const start = finiteNumber(raw.startSeconds ?? raw.start_seconds);
    const end = finiteNumber(raw.endSeconds ?? raw.end_seconds);
    const segmentId = asText(raw.segmentId || raw.segment_id || raw.id);
    const segment = (asset.segments ?? []).find((candidate) => {
      if (segmentId && candidate.id === segmentId) return true;
      return start != null && end != null
        && closeEnough(candidate.startSeconds, Math.max(0, start), 0.25)
        && closeEnough(candidate.endSeconds, Math.max(candidate.startSeconds, end), 0.25);
    });
    if (!segment) return undefined;
    return { kind: "video-segment", startSeconds: segment.startSeconds, endSeconds: segment.endSeconds };
  }

  if ((asset.assetType === "image" || asset.assetType === "canva") && (kind === "image-region" || kind === "region" || !kind)) {
    const regionValue = Object.keys(asObject(raw.region)).length ? asObject(raw.region) : raw;
    const regionId = asText(regionValue.regionId || regionValue.region_id || regionValue.id);
    const x = finiteNumber(regionValue.x);
    const y = finiteNumber(regionValue.y);
    const width = finiteNumber(regionValue.width);
    const height = finiteNumber(regionValue.height);
    const region = (asset.regions ?? []).find((candidate) => {
      if (regionId && candidate.id === regionId) return true;
      return x != null && y != null && width != null && height != null
        && closeEnough(candidate.x, x) && closeEnough(candidate.y, y)
        && closeEnough(candidate.width, width) && closeEnough(candidate.height, height);
    });
    if (!region) return undefined;
    return { kind: "image-region", region: stripSecrets(region) };
  }

  if (asset.assetType === "document" || asset.assetType === "plan" || asset.assetType === "whiteboard") {
    const expectedKind = asset.assetType;
    if (kind && kind !== expectedKind && !(expectedKind === "plan" && kind === "document")) return undefined;
    const page = finiteNumber(raw.page);
    const section = asText(raw.section).trim().slice(0, 200);
    const blockId = asText(raw.blockId || raw.block_id).trim().slice(0, 120);
    if (page != null && asset.assetType !== "whiteboard") {
      const pageNumber = Math.max(1, Math.floor(page));
      if (!(asset.chunks ?? []).some((chunk) => chunk.page === pageNumber)) return undefined;
      return { kind: expectedKind, page: pageNumber, ...(section ? { section } : {}) };
    }
    if (section && !(asset.chunks ?? []).some((chunk) => chunk.section === section || chunk.heading === section)) return undefined;
    if (blockId && asset.assetType !== "whiteboard") return undefined;
    if (asset.assetType === "whiteboard") {
      if (!blockId) return undefined;
      const nodes = Array.isArray(asset.structuredData?.nodes) ? asset.structuredData.nodes : [];
      if (!nodes.some((node) => asText(asObject(node).id) === blockId)) return undefined;
    }
    return { kind: expectedKind, ...(section ? { section } : {}), ...(blockId ? { blockId } : {}) };
  }

  return undefined;
}

export function safeAgentCitations(
  value: unknown,
  known: Map<string, ContextCitation>,
  assets: Map<string, SafeAsset> = new Map(),
): ContextCitation[] {
  if (!Array.isArray(value)) return [];
  const result: ContextCitation[] = [];
  for (const item of value.slice(0, 8)) {
    const raw = asObject(item);
    const sourceId = asText(raw.sourceId || raw.source_id);
    const original = known.get(sourceId);
    if (!original) continue;
    const asset = assets.get(sourceId);
    const locator = asset ? safeAgentLocator(raw.locator, asset) : undefined;
    result.push(stripSecrets({
      ...original,
      ...(safeExcerpt(raw.excerpt, 600) ? { excerpt: safeExcerpt(raw.excerpt, 600) } : {}),
      ...(locator ? { locator } : {}),
    }));
  }
  return result;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

export async function hmacSignature(body: string, timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(signed)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
