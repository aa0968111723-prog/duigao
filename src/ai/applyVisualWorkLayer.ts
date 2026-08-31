/**
 * Human 採用 writes visual_proposals (work layer). Never versions, originals,
 * or `rooms/.../versions/...` Storage objects.
 */
import { proposalAssetPath } from "../cloud/assets";
import type { CloudProposal } from "../cloud/roomRepository";
import { normalizeDoc, type VisualProposal } from "../features/visual-proposal/store";
import type { AiProposal } from "./proposals";

function pathTouchesVersionOriginal(path: string): boolean {
  return /\/versions\//.test(path);
}

export type VersionStorageSnapshot = {
  id: string;
  imagePath?: string;
  videoPath?: string;
};

export type VisualWorkLayerResult = {
  cloudProposal: CloudProposal;
  versionImagePath?: string;
  versionVideoPath?: string;
};

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function itemId(seed: string, index: number): string {
  return `ai-${seed.slice(0, 8)}-${index}`;
}

function workLayerItems(proposal: AiProposal): Array<Record<string, unknown>> {
  const payload = proposal.payload ?? {};
  const ref = text(payload.workLayerRef);
  if (proposal.type === "imagine_image" || proposal.type === "propose_add_image" || proposal.type === "imagine_video") {
    const imageDataUrl = ref ? (ref.startsWith("asset:") ? ref : `asset:${ref}`) : text(payload.preview) || "asset:pending";
    const full = text(payload.scope) === "full";
    const x = typeof payload.x === "number" ? payload.x : 0.5;
    const y = typeof payload.y === "number" ? payload.y : 0.5;
    const width = typeof payload.width === "number" ? payload.width : (full ? 100 : 40);
    return [{
      id: itemId(proposal.id, 0),
      type: "image",
      name: proposal.label.slice(0, 80) || "AI 圖",
      imageDataUrl,
      x,
      y,
      width,
      rotation: 0,
      opacity: 1,
      visible: true,
    }];
  }
  if (proposal.type === "propose_add_shape") {
    return [{
      id: itemId(proposal.id, 0),
      type: "shape",
      color: "#c45c4a",
      height: 18,
      radius: 10,
      x: 0.5,
      y: 0.5,
      width: 40,
      rotation: 0,
      opacity: 1,
      visible: true,
    }];
  }
  if (proposal.type === "propose_move_item") {
    return [{
      id: text(payload.itemId) || itemId(proposal.id, 0),
      type: "text",
      role: "custom",
      text: text(payload.text) || proposal.label,
      x: typeof payload.x === "number" ? payload.x : 0.5,
      y: typeof payload.y === "number" ? payload.y : 0.5,
      width: 40,
      rotation: 0,
      opacity: 1,
      visible: true,
      fontFamily: '"Noto Sans TC", sans-serif',
      fontStyle: "modern",
      fontSize: 5,
      fontWeight: 700,
      color: "#ffffff",
      align: "center",
      backdropColor: "#000000",
      backdropOpacity: 0,
      backdropPadding: 0.3,
      backdropRadius: 8,
    }];
  }
  const body = text(payload.text) || text(payload.body) || proposal.label;
  return [{
    id: itemId(proposal.id, 0),
    type: "text",
    role: text(payload.role) || "custom",
    text: body.slice(0, 400),
    x: 0.5,
    y: 0.35,
    width: 70,
    rotation: 0,
    opacity: 1,
    visible: true,
    fontFamily: '"Noto Sans TC", sans-serif',
    fontStyle: "modern",
    fontSize: 5,
    fontWeight: 700,
    color: "#ffffff",
    align: "center",
    backdropColor: "#000000",
    backdropOpacity: 0,
    backdropPadding: 0.3,
    backdropRadius: 8,
  }];
}

export function cloudProposalFromAgentAction(input: {
  proposal: AiProposal;
  versionId: string;
  authorName: string;
}): CloudProposal {
  const payload = input.proposal.payload ?? {};
  const fromRef = text(payload.workLayerRef).match(/\/proposals\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\//i);
  const candidate = text(payload.proposalId) || fromRef?.[1] || "";
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `00000000-0000-4000-8000-${String(Date.now()).padStart(12, "0").slice(-12)}`);
  return {
    id,
    versionId: input.versionId,
    authorName: input.authorName,
    name: input.proposal.label.slice(0, 120) || "AI 提案",
    revision: 0,
    payload: {
      title: input.proposal.label.slice(0, 120),
      description: text(payload.preview) || input.proposal.label,
      type: input.proposal.type === "imagine_image" || input.proposal.type === "propose_add_image" || input.proposal.type === "imagine_video" ? "asset" : "text",
      status: "accepted",
      createdBy: "ai",
      items: workLayerItems(input.proposal),
      workLayerRef: text(payload.workLayerRef) || undefined,
    },
  };
}

/**
 * Build the visual_proposals row and hand it to `upsert`. The version snapshot
 * is returned unchanged — this function has no API that can rewrite originals.
 */
export async function applyVisualWorkLayer(input: {
  proposal: AiProposal;
  version: VersionStorageSnapshot;
  roomId: string;
  authorName: string;
  upsert: (roomId: string, proposal: CloudProposal) => Promise<number>;
}): Promise<VisualWorkLayerResult> {
  if (pathTouchesVersionOriginal(input.version.imagePath ?? "") || pathTouchesVersionOriginal(input.version.videoPath ?? "")) {
    // originals may exist on the version; we still must not write them.
  }
  const cloudProposal = cloudProposalFromAgentAction({
    proposal: input.proposal,
    versionId: input.version.id,
    authorName: input.authorName,
  });
  const ref = typeof cloudProposal.payload.workLayerRef === "string" ? cloudProposal.payload.workLayerRef : "";
  if (ref && pathTouchesVersionOriginal(ref)) {
    throw new Error("AI apply cannot write a version original path");
  }
  await input.upsert(input.roomId, cloudProposal);
  return {
    cloudProposal,
    versionImagePath: input.version.imagePath,
    versionVideoPath: input.version.videoPath,
  };
}

export function proposalStoragePath(roomId: string, proposalId: string, assetId: string, mime: string): string {
  return proposalAssetPath(roomId, proposalId, assetId, mime);
}

export function visualProposalFromCloud(cloud: CloudProposal): VisualProposal | null {
  return normalizeDoc({
    ...cloud.payload,
    id: cloud.id,
    versionId: cloud.versionId,
    name: cloud.name,
    title: typeof cloud.payload.title === "string" && cloud.payload.title.trim() ? cloud.payload.title : cloud.name,
    authorName: cloud.authorName,
  });
}
