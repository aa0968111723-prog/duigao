/**
 * Whiteboard extras already typed by #113 / ContextAnchor.
 * Persists on existing node.anchor jsonb + linkedEntity* — no new tables.
 */
import { anchorToNodeLink, type ContextAnchor } from "../../lib/contextAnchor";
import type { AnnotationRegion, PlanBlock, PlanDocument, Room } from "../../lib/types";
import type { WhiteboardNode } from "./types";

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
