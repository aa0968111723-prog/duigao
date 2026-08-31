/**
 * Grok 是討論同事，不是房間成員、也不是側欄機器人。
 * 不新增 DISCUSSION_KINDS；用 payload.agent + 固定顯示名。
 */
import type { AiProposal } from "../../ai/proposals";
import { commentBodyFromAction } from "../../ai/proposals";
import { isMemberActor } from "./discussionHonesty";
import type { DiscussionKind, DiscussionPayload } from "./types";

export const GROK_COLLEAGUE_NAME = "Grok";
export const GROK_COLLEAGUE_COLOR = "#6b5ce7";
export const GROK_AGENT_PROVIDER = "grok-room-agent";
export const GROK_MENTION_LABEL = "Grok・討論同事";
export const AGENT_UNCONFIGURED_COLLEAGUE_COPY = "AI 服務尚未設定";
export const SPEND_LIMIT_COPY = "這一回合花費已達上限";
export const GROK_TOMBSTONE_COPY = "Grok 這則已收回";
export const GROK_APPLIED_BOARD_COPY = "已放到板上，你們可再拖位置";

export type ColleaguePayload = DiscussionPayload & {
  agent?: boolean;
  agentProvider?: string;
  proposalIds?: string[];
  audit?: boolean;
  proposals?: Array<{ id: string; type: string; label: string }>;
};

export function isColleagueMessage(message: {
  authorName?: string;
  authorId?: string;
  payload?: { agent?: boolean };
}): boolean {
  if (message.payload?.agent === true) return true;
  return message.authorName === GROK_COLLEAGUE_NAME && !isMemberActor(message.authorId);
}

export function isAuditMessage(message: { payload?: { audit?: boolean } }): boolean {
  return message.payload?.audit === true;
}

export function colleagueBubbleClass(message: {
  authorName?: string;
  authorId?: string;
  payload?: { agent?: boolean; audit?: boolean };
}): "colleague" | "audit" | "member" {
  if (isAuditMessage(message)) return "audit";
  if (isColleagueMessage(message)) return "colleague";
  return "member";
}

export function mentionsGrok(text: string): boolean {
  return /(^|[\s])@grok\b/i.test(text);
}

export function showsGrokMentionChip(draft: string): boolean {
  return /(^|[^\w])@$/.test(draft) || /(^|[^\w])@grok?$/i.test(draft);
}

export function insertGrokMention(draft: string): string {
  if (mentionsGrok(draft)) return draft;
  if (/(^|[^\w])@$/.test(draft)) return `${draft}Grok `;
  const trimmed = draft.trim();
  return trimmed ? `${trimmed} @Grok ` : "@Grok ";
}

export function colleagueWrite(input: {
  body: string;
  triggerUserId: string;
  replyToId?: string;
  nodeId?: string;
  versionId?: string;
  messageId?: string;
  proposalIds?: string[];
  proposals?: Array<{ id: string; type: string; label: string }>;
}): {
  kind: DiscussionKind;
  body: string;
  authorName: string;
  authorColor: string;
  authorId: string;
  replyToId?: string;
  payload: ColleaguePayload;
} {
  const proposals = (input.proposals ?? []).slice(0, 3);
  return {
    kind: "text",
    body: input.body.trim().slice(0, 4000),
    authorName: GROK_COLLEAGUE_NAME,
    authorColor: GROK_COLLEAGUE_COLOR,
    authorId: input.triggerUserId,
    replyToId: input.replyToId,
    payload: {
      agent: true,
      agentProvider: GROK_AGENT_PROVIDER,
      nodeId: input.nodeId,
      versionId: input.versionId,
      messageId: input.messageId ?? input.replyToId,
      proposalIds: input.proposalIds ?? proposals.map((item) => item.id),
      proposals,
    },
  };
}

export function auditWrite(body: string): {
  kind: DiscussionKind;
  body: string;
  payload: ColleaguePayload;
} {
  return {
    kind: "text",
    body: body.trim().slice(0, 4000),
    payload: { audit: true, title: "AI 套用" },
  };
}

export function colleagueTurnFromResponse(input: {
  answer?: string;
  unconfigured?: boolean;
  spendExceeded?: boolean;
  proposals?: AiProposal[];
}): {
  body: string;
  proposals: AiProposal[];
} {
  if (input.unconfigured) {
    return { body: AGENT_UNCONFIGURED_COLLEAGUE_COPY, proposals: [] };
  }
  if (input.spendExceeded) {
    return { body: SPEND_LIMIT_COPY, proposals: [] };
  }
  const all = input.proposals ?? [];
  const comments = all.filter((item) => item.type === "create_comment");
  const cards = all.filter((item) => item.type !== "create_comment").slice(0, 3);
  const fromComment = comments[0]
    ? commentBodyFromAction(comments[0].payload, comments[0].label)
    : "";
  const body = (input.answer || fromComment || "我看過了，還沒有具體下一步。").trim();
  return { body, proposals: cards };
}

/** create_comment 採用後必須長成同事氣泡，不可頂著觸發者發言。 */
export function createCommentAsColleague(
  proposal: Pick<AiProposal, "payload" | "label">,
  triggerUserId: string,
  extra?: { nodeId?: string; replyToId?: string },
): ReturnType<typeof colleagueWrite> {
  return colleagueWrite({
    body: commentBodyFromAction(proposal.payload, proposal.label),
    triggerUserId,
    nodeId: extra?.nodeId,
    replyToId: extra?.replyToId,
    messageId: extra?.replyToId,
  });
}
