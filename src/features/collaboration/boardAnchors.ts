/**
 * Whiteboard extras already typed by #113 / ContextAnchor.
 * Persists on existing node.anchor jsonb + linkedEntity* — no new tables.
 */
import { anchorFromNode, anchorToNodeLink, openTarget, type ContextAnchor } from "../../lib/contextAnchor";
import type { AnnotationRegion, PlanBlock, PlanDocument, Room } from "../../lib/types";
import type { DiscussionMessage, WhiteboardNode } from "./types";

export type PosterRegionMark = {
  pinId: string;
  versionId: string;
  region: AnnotationRegion;
  label: string;
};

export function posterRegionMarks(room: Pick<Room, "comments" | "versions">, branchId: string): PosterRegionMark[] {
  const versionIds = new Set(
    (room.versions ?? []).filter((version) => version.branchId === branchId).map((version) => version.id),
  );
  const marks: PosterRegionMark[] = [];
  for (const pin of room.comments ?? []) {
    if (!pin.region || !versionIds.has(pin.versionId)) continue;
    marks.push({
      pinId: pin.id,
      versionId: pin.versionId,
      region: pin.region,
      label: pin.body.trim() || "圈選範圍",
    });
  }
  return marks;
}

export function planParagraphs(plan: PlanDocument | undefined): { omitted: boolean; blocks: PlanBlock[] } {
  if (!plan) return { omitted: false, blocks: [] };
  if (plan.blocksOmitted) return { omitted: true, blocks: [] };
  return { omitted: false, blocks: plan.blocks.filter((block) => block.kind === "paragraph" || block.kind === "list") };
}

export function nodeFromImageRegion(input: {
  versionId: string;
  region: AnnotationRegion;
  label?: string;
}): Pick<WhiteboardNode, "anchor" | "sourceVersionId"> & {
  link: ReturnType<typeof anchorToNodeLink>;
  subtitle: string;
} {
  const anchor: ContextAnchor = { type: "image-region", region: input.region, versionId: input.versionId };
  return {
    anchor: anchor as Record<string, unknown>,
    sourceVersionId: input.versionId,
    link: anchorToNodeLink({ type: "entity", entityType: "version", entityId: input.versionId }),
    subtitle: input.label?.trim() || "圈選範圍",
  };
}

export function nodeFromPlanSection(input: {
  branchId: string;
  section?: Pick<PlanBlock, "id" | "text">;
}): Pick<WhiteboardNode, "anchor"> & {
  link: ReturnType<typeof anchorToNodeLink>;
  subtitle?: string;
} {
  const anchor: ContextAnchor = {
    type: "plan-section",
    branchId: input.branchId,
    sectionId: input.section?.id,
  };
  return {
    anchor: anchor as Record<string, unknown>,
    link: anchorToNodeLink(anchor),
    subtitle: input.section?.text.trim() || undefined,
  };
}

export function contentOpenFromNode(node: WhiteboardNode): {
  startTime?: number;
  endTime?: number;
  region?: AnnotationRegion;
  versionId?: string;
  planSectionId?: string;
} {
  const raw = node.anchor as ContextAnchor | undefined;
  if (raw?.type === "image-region") {
    return { region: raw.region, versionId: raw.versionId ?? node.sourceVersionId };
  }
  if (raw?.type === "plan-section") {
    return { planSectionId: raw.sectionId };
  }
  return {
    startTime: node.content.startTime,
    endTime: node.content.endTime,
  };
}

export type ContentOpen = {
  branchId?: string;
  versionId?: string;
  region?: AnnotationRegion;
  startTime?: number;
  endTime?: number;
  planSectionId?: string;
};

export function branchIdForVersion(
  room: Pick<Room, "versions"> | undefined,
  versionId?: string,
): string | undefined {
  if (!versionId || !room?.versions) return undefined;
  return room.versions.find((version) => version.id === versionId)?.branchId;
}

/**
 * Room-aware open. openTarget stays a pure contract (image arm / version-only
 * video stay none). Branch lookup lives here so App can still open the draft.
 */
export function openContentFromNode(
  node: WhiteboardNode,
  room?: Pick<Room, "versions">,
): ContentOpen {
  const fromAnchor = contentOpenFromNode(node);
  const target = openTarget(anchorFromNode(node));
  let branchId: string | undefined;
  if (target.surface === "content") branchId = target.branchId;
  else if (node.linkedEntityType === "branch" || node.linkedEntityType === "plan") branchId = node.linkedEntityId;
  const versionId = fromAnchor.versionId
    || node.sourceVersionId
    || (node.linkedEntityType === "version" ? node.linkedEntityId : undefined);
  if (!branchId) branchId = branchIdForVersion(room, versionId);
  const startTime = fromAnchor.startTime
    ?? (target.surface === "content" ? target.startTime : undefined);
  return {
    branchId,
    versionId,
    region: fromAnchor.region,
    startTime,
    endTime: fromAnchor.endTime,
    planSectionId: fromAnchor.planSectionId,
  };
}

export function openContentFromDiscussion(
  message: Pick<DiscussionMessage, "payload">,
  room?: Pick<Room, "versions">,
): ContentOpen {
  const payload = message.payload ?? {};
  const versionId = payload.versionId;
  const branchId = payload.branchId || branchIdForVersion(room, versionId);
  return {
    branchId,
    versionId,
    startTime: payload.startTime,
    endTime: payload.endTime,
    planSectionId: payload.planSectionId,
  };
}
