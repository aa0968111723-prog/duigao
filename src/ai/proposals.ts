import { NODE_TYPES, type NodeType, type WhiteboardNode } from "../features/collaboration/types";
import { createNode } from "../features/collaboration/nodes";
import { anchorToNodeLink, entityAnchor } from "../lib/contextAnchor";
import type { RoomContextAnswer, RoomContextResponse } from "../lib/assetIntelligence";

export const AI_ACTION_TYPES = [
  "create_comment",
  "create_poll",
  "create_plan_draft",
  "add_whiteboard_node",
] as const;

export type AiActionType = (typeof AI_ACTION_TYPES)[number];
export type AiProposalStatus = "preview" | "applied" | "rejected" | "failed";
export type AiProposalSource = "agent" | "local";

export type AiProposal = {
  id: string;
  type: AiActionType;
  label: string;
  payload: Record<string, unknown>;
  requiresExtraConfirm: boolean;
  source: AiProposalSource;
};

export type ApplyGateInput = {
  proposal: AiProposal;
  alreadyApplied: boolean;
  extraConfirmed: boolean;
  canTalk: boolean;
  canManage: boolean;
  canEditBoard: boolean;
};

export type ApplyGateResult =
  | { ok: true }
  | { ok: false; reason: "already-applied" | "needs-confirm" | "forbidden" };

export type ApplyProposalResult =
  | { ok: true; message: string }
  | { ok: false; reason: "already-applied" | "needs-confirm" | "forbidden" | "failed"; message: string };

const ALLOWED = new Set<string>(AI_ACTION_TYPES);

export function isAiActionType(value: unknown): value is AiActionType {
  return typeof value === "string" && ALLOWED.has(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function fingerprint(type: string, label: string, payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  const body = keys.map((key) => `${key}:${JSON.stringify(payload[key])}`).join("|");
  return `${type}:${label}:${body}`.slice(0, 240);
}

/** Reject payloads that try to smuggle original media bytes into a board write. */
export function payloadCopiesOriginalMedia(payload: Record<string, unknown>): boolean {
  return "imageDataUrl" in payload || "bytes" in payload || "videoUrl" in payload || "storagePath" in payload;
}

export function normalizeAiActions(
  actions: unknown,
  source: AiProposalSource = "agent",
): AiProposal[] {
  if (!Array.isArray(actions)) return [];
  const seen = new Set<string>();
  const out: AiProposal[] = [];
  for (const item of actions.slice(0, 6)) {
    const raw = asObject(item);
    const type = text(raw.type);
    const label = text(raw.label).slice(0, 120);
    const payload = asObject(raw.payload);
    if (!isAiActionType(type) || !label) continue;
    if (payloadCopiesOriginalMedia(payload)) continue;
    const id = fingerprint(type, label, payload);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type,
      label,
      payload,
      requiresExtraConfirm: type === "create_plan_draft",
      source,
    });
  }
  return out;
}

export function proposalsFromResponse(response: RoomContextResponse | null | undefined): AiProposal[] {
  const answer: RoomContextAnswer | null = response?.answer ?? null;
  return normalizeAiActions(answer?.actions ?? [], answer?.provider ? "agent" : "local");
}

export function applyGate(input: ApplyGateInput): ApplyGateResult {
  if (input.alreadyApplied) return { ok: false, reason: "already-applied" };
  if (input.proposal.requiresExtraConfirm && !input.extraConfirmed) {
    return { ok: false, reason: "needs-confirm" };
  }
  const { type } = input.proposal;
  if (type === "create_comment" && !input.canTalk) return { ok: false, reason: "forbidden" };
  if (type === "add_whiteboard_node" && !input.canEditBoard) return { ok: false, reason: "forbidden" };
  if ((type === "create_poll" || type === "create_plan_draft") && !input.canManage) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true };
}

export function nodeTypeFromPayload(value: unknown): NodeType {
  const raw = text(value);
  if (raw === "sticky") return "text";
  if ((NODE_TYPES as readonly string[]).includes(raw)) return raw as NodeType;
  if (raw === "poster" || raw === "video" || raw === "plan" || raw === "asset" || raw === "image") {
    return "room_content";
  }
  return "text";
}

export function nodeFromAddWhiteboardAction(input: {
  payload: Record<string, unknown>;
  whiteboardId: string;
  roomId: string;
  createdBy: string;
  x?: number;
  y?: number;
}): WhiteboardNode {
  if (payloadCopiesOriginalMedia(input.payload)) {
    throw new Error("AI apply cannot copy original media onto the whiteboard");
  }
  const nodeType = nodeTypeFromPayload(input.payload.nodeType);
  const textValue = text(input.payload.text) || text(input.payload.title) || "AI 提案";
  const title = text(input.payload.title);
  return createNode({
    whiteboardId: input.whiteboardId,
    roomId: input.roomId,
    createdBy: input.createdBy,
    nodeType,
    x: input.x ?? 80,
    y: input.y ?? 80,
    content: {
      text: textValue,
      title: title || undefined,
      sourceLabel: "AI 提案",
      mediaKind: nodeType === "room_content" && ["poster", "video", "plan", "asset"].includes(text(input.payload.mediaKind))
        ? text(input.payload.mediaKind) as "poster" | "video" | "plan" | "asset"
        : undefined,
    },
    // link 正規化走 ContextAnchor 契約層（PR-02d）：type＋id 缺一即不產
    // link（半截 link 讀側本來就讀不出東西 — anchorFromNode 同一條規則）。
    ...anchorToNodeLink(
      entityAnchor(text(input.payload.linkedEntityType), text(input.payload.linkedEntityId)) ?? { type: "board-node", whiteboardId: input.whiteboardId },
    ),
  });
}

export function pollFromAction(payload: Record<string, unknown>, roomId: string, createdBy: string): {
  id: string;
  roomId: string;
  question: string;
  options: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
} {
  const question = text(payload.question) || text(payload.text);
  const options = Array.isArray(payload.options)
    ? payload.options.map((item) => text(item)).filter(Boolean).slice(0, 6)
    : [];
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    roomId,
    question,
    options,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

export function commentBodyFromAction(payload: Record<string, unknown>, fallback: string): string {
  return text(payload.body) || text(payload.text) || fallback;
}

export function planDraftTitle(payload: Record<string, unknown>, fallback: string): string {
  return text(payload.title) || text(payload.text) || fallback;
}

export function applyReasonMessage(reason: "already-applied" | "needs-confirm" | "forbidden"): string {
  if (reason === "already-applied") return "這個提案已經套用過了。";
  if (reason === "needs-confirm") return "建立企劃草稿需要再確認一次。";
  return "目前的身份不能套用這個提案。";
}
