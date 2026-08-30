import { applyGate, type AiProposal } from "../../ai/proposals";
import { createScheduleEvent } from "./events";
import type { ScheduleEvent } from "./types";

export type ScheduleProposalKind = "create_schedule_event" | "create_task";

export function scheduleEventFromProposal(
  proposal: Pick<AiProposal, "payload" | "label">,
  roomId: string,
  createdBy: string,
): ScheduleEvent {
  const payload = proposal.payload;
  const title = String(payload.title ?? payload.text ?? proposal.label).trim().slice(0, 240);
  const startAt = typeof payload.startAt === "number" ? payload.startAt : Date.now();
  return createScheduleEvent({
    roomId,
    createdBy,
    title: title || proposal.label,
    startAt,
    eventType: payload.eventType === "deadline" ? "deadline" : "task",
    sourceType: "ai_proposal",
    description: String(payload.reason ?? payload.description ?? ""),
  });
}

export function proposalShowsSources(proposal: Pick<AiProposal, "payload">): {
  messages: string[];
  files: string[];
  nodes: string[];
  reason: string;
} {
  const payload = proposal.payload;
  const asList = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, 12) : [];
  return {
    messages: asList(payload.usedMessageIds ?? payload.messages),
    files: asList(payload.usedFileIds ?? payload.files),
    nodes: asList(payload.usedNodeIds ?? payload.nodes),
    reason: String(payload.reason ?? ""),
  };
}

/** Single write decision for 採用／拒絕. Reject never produces an event. */
export function decideScheduleProposalWrite(input: {
  action: "adopt" | "reject";
  proposal: AiProposal;
  alreadyApplied: boolean;
  extraConfirmed: boolean;
  canTalk: boolean;
  canManage: boolean;
  canEditBoard: boolean;
  roomId: string;
  createdBy: string;
}): { wrote: ScheduleEvent | null; reason?: string } {
  if (input.action !== "adopt") return { wrote: null, reason: "rejected" };
  if (input.proposal.type !== "create_schedule_event" && input.proposal.type !== "create_task") {
    return { wrote: null, reason: "forbidden" };
  }
  const gate = applyGate({
    proposal: input.proposal,
    alreadyApplied: input.alreadyApplied,
    extraConfirmed: input.extraConfirmed,
    canTalk: input.canTalk,
    canManage: input.canManage,
    canEditBoard: input.canEditBoard,
  });
  if (!gate.ok) return { wrote: null, reason: gate.reason };
  return { wrote: scheduleEventFromProposal(input.proposal, input.roomId, input.createdBy) };
}
