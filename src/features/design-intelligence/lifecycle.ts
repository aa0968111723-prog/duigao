/**
 * Design Intelligence — 提案生命週期（PR-DI-02）
 *
 * 為什麼有這個檔案：對抗審查指出 `canTransition` 是**死碼** —— 全 repo 只有
 * 測試呼叫它，任何人都可以直接把 `proposal.status` 設成 `"applied"`，
 * 完全不經過狀態機。一條沒有人使用的紅線就不是紅線，是裝飾。
 *
 * 所以狀態的改變只有這一條路：`transitionProposal`。它同時做三件事：
 *   1. 檢查轉移合法（`canTransition`）。
 *   2. 檢查該轉移需要的**條件**（例如進 `applying` 之前必須有人核准過）。
 *   3. 寫入稽核欄位（誰核准、何時套用、回到哪一版）。
 *
 * 把三件事綁在一起，是為了讓「跳過人類確認」這件事沒有捷徑可走：
 * 想把提案標成 applied，就得先經過 approved，而 approved 需要一個 approver。
 */
import { canTransition, isTerminalStatus } from "./schema";
import type { DesignProposal, DesignProposalStatus } from "./types";

export type TransitionContext = {
  /** 做這個動作的人。核准與套用一定要有人負責。 */
  actor?: string;
  now: () => number;
  /** 套用前的版本（進 applying 時必填，否則沒有東西可以復原）。 */
  baseRevision?: string;
  /** 套用後產生的版本。 */
  resultRevision?: string;
  /** 失敗或拒絕的理由。 */
  reason?: string;
};

export type TransitionResult =
  | { ok: true; proposal: DesignProposal }
  | { ok: false; reason: string };

export function transitionProposal(
  proposal: DesignProposal,
  next: DesignProposalStatus,
  context: TransitionContext,
): TransitionResult {
  if (proposal.status === next) {
    return { ok: false, reason: `提案已經是「${next}」狀態` };
  }
  if (isTerminalStatus(proposal.status)) {
    return { ok: false, reason: `「${proposal.status}」是終點狀態，不能再改` };
  }
  if (!canTransition(proposal.status, next)) {
    return { ok: false, reason: `不允許從「${proposal.status}」直接到「${next}」` };
  }

  // ---- 各轉移的前提條件 ----
  if (next === "approved") {
    if (!context.actor) {
      return { ok: false, reason: "核准必須記錄是誰核准的" };
    }
    if (!proposal.alternatives.length && !proposal.diagnostics.length) {
      return { ok: false, reason: "沒有任何診斷或方案的提案不能被核准" };
    }
  }
  if (next === "applying") {
    // 這是整條流程最重要的一道：沒有人核准過就不能開始套用。
    if (!proposal.approvedBy || !proposal.approvedAt) {
      return { ok: false, reason: "還沒有人核准這個提案，不能開始套用" };
    }
    if (!proposal.patch) {
      return { ok: false, reason: "沒有套用計畫（patch），不知道要改什麼" };
    }
    if (!context.baseRevision) {
      return { ok: false, reason: "沒有記錄套用前的版本，之後會無法復原" };
    }
    if (!proposal.patch.reversible) {
      return { ok: false, reason: "這個 patch 標示為不可逆，不允許自動套用" };
    }
  }
  if (next === "applied" && !context.resultRevision) {
    return { ok: false, reason: "套用完成必須記錄產生的版本" };
  }
  if (next === "reverted" && !proposal.baseRevision) {
    return { ok: false, reason: "沒有可以回去的版本" };
  }

  const now = context.now();
  const updated: DesignProposal = { ...proposal, status: next };
  if (next === "approved") {
    updated.approvedBy = context.actor ?? null;
    updated.approvedAt = now;
  }
  if (next === "applying") {
    updated.baseRevision = context.baseRevision ?? null;
  }
  if (next === "applied") {
    updated.appliedAt = now;
    updated.resultRevision = context.resultRevision ?? null;
  }
  if (next === "reverted") {
    updated.revertedAt = now;
  }
  if (next === "rejected" || next === "failed") {
    // 專屬欄位是權威來源；risks 仍然 append 一份，那是歷史紀錄。
    updated.failureReason = context.reason ?? null;
    updated.risks = context.reason ? [...proposal.risks, context.reason] : proposal.risks;
  }
  return { ok: true, proposal: updated };
}

/**
 * 這個提案現在**可以**做哪些動作。UI 用它決定顯示哪些按鈕 ——
 * 讓按鈕的存在與狀態機同源，而不是各自寫一份條件判斷。
 */
export function availableTransitions(proposal: DesignProposal): DesignProposalStatus[] {
  const all: DesignProposalStatus[] = [
    "analyzing",
    "ready",
    "needs-context",
    "approved",
    "rejected",
    "applying",
    "applied",
    "failed",
    "reverted",
  ];
  return all.filter((next) => next !== proposal.status && canTransition(proposal.status, next));
}
