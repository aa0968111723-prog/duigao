import type { Room, Version } from "../lib/types";
import { activeVersions } from "../lib/types";
import { branchVersions, normalizeRoomBranches } from "../lib/roomBranches";
import type {
  AssetAnalysis,
  AssetRecord,
  AssetVideoSegment,
  KnowledgeEntry,
  RoomContext,
  RoomContextIntent,
  RoomContextItem,
  RoomContextQuery,
  ZenAgentRoomRequest,
} from "./types";
import { extractPlanDocument, rankPhotosForUse, understandImage } from "./understanding";
import { currentVersion, isCurrentVersionId, requestedCompareLabels, versionsForQuery } from "./versionAwareness";
import { describeMoment, parseTimestamp, segmentsFromComments } from "./video";
import {
  createEdge,
  createNode,
  selectedSlice,
  type WhiteboardGraph,
  type WhiteboardNode,
} from "../collaboration/whiteboard";

const DEFAULT_LIMIT = 12;

export function classifyQuery(query: string): { intent: RoomContextIntent; timeSeconds?: number; compareLabels: string[] } {
  const timeSeconds = parseTimestamp(query);
  const compareLabels = requestedCompareLabels(query);
  if (timeSeconds != null && /影片|這支|這段/.test(query)) {
    return { intent: "video_at_time", timeSeconds, compareLabels };
  }
  if (/哪張比較適合|適合.*照片|哪些.*素材/.test(query)) return { intent: "photo_fit", compareLabels };
  if (compareLabels.length) return { intent: "version_compare", compareLabels };
  if (/還缺什麼|缺了什麼|計畫.*缺/.test(query)) return { intent: "plan_gaps", compareLabels };
  if (/文宣在講什麼|這張.*講|海報.*講/.test(query)) return { intent: "poster_summary", compareLabels };
  if (/整理目前方向|白板|流程缺少/.test(query)) return { intent: "board_summary", compareLabels };
  if (/找|搜尋|有哪些/.test(query)) return { intent: "asset_search", compareLabels };
  return { intent: "general", timeSeconds, compareLabels };
}

export function indexRoomKnowledge(input: {
  room: Room;
  assets?: AssetRecord[];
  analyses?: AssetAnalysis[];
  segments?: AssetVideoSegment[];
}): KnowledgeEntry[] {
  const room = normalizeRoomBranches(input.room);
  const entries: KnowledgeEntry[] = [];
  const analyses = input.analyses ?? [];
  const providedSegments = input.segments ?? [];

  for (const branch of room.branches ?? []) {
    const versions = branchVersions(room, branch.id);
    const current = currentVersion(versions);
    const asset = input.assets?.find((item) => item.branchId === branch.id);
    const assetId = asset?.id ?? `asset_${branch.id}`;

    if (branch.branchType === "plan") {
      const plan = room.plans?.find((item) => item.branchId === branch.id);
      if (plan) {
        const extracted = extractPlanDocument(plan);
        entries.push({
          id: `know_plan_${branch.id}`,
          roomId: room.id,
          assetId,
          branchId: branch.id,
          kind: "document",
          title: extracted.title,
          body: [extracted.body, extracted.missing.length ? `缺少：${extracted.missing.map((item) => item.label).join("、")}` : ""]
            .filter(Boolean)
            .join("\n"),
          topics: extracted.topics,
          isCurrentVersion: true,
        });
      }
      continue;
    }

    for (const version of versions) {
      const analysis = analyses.find((item) => item.versionId === version.id);
      const comments = room.comments.filter((comment) => comment.versionId === version.id);
      if (version.kind === "video" || branch.branchType === "video") {
        const segs = [
          ...providedSegments.filter((segment) => segment.versionId === version.id),
          ...segmentsFromComments(comments, version.id, assetId),
        ];
        for (const segment of segs) {
          entries.push({
            id: `know_seg_${segment.id}`,
            roomId: room.id,
            assetId,
            versionId: version.id,
            branchId: branch.id,
            segmentId: segment.id,
            kind: "video_segment",
            title: `${branch.name} ${version.label}`,
            body: segment.summary,
            topics: segment.topics,
            isCurrentVersion: current?.id === version.id,
          });
        }
      } else {
        const understood = understandImage({
          title: branch.name,
          versionLabel: version.label,
          comments,
          analysis,
        });
        entries.push({
          id: `know_img_${version.id}`,
          roomId: room.id,
          assetId,
          versionId: version.id,
          branchId: branch.id,
          kind: "image_analysis",
          title: `${branch.name}（${version.label}）`,
          body: understood.summary,
          topics: understood.topics,
          isCurrentVersion: current?.id === version.id,
        });
      }
    }
  }

  for (const relation of room.relations ?? []) {
    const from = room.branches?.find((branch) => branch.id === relation.fromBranchId);
    const to = room.branches?.find((branch) => branch.id === relation.toBranchId);
    entries.push({
      id: `know_rel_${relation.id}`,
      roomId: room.id,
      kind: "relation",
      branchId: relation.fromBranchId,
      title: `${from?.name ?? "內容"} ↔ ${to?.name ?? "內容"}`,
      body: `${from?.name ?? relation.fromBranchId} 與 ${to?.name ?? relation.toBranchId} 相關。`,
      topics: [],
      isCurrentVersion: true,
    });
  }

  return entries;
}

function scoreEntry(entry: KnowledgeEntry, query: string, intent: RoomContextIntent, timeSeconds?: number): number {
  let score = 0;
  if (entry.title.includes(query) || entry.body.includes(query)) score += 4;
  for (const topic of entry.topics) {
    if (query.includes(topic)) score += 3;
  }
  if (intent === "poster_summary" && entry.kind === "image_analysis") score += 5;
  if (intent === "video_at_time" && entry.kind === "video_segment") score += 5;
  if (intent === "plan_gaps" && entry.kind === "document") score += 6;
  if (intent === "photo_fit" && entry.kind === "image_analysis") score += 4;
  if (intent === "board_summary" && (entry.kind === "whiteboard_node" || entry.kind === "whiteboard_edge")) score += 6;
  if (intent === "version_compare") score += entry.isCurrentVersion ? 1 : 2;
  if (entry.isCurrentVersion && intent !== "version_compare") score += 2;
  if (timeSeconds != null && entry.kind === "video_segment") score += 3;
  return score;
}

function knowledgeItem(
  entry: KnowledgeEntry,
  room: Room,
  input: { segments?: AssetVideoSegment[] },
  score: number,
): RoomContextItem {
  const segment = (input.segments ?? [])
    .concat(segmentsFromComments(room.comments, entry.versionId ?? "", entry.assetId ?? ""))
    .find((item) => item.id === entry.segmentId);
  return {
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    topics: entry.topics,
    assetId: entry.assetId,
    versionId: entry.versionId,
    versionLabel: room.versions.find((version) => version.id === entry.versionId)?.label,
    branchId: entry.branchId,
    startSeconds: segment?.startSeconds,
    endSeconds: segment?.endSeconds,
    score,
    isCurrentVersion: entry.isCurrentVersion,
  };
}

export function retrieveRoomContext(input: {
  room: Room;
  query: RoomContextQuery | string;
  assets?: AssetRecord[];
  analyses?: AssetAnalysis[];
  segments?: AssetVideoSegment[];
  whiteboard?: WhiteboardGraph;
  selectedNodeIds?: string[];
}): RoomContext {
  const room = normalizeRoomBranches(input.room);
  const raw = typeof input.query === "string" ? { text: input.query, roomId: room.id } : input.query;
  const classified = classifyQuery(raw.text);
  const timeSeconds = raw.timeSeconds ?? classified.timeSeconds;
  const compareLabels = raw.compareLabels?.length ? raw.compareLabels : classified.compareLabels;
  const intent = classified.intent;
  const limit = Math.max(1, Math.min(raw.limit ?? DEFAULT_LIMIT, 24));
  const entries = indexRoomKnowledge(input);
  const compare = compareLabels.length > 0;
  const selectedIds = raw.selectedNodeIds ?? input.selectedNodeIds;
  const items: RoomContextItem[] = [];

  if (input.whiteboard && (selectedIds?.length || intent === "board_summary")) {
    const slice = selectedIds?.length ? selectedSlice(input.whiteboard, selectedIds) : input.whiteboard;
    for (const node of slice.nodes) {
      items.push({
        kind: "whiteboard_node",
        title: node.text,
        body: `${node.type}${node.linkedVersionId ? ` version:${node.linkedVersionId}` : ""}${node.linkedAssetId ? ` asset:${node.linkedAssetId}` : ""}`,
        topics: [node.type],
        assetId: node.linkedAssetId,
        versionId: node.linkedVersionId,
        branchId: node.linkedBranchId,
        startSeconds: node.videoTimestamp,
        score: 8,
        isCurrentVersion: true,
        nodeId: node.id,
        nodeType: node.type,
      });
    }
    for (const edge of slice.edges) {
      const from = slice.nodes.find((node) => node.id === edge.fromNodeId);
      const to = slice.nodes.find((node) => node.id === edge.toNodeId);
      items.push({
        kind: "whiteboard_edge",
        title: `${from?.text ?? edge.fromNodeId} → ${to?.text ?? edge.toNodeId}`,
        body: edge.kind,
        topics: [edge.kind],
        score: 7,
        isCurrentVersion: true,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
      });
    }
    const linkedVersionIds = new Set(slice.nodes.flatMap((node) => node.linkedVersionId ? [node.linkedVersionId] : []));
    const linkedAssetIds = new Set(slice.nodes.flatMap((node) => node.linkedAssetId ? [node.linkedAssetId] : []));
    for (const entry of entries) {
      if (items.length >= limit) break;
      const linked = (entry.versionId && linkedVersionIds.has(entry.versionId))
        || (entry.assetId && linkedAssetIds.has(entry.assetId));
      if (linked) items.push(knowledgeItem(entry, room, input, 6));
    }
  }

  const scoped = entries.filter((entry) => {
    if (raw.selectedAssetIds?.length && entry.assetId && !raw.selectedAssetIds.includes(entry.assetId)) return false;
    if (compare && entry.versionId) {
      const version = room.versions.find((item) => item.id === entry.versionId);
      return Boolean(version && compareLabels.some((label) => version.label.includes(label)));
    }
    if (!compare && entry.versionId && !entry.isCurrentVersion && intent !== "version_compare") return false;
    if (timeSeconds != null && entry.kind === "video_segment") {
      const segment = (input.segments ?? []).find((item) => item.id === entry.segmentId)
        ?? segmentsFromComments(room.comments, entry.versionId ?? "", entry.assetId ?? "").find((item) => item.id === entry.segmentId);
      if (!segment) return entry.body.length > 0;
      return timeSeconds >= segment.startSeconds && timeSeconds <= segment.endSeconds;
    }
    return true;
  });

  const taken = new Set(items.map((item) => `${item.kind}:${item.versionId ?? item.nodeId ?? item.title}`));
  const ranked = scoped
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, raw.text, intent, timeSeconds),
    }))
    .filter((item) => item.score > 0 || scoped.length <= limit)
    .sort((a, b) => b.score - a.score);

  for (const { entry, score } of ranked) {
    if (items.length >= limit) break;
    const key = `${entry.kind}:${entry.versionId ?? entry.id}`;
    if (taken.has(key) || taken.has(`${entry.kind}:${entry.title}`)) continue;
    items.push(knowledgeItem(entry, room, input, score));
    taken.add(key);
  }

  if (intent === "photo_fit") {
    const photos = items.filter((item) => item.kind === "image_analysis").map((item) => ({
      id: item.versionId ?? item.title,
      title: item.title,
      topics: item.topics,
      summary: item.body,
    }));
    const rankedPhotos = rankPhotosForUse(photos, raw.text);
    for (const photo of rankedPhotos) {
      const existing = items.find((item) => item.versionId === photo.id || item.title === photo.title);
      if (existing) existing.body = `${existing.body}\n適合度：${photo.reason}`;
    }
  }

  return {
    roomId: room.id,
    query: raw.text,
    intent,
    timeSeconds,
    truncated: true,
    fullRoomDumped: false,
    currentVersionOnly: !compare,
    items: items.slice(0, limit),
  };
}

export function answerFromContext(query: string, context: RoomContext, room?: Room): string {
  if (!context.items.length) return "目前沒有足夠的房間知識可以回答，且我不會只回檔名。";
  if (context.intent === "poster_summary") {
    const poster = context.items.find((item) => item.kind === "image_analysis");
    return poster ? `${poster.title}：${poster.body}` : context.items[0].body;
  }
  if (context.intent === "video_at_time") {
    const time = context.timeSeconds ?? 0;
    const segments = context.items.filter((item) => item.kind === "video_segment");
    if (!segments.length) return describeMoment([], time);
    return segments.map((item) => item.body).join("\n");
  }
  if (context.intent === "photo_fit") {
    return context.items
      .filter((item) => item.kind === "image_analysis")
      .map((item) => `${item.title}：${item.body}`)
      .join("\n");
  }
  if (context.intent === "plan_gaps") {
    const plan = context.items.find((item) => item.kind === "document");
    return plan?.body ?? "這份企劃還沒有可讀的內容。";
  }
  if (context.intent === "board_summary") {
    const flow = context.items.filter((item) => item.kind === "whiteboard_edge").map((item) => item.title);
    const missingFollowup = !context.items.some((item) => /追蹤|後續|聯絡/.test(item.title + item.body));
    const direction = flow.length ? `目前流程：${flow.join("；")}。` : context.items.map((item) => item.title).join("、");
    return missingFollowup ? `${direction} 這個流程缺少報名後的追蹤。` : direction;
  }
  if (context.intent === "version_compare" && room) {
    return context.items.map((item) => `${item.versionLabel ?? item.title}：${item.body}`).join("\n");
  }
  return context.items.map((item) => `${item.title}：${item.body}`).join("\n");
}

export function buildZenAgentRequest(query: string, context: RoomContext): ZenAgentRoomRequest {
  const assets = context.items.slice(0, 12).map((item, index) => {
    const sourceId = item.assetId || item.versionId || `ctx_${index}`;
    const assetType = item.kind === "document" ? "plan" : item.kind === "video_segment" ? "video" : "image";
    return {
      sourceId,
      assetId: sourceId,
      title: item.title.slice(0, 240),
      assetType,
      branchId: item.branchId,
      versionId: item.versionId,
      versionLabel: item.versionLabel,
      isCurrent: item.isCurrentVersion !== false,
      archived: false,
      summary: item.body.slice(0, 5000),
      topics: item.topics.slice(0, 30),
      keywords: item.topics.slice(0, 30),
      ...(item.kind === "video_segment" && item.startSeconds != null
        ? {
            segments: [{
              startSeconds: item.startSeconds,
              endSeconds: item.endSeconds ?? item.startSeconds,
              summary: item.body,
              topics: item.topics,
            }],
          }
        : {}),
    };
  });
  return {
    agent: "tku-zen-agent",
    source: "duigao.room-context",
    notASecondAgent: true,
    query,
    context: assets,
    sources: assets.map((asset) => ({
      sourceId: asset.sourceId,
      assetId: asset.assetId,
      title: asset.title,
      assetType: asset.assetType,
      versionId: asset.versionId,
      versionLabel: asset.versionLabel,
      excerpt: asset.summary?.slice(0, 900),
    })),
    relations: [],
  };
}

export function assertNotFullRoomDump(context: RoomContext, room: Room): void {
  const live = activeVersions(room.versions);
  if (live.length > 2 && context.items.length >= live.length + (room.comments.length || 0) + (room.messages.length || 0)) {
    throw new Error("Room Context dumped the whole room into the prompt.");
  }
}

export function latestLabels(versions: Version[]): string[] {
  const current = currentVersion(versions);
  return current ? [current.label] : [];
}

export function applyBackToWhiteboard(graph: WhiteboardGraph, context: RoomContext): WhiteboardGraph {
  let next = graph;
  const idMap = new Map<string, string>();
  for (const item of context.items.filter((entry) => entry.kind === "whiteboard_node")) {
    const existing = next.nodes.find((node) => node.id === item.nodeId)
      ?? next.nodes.find((node) => node.text === item.title && node.type === (item.nodeType ?? "flow"));
    if (existing) {
      if (item.nodeId) idMap.set(item.nodeId, existing.id);
      continue;
    }
    const made = createNode(next, {
      id: item.nodeId,
      type: (item.nodeType as WhiteboardNode["type"]) ?? "flow",
      text: item.title,
      x: 32,
      y: next.nodes.length * 96,
      linkedAssetId: item.assetId,
      linkedVersionId: item.versionId,
      linkedBranchId: item.branchId,
      videoTimestamp: item.startSeconds,
    });
    next = made.graph;
    idMap.set(item.nodeId ?? made.node.id, made.node.id);
  }
  for (const item of context.items.filter((entry) => entry.kind === "whiteboard_edge")) {
    const fromId = (item.fromNodeId && idMap.get(item.fromNodeId))
      ?? item.fromNodeId
      ?? next.nodes.find((node) => item.title.startsWith(node.text))?.id;
    const toId = (item.toNodeId && idMap.get(item.toNodeId))
      ?? item.toNodeId
      ?? next.nodes.find((node) => item.title.endsWith(node.text))?.id;
    if (!fromId || !toId) continue;
    if (next.edges.some((edge) => edge.fromNodeId === fromId && edge.toNodeId === toId)) continue;
    const kind = item.body === "mindmap" ? "mindmap" : item.body === "related" ? "related" : "flow";
    next = createEdge(next, fromId, toId, kind).graph;
  }
  return next;
}

export { isCurrentVersionId, versionsForQuery };
