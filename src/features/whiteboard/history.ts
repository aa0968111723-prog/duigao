/**
 * 白板 undo/redo（WB02）— WB01 operations 純函式層的執行端。
 *
 * 契約（ADR-014＋Grok wb01 F5 的誠實邊界在此兌現）：
 *  - update/move 的 undo：applyMasked 只回寫 mask 欄位、帶當前節點走
 *    既有 OCC 管線（executor 的 upsert 就是使用者編輯同一條路）。
 *  - create 的 undo = 刪除：走 softDelete 執行端。
 *  - delete 的 undo = 重建：以 before 的 masked 欄位重建列（新 version
 *    從 1 起 — 墓碑列已是另一段歷史，誠實重建而非假裝還原版本）。
 *  - 每一步 undo/redo 本身也是入帳的 op（新 opId）— 呼叫端負責 emit。
 *
 * in-memory、per-board、上限 50 — 重開頁即失（誠實：持久歷史屬
 * whiteboard_versions/operations 查詢，WB04）。
 */
import type { WhiteboardNode } from "../collaboration/types";
import { applyMasked, inverseDraft, type OperationDraft } from "../collaboration/operations";

export type HistoryStack = {
  undo: OperationDraft[];
  redo: OperationDraft[];
};

export const HISTORY_LIMIT = 50;

export function emptyHistory(): HistoryStack {
  return { undo: [], redo: [] };
}

/** 使用者做了一個新動作：入 undo 疊、清 redo（標準分支語意）。 */
export function pushHistory(stack: HistoryStack, draft: OperationDraft): HistoryStack {
  const undo = [...stack.undo, draft];
  if (undo.length > HISTORY_LIMIT) undo.shift();
  return { undo, redo: [] };
}

export type HistoryExecutors = {
  /** 走既有編輯管線（OCC/persist chain/op 發射都在裡面）。 */
  upsert: (node: WhiteboardNode) => void;
  softDelete: (id: string) => void;
  /** 以整份 inverse draft 重建被刪的節點（delete 的 undo）— mask＋after
   *  一起給，執行端用 applyMasked 於空白基底上重建。 */
  recreate: (draft: OperationDraft) => void;
  /** 找當前節點（undo 套用在「現在的列」上 — 永不整列還原）。 */
  findNode: (id: string) => WhiteboardNode | undefined;
};

export type HistoryStepResult = {
  stack: HistoryStack;
  applied: OperationDraft | null;
  /** 節點已不在（被別人刪/來源消失）→ 誠實跳過，呼叫端給提示。 */
  skipped?: "missing-node" | "unsupported";
};

function execute(draft: OperationDraft, executors: HistoryExecutors): HistoryStepResult["skipped"] | null {
  switch (draft.opType) {
    case "node-update":
    case "node-move": {
      const current = executors.findNode(draft.entityId);
      if (!current) return "missing-node";
      executors.upsert(applyMasked(current, draft.fieldMask, draft.after));
      return null;
    }
    case "node-delete": {
      const current = executors.findNode(draft.entityId);
      if (!current) return "missing-node";
      executors.softDelete(draft.entityId);
      return null;
    }
    case "node-create": {
      // inverse(node-delete) 而來：after 帶著重建欄位（含 nodeType）
      executors.recreate(draft);
      return null;
    }
    default:
      return "unsupported";
  }
}

export function undoStep(stack: HistoryStack, executors: HistoryExecutors, newOpId: string): HistoryStepResult {
  const last = stack.undo[stack.undo.length - 1];
  if (!last) return { stack, applied: null };
  const inverse = inverseDraft(last, newOpId);
  const skipped = execute(inverse, executors);
  const nextUndo = stack.undo.slice(0, -1);
  if (skipped) {
    // 套不動（節點沒了/不支援）：這步從歷史移除、redo 不入 — 誠實丟棄
    return { stack: { undo: nextUndo, redo: stack.redo }, applied: null, skipped };
  }
  return { stack: { undo: nextUndo, redo: [...stack.redo, last] }, applied: inverse };
}

export function redoStep(stack: HistoryStack, executors: HistoryExecutors, newOpId: string): HistoryStepResult {
  const last = stack.redo[stack.redo.length - 1];
  if (!last) return { stack, applied: null };
  const skipped = execute(last, executors);
  const nextRedo = stack.redo.slice(0, -1);
  if (skipped) {
    return { stack: { undo: stack.undo, redo: nextRedo }, applied: null, skipped };
  }
  return { stack: { undo: [...stack.undo, last], redo: nextRedo }, applied: last };
}
