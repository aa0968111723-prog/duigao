import type { AiProposal } from "../../ai/proposals";
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
