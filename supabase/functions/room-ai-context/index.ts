import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  asObject,
  asText,
  boundedStructuredData,
  jsonResponse,
  safeAgentCitations,
  safeExcerpt,
  score,
  sourceForAsset,
  stripSecrets,
  stringList,
  type ContextCitation,
  type AgentAnswer,
  type RoomContextPayload,
  type SafeAsset,
  type SafeChunk,
  type SafeRegion,
  type SafeSegment,
} from "../_shared/roomContext.ts";

type Row = Record<string, unknown>;

const MAX_ASSETS = 160;
const MAX_CONTEXT = 12;
const MAX_DISCUSSION_CHARS = 4000;

function row(value: unknown): Row {
  return value && typeof value === "object" ? value as Row : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optional(value: unknown): string | undefined {
  const result = text(value).trim();
  return result ? result : undefined;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function scrubText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/gi, "[連結已省略]")
    .replace(/(?:invite|access[_-]?token|service[_-]?role)[=:][^\s,;]+/gi, "[機密已省略]")
    .slice(0, 5000);
}

function analysisFor(raw: unknown): { summary: string; detectedText: string; topics: string[]; keywords: string[]; structured: Row } {
  const value = row(raw);
  return {
    summary: scrubText(text(value.summary)),
    detectedText: scrubText(text(value.detected_text)),
    topics: stringList(value.topics),
    keywords: stringList(value.keywords),
    structured: boundedStructuredData(value.structured_data),
  };
}

function safeRegion(raw: unknown): SafeRegion | null {
  const value = row(raw);
  const x = Math.max(0, Math.min(1, num(value.x)));
  const y = Math.max(0, Math.min(1, num(value.y)));
  const width = Math.min(Math.max(0, Math.min(1, num(value.width))), 1 - x);
  const height = Math.min(Math.max(0, Math.min(1, num(value.height))), 1 - y);
  if (width <= 0 || height <= 0) return null;
  return {
    ...(text(value.id) ? { id: text(value.id).slice(0, 120) } : {}),
    type: text(value.region_type, "other").slice(0, 80),
    label: text(value.label).slice(0, 160),
    ...(text(value.text_content).trim() ? { text: scrubText(text(value.text_content)).slice(0, 1000) } : {}),
    x, y, width, height,
    ...(value.confidence == null ? {} : { confidence: Math.max(0, Math.min(1, num(value.confidence))) }),
  };
}

function safeSegment(raw: unknown): SafeSegment {
  const value = row(raw);
  return {
    id: text(value.id),
    startSeconds: Math.max(0, num(value.start_seconds)),
    endSeconds: Math.max(0, num(value.end_seconds)),
    summary: scrubText(text(value.summary)),
    transcript: scrubText(text(value.transcript)),
    topics: stringList(value.topics),
    detectedText: scrubText(text(value.detected_text)),
    sceneType: optional(value.scene_type),
    confidence: value.confidence == null ? undefined : Math.max(0, Math.min(1, num(value.confidence))),
  };
}

function safeChunk(raw: unknown): SafeChunk {
  const value = row(raw);
  return {
    id: text(value.id),
    chunkIndex: Math.max(0, Math.floor(num(value.chunk_index))),
    content: scrubText(text(value.content)).slice(0, 4000),
    page: value.page == null ? undefined : Math.max(1, Math.floor(num(value.page))),
    section: optional(value.section),
    heading: optional(value.heading),
    startOffset: value.start_offset == null ? undefined : Math.max(0, Math.floor(num(value.start_offset))),
    endOffset: value.end_offset == null ? undefined : Math.max(0, Math.floor(num(value.end_offset))),
  };
}

function blockText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = row(item);
    const prefix = block.kind === "checklist" ? (bool(block.checked) ? "[x] " : "[ ] ") : "";
    const label = text(block.text);
    const url = block.kind === "link" && text(block.url) ? `（${text(block.url)}）` : "";
    return `${prefix}${label}${url}`.trim();
  }).filter(Boolean).join("\n");
}

function arrayRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(row) : [];
}

function uuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requestValue(value: unknown): { roomId: string; query: string; selectedAssetIds: string[]; selectedBranchIds: string[]; selectedVersionIds: string[]; timeRange: { startSeconds: number; endSeconds: number } | null } | null {
  const input = asObject(value);
  const roomId = text(input.roomId);
  const query = text(input.query).trim().slice(0, 2000);
  if (!uuidLike(roomId) || !query) return null;
  const range = asObject(input.timeRange);
  const start = Math.max(0, num(range.startSeconds));
  const end = Math.max(start, num(range.endSeconds));
  return {
    roomId,
    query,
    selectedAssetIds: stringList(input.selectedAssetIds, 20).filter(uuidLike),
    selectedBranchIds: stringList(input.selectedBranchIds, 20).filter(uuidLike),
    selectedVersionIds: stringList(input.selectedVersionIds, 20).filter(uuidLike),
    timeRange: range.startSeconds == null && range.endSeconds == null ? null : { startSeconds: start, endSeconds: end },
  };
}

function responseHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
  };
}

function providerEndpoint(): { provider: "tku-zen-agent" | "ai_os"; url: string; external: boolean } | null {
  const requested = (Deno.env.get("DUIGAO_AGENT_PROVIDER") || "tku-zen-agent").trim().toLowerCase();
  const provider = requested === "ai_os" ? "ai_os" : "tku-zen-agent";
  const base = (provider === "ai_os" ? Deno.env.get("AI_OS_AGENT_URL") : Deno.env.get("TKU_ZEN_AGENT_URL"))?.trim().replace(/\/$/, "");
  if (!base) return null;
  const url = base.includes("/api/")
    ? base
    : provider === "ai_os"
      ? `${base}/api/integrations/duigao/room-context`
      : `${base}/api/v1/room-context/answer`;
  return { provider, url, external: ["1", "true", "yes"].includes((Deno.env.get("DUIGAO_AGENT_PROVIDER_EXTERNAL") || "").toLowerCase()) };
}

async function signAgentRequest(body: string, timestamp: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function askAgent(payload: RoomContextPayload, known: Map<string, ContextCitation>): Promise<AgentAnswer | null> {
  const endpoint = providerEndpoint();
  const secret = (Deno.env.get("DUIGAO_AGENT_SHARED_SECRET") || "").trim();
  if (!endpoint || !secret) return null;
  const body = JSON.stringify({
    query: payload.query,
    context: payload.context,
    sources: payload.sources,
    relations: payload.relations,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signAgentRequest(body, timestamp, secret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-duigao-timestamp": timestamp,
        "x-duigao-signature": `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const raw = asObject(await response.json());
    // tku-zen-agent returns `{text, citations, actions}` while ai_os returns
    // `{answer, citations, actions}`. Keep the boundary provider-neutral and
    // never accept a free-form object as answer text.
    const answer = safeExcerpt(
      typeof raw.text === "string"
        ? raw.text
        : typeof raw.answer === "string"
          ? raw.answer
          : asText(asObject(raw.answer).text),
      5000,
    );
    if (!answer) return null;
    const allowedActions = new Set(["create_comment", "create_poll", "create_plan_draft", "add_whiteboard_node"]);
    const actions = Array.isArray(raw.actions)
      ? raw.actions.slice(0, 6).flatMap((item) => {
          const action = asObject(item);
          const type = text(action.type);
          const label = safeExcerpt(action.label, 120);
          if (!allowedActions.has(type) || !label) return [];
          return [{ type: type as "create_comment" | "create_poll" | "create_plan_draft" | "add_whiteboard_node", label, payload: stripSecrets(asObject(action.payload)) }];
        })
      : [];
    return {
      text: scrubText(answer),
      citations: safeAgentCitations(raw.citations, known, new Map(payload.context.map((asset) => [asset.sourceId, asset]))),
      actions,
      provider: endpoint.provider,
      model: safeExcerpt(raw.model, 120),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function handle(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders() });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: responseHeaders() });
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!token || !url || !anonKey) return jsonResponse({ error: "UNAUTHENTICATED" }, 401);
  const supabase = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData.user) return jsonResponse({ error: "UNAUTHENTICATED" }, 401);
  let rawBody: unknown;
  try { rawBody = await request.json(); } catch { return jsonResponse({ error: "INVALID_REQUEST" }, 400); }
  const input = requestValue(rawBody);
  if (!input) return jsonResponse({ error: "INVALID_REQUEST", message: "需要 roomId 與 query" }, 400);

  const [roomResult, membershipResult, branchResult, versionResult, assetResult, planResult, relationResult, contentRelationResult, commentsResult, messagesResult, pollsResult] = await Promise.all([
    supabase.from("rooms").select("id,title").eq("id", input.roomId).maybeSingle(),
    supabase.from("room_members").select("role").eq("room_id", input.roomId).eq("user_id", authData.user.id).maybeSingle(),
    supabase.from("room_branches").select("id,name,branch_type,status,sort_order,updated_at").eq("room_id", input.roomId).limit(120),
    supabase.from("versions").select("id,branch_id,label,sort_order,archived_at").eq("room_id", input.roomId).order("sort_order", { ascending: true }).limit(400),
    supabase.from("intelligent_assets").select("id,room_id,branch_id,version_id,asset_type,title,status,analysis_version,ai_readable,external_ai_allowed,metadata,updated_at").eq("room_id", input.roomId).eq("ai_readable", true).order("updated_at", { ascending: false }).limit(MAX_ASSETS),
    supabase.from("plan_documents").select("branch_id,title,description,blocks,updated_at").eq("room_id", input.roomId).limit(80),
    supabase.from("asset_relations").select("source_asset_id,target_asset_id,relation_type").eq("room_id", input.roomId).limit(500),
    supabase.from("content_relations").select("from_branch_id,to_branch_id,relation_type").eq("room_id", input.roomId).limit(200),
    supabase.from("comments").select("id,version_id,x,y,region,body,suggestion,problem_type,priority,resolved,created_at").eq("room_id", input.roomId).order("created_at", { ascending: false }).limit(80),
    supabase.from("messages").select("id,body,created_at").eq("room_id", input.roomId).order("created_at", { ascending: false }).limit(40),
    supabase.from("room_polls").select("id,question,options,closed_at,updated_at").eq("room_id", input.roomId).order("updated_at", { ascending: false }).limit(30),
  ]);
  const queryErrors = [roomResult, membershipResult, branchResult, versionResult, assetResult, planResult, relationResult, contentRelationResult, commentsResult, messagesResult, pollsResult].filter((result) => result.error);
  if (queryErrors.length) return jsonResponse({ error: "CONTEXT_UNAVAILABLE" }, 503);
  const room = row(roomResult.data);
  const membership = row(membershipResult.data);
  const role = text(membership.role);
  if (!room.id || !role) return jsonResponse({ error: "ROOM_NOT_FOUND" }, 404);

  const branches = arrayRows(branchResult.data);
  const versions = arrayRows(versionResult.data);
  const branchById = new Map(branches.map((branch) => [text(branch.id), branch]));
  const versionById = new Map(versions.map((version) => [text(version.id), version]));
  const currentByBranch = new Map<string, string>();
  for (const version of versions) {
    const id = text(version.id);
    const branchId = text(version.branch_id);
    if (!id || !branchId || text(version.archived_at)) continue;
    const previous = currentByBranch.get(branchId);
    if (!previous || num(version.sort_order) >= num(versionById.get(previous)?.sort_order)) currentByBranch.set(branchId, id);
  }

  const rawAssets = arrayRows(assetResult.data);
  const ids = rawAssets.map((asset) => text(asset.id)).filter(uuidLike);
  const [analysisResult, regionsResult, segmentsResult, chunksResult, humanResult] = ids.length ? await Promise.all([
    supabase.from("asset_analysis").select("asset_id,summary,detected_text,topics,keywords,structured_data").in("asset_id", ids),
    supabase.from("asset_regions").select("id,asset_id,region_type,label,text_content,x,y,width,height,confidence").in("asset_id", ids).order("y", { ascending: true }),
    supabase.from("asset_video_segments").select("id,asset_id,start_seconds,end_seconds,summary,transcript,topics,detected_text,scene_type,confidence").in("asset_id", ids).order("start_seconds", { ascending: true }),
    supabase.from("asset_document_chunks").select("id,asset_id,chunk_index,content,page,section,heading,start_offset,end_offset").in("asset_id", ids).order("chunk_index", { ascending: true }),
    supabase.from("asset_human_metadata").select("asset_id,title,summary,tags,structured_data").in("asset_id", ids),
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  const childErrors = [analysisResult, regionsResult, segmentsResult, chunksResult, humanResult].filter((result) => result.error);
  if (childErrors.length) return jsonResponse({ error: "CONTEXT_UNAVAILABLE" }, 503);
  const analyses = new Map(arrayRows(analysisResult.data).map((value) => [text(value.asset_id), analysisFor(value)]));
  const human = new Map(arrayRows(humanResult.data).map((value) => [text(value.asset_id), {
    title: optional(value.title), summary: optional(value.summary), tags: stringList(value.tags),
  }]));
  const regions = new Map<string, SafeRegion[]>();
  for (const item of arrayRows(regionsResult.data)) {
    const value = safeRegion(item);
    if (value) regions.set(text(row(item).asset_id), [...(regions.get(text(row(item).asset_id)) ?? []), value]);
  }
  const segments = new Map<string, SafeSegment[]>();
  for (const item of arrayRows(segmentsResult.data)) {
    const value = safeSegment(item);
    segments.set(text(row(item).asset_id), [...(segments.get(text(row(item).asset_id)) ?? []), value]);
  }
  const chunks = new Map<string, SafeChunk[]>();
  for (const item of arrayRows(chunksResult.data)) {
    const value = safeChunk(item);
    chunks.set(text(row(item).asset_id), [...(chunks.get(text(row(item).asset_id)) ?? []), value]);
  }

  const candidates: SafeAsset[] = [];
  const selectedAssets = new Set(input.selectedAssetIds);
  const selectedBranches = new Set(input.selectedBranchIds);
  const selectedVersions = new Set(input.selectedVersionIds);
  for (const raw of rawAssets) {
    const assetId = text(raw.id);
    const versionId = optional(raw.version_id);
    const branchId = optional(raw.branch_id);
    const version = versionId ? versionById.get(versionId) : undefined;
    const archived = Boolean(version && text(version.archived_at));
    const explicitlySelected = selectedAssets.has(assetId) || Boolean(versionId && selectedVersions.has(versionId));
    if (branchId && selectedBranches.size && !selectedBranches.has(branchId)) continue;
    if (versionId && !explicitlySelected && (!version || archived || currentByBranch.get(branchId || "") !== versionId)) continue;
    const analysis = analyses.get(assetId);
    const override = human.get(assetId);
    const branch = branchId ? branchById.get(branchId) : undefined;
    const title = override?.title || text(raw.title, "未命名素材");
    const asset: SafeAsset = stripSecrets({
      sourceId: assetId,
      assetId,
      title: title.slice(0, 240),
      assetType: text(raw.asset_type, "other"),
      branchId,
      branchName: optional(branch?.name),
      versionId,
      versionLabel: optional(version?.label),
      versionOrder: version ? num(version.sort_order) : undefined,
      isCurrent: !versionId || currentByBranch.get(branchId || "") === versionId,
      archived,
      summary: override?.summary || analysis?.summary || optional(asObject(raw.metadata).description),
      detectedText: analysis?.detectedText,
      topics: [...new Set([...(analysis?.topics ?? []), ...(override?.tags ?? [])])].slice(0, 30),
      keywords: analysis?.keywords ?? [],
      structuredData: analysis?.structured,
      regions: (regions.get(assetId) ?? []).slice(0, 100),
      segments: (segments.get(assetId) ?? []).filter((segment) => !input.timeRange || (segment.endSeconds >= input.timeRange.startSeconds && segment.startSeconds <= input.timeRange.endSeconds)).slice(0, 100),
      chunks: (chunks.get(assetId) ?? []).slice(0, 24),
      ...(override ? { humanOverride: override } : {}),
    });
    candidates.push(asset);
  }

  const planByBranch = new Map(arrayRows(planResult.data).map((value) => [text(value.branch_id), value]));
  for (const asset of candidates) {
    if (asset.assetType !== "plan" || !asset.branchId) continue;
    const plan = planByBranch.get(asset.branchId);
    if (!plan) continue;
    const content = [text(plan.description), blockText(plan.blocks)].filter(Boolean).join("\n");
    if (content) asset.chunks = [{ id: `${asset.assetId}:plan`, chunkIndex: 0, content: scrubText(content).slice(0, 8000), heading: asset.title, section: "企劃內容" }, ...(asset.chunks ?? [])].slice(0, 24);
  }

  const discussionText = [
    ...arrayRows(messagesResult.data).map((item) => text(item.body)),
    ...arrayRows(commentsResult.data).map((item) => `${text(item.body)} ${text(item.suggestion)}`),
    ...arrayRows(pollsResult.data).filter((item) => !text(item.closed_at)).map((item) => `待決策：${text(item.question)} ${(Array.isArray(item.options) ? item.options : []).join(" / ")}`),
  ].map(scrubText).filter(Boolean).join("\n").slice(0, MAX_DISCUSSION_CHARS);
  const wantsDiscussion = /討論|回饋|留言|待決策|投票|缺什麼|下一步|整理/i.test(input.query);
  if (discussionText && wantsDiscussion) {
    candidates.push({
      sourceId: `room:${input.roomId}:discussion`, assetId: input.roomId, title: "房間討論與待決策", assetType: "other",
      isCurrent: true, archived: false, summary: discussionText, topics: ["討論", "待決策"], keywords: [],
      chunks: [{ id: `room:${input.roomId}:discussion:chunk`, chunkIndex: 0, content: discussionText, heading: "最近討論" }],
    });
  }

  const relations = arrayRows(relationResult.data);
  const assetByBranch = new Map<string, SafeAsset>();
  for (const asset of candidates) if (asset.branchId && !assetByBranch.has(asset.branchId)) assetByBranch.set(asset.branchId, asset);
  const relationRows = [
    ...relations.map((relation) => ({ sourceId: text(relation.source_asset_id), targetId: text(relation.target_asset_id), relationType: text(relation.relation_type, "related_to") })),
    ...arrayRows(contentRelationResult.data).map((relation) => ({
      sourceId: assetByBranch.get(text(relation.from_branch_id))?.sourceId || `branch:${text(relation.from_branch_id)}`,
      targetId: assetByBranch.get(text(relation.to_branch_id))?.sourceId || `branch:${text(relation.to_branch_id)}`,
      relationType: "branch-related",
    })),
  ].filter((relation) => relation.sourceId && relation.targetId && relation.sourceId !== relation.targetId).slice(0, 500);

  const ranked = candidates.map((asset, index) => ({ asset, index, score: score(input.query, asset), selected: selectedAssets.has(asset.assetId) || Boolean(asset.versionId && selectedVersions.has(asset.versionId)) }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || b.score - a.score || Number(b.asset.isCurrent) - Number(a.asset.isCurrent) || a.index - b.index);
  // Reserve two context slots for first-degree relations. This keeps the
  // query ranking dominant while allowing a plan to bring along its linked
  // poster/video without loading the whole room into the agent prompt.
  const primary = ranked.slice(0, Math.max(1, MAX_CONTEXT - 2));
  const primaryIds = new Set(primary.map((item) => item.asset.sourceId));
  const relationNeighborIds = new Set<string>();
  for (const relation of relationRows) {
    if (primaryIds.has(relation.sourceId)) relationNeighborIds.add(relation.targetId);
    if (primaryIds.has(relation.targetId)) relationNeighborIds.add(relation.sourceId);
  }
  const related = ranked.filter((item) => !primaryIds.has(item.asset.sourceId) && relationNeighborIds.has(item.asset.sourceId));
  const selected = [...primary, ...related, ...ranked.filter((item) => !primaryIds.has(item.asset.sourceId) && !relationNeighborIds.has(item.asset.sourceId))]
    .slice(0, MAX_CONTEXT)
    .map((item) => item.asset);
  const sources = selected.map(sourceForAsset);
  const known = new Map(sources.map((source) => [source.sourceId, source]));
  const allowedIds = new Set(selected.map((asset) => asset.sourceId));
  const selectedRelations = relationRows.filter((relation) => allowedIds.has(relation.sourceId) && allowedIds.has(relation.targetId));
  const payload: RoomContextPayload = stripSecrets({
    room: { id: input.roomId, title: text(room.title, "未命名房間") },
    query: input.query,
    context: selected,
    sources,
    relations: selectedRelations,
    permissions: { role, canAsk: true, selectedCount: selected.filter((asset) => selectedAssets.has(asset.assetId)).length },
    truncated: ranked.length > MAX_CONTEXT || rawAssets.length >= MAX_ASSETS,
  });

  const endpoint = providerEndpoint();
  if (endpoint?.external && selected.some((asset) => {
    const original = rawAssets.find((item) => text(item.id) === asset.assetId);
    return original && !bool(original.external_ai_allowed, false);
  })) return jsonResponse({ error: "EXTERNAL_AI_BLOCKED" }, 403);
  const answer = await askAgent(payload, known);
  return new Response(JSON.stringify({
    ...payload,
    answer,
    agent: endpoint ? { provider: endpoint.provider, status: answer ? "ready" : "unavailable" } : { provider: "none", status: "unconfigured" },
  }), { status: 200, headers: responseHeaders() });
}

Deno.serve((request) => handle(request).catch(() => jsonResponse({ error: "CONTEXT_UNAVAILABLE" }, 503)));
