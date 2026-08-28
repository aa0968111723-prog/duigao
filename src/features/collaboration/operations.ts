/**
 * 白板操作事件的純函式層（WB01，ADR-014 ＋ Grok wb00 F2 修訂）。
 *
 * 契約三條：
 *  1. op 不是第二個 truth — 套用順序由 row state＋OCC 決定；本層只負責
 *     「這個動作動了哪些欄位、之前/之後是什麼」的可重放事實。
 *  2. undo 永不整列還原：inverse 只回寫 fieldMask 內的欄位（含
 *     `content.<key>` 路徑），帶當前 acked version 走同一條 OCC 管線 —
 *     幽靈 op（row 寫失敗但 op 落了）最多把 mask 欄位改回舊值，
 *     不會把別人的其他欄位一起帶回過去。
 *  3. opId 由 client 產生、DB unique — 失敗重試冪等（duplicate = ack）。
 *
 * 本層零 I/O、零 React：WB02 佈線進 persist 管線，WB04 供版本歷史。
 */
import type { WhiteboardNode, WhiteboardOperation, WhiteboardOpType } from "./types";

/** 尚未入帳的 op 草稿（actor/room 由呼叫端在送出時補上）。 */
export type OperationDraft = {
  opId: string;
  whiteboardId: string;
  opType: WhiteboardOpType;
  entityId: string;
  fieldMask: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

/** node 上允許入 mask 的頂層欄位（content 內部走 `content.<key>` 路徑）。 */
const MASKABLE_FIELDS = new Set([
  "x", "y", "width", "height", "rotation", "zIndex", "locked", "frameId",
  "linkedEntityType", "linkedEntityId", "parentGroupId", "sourceVersionId",
]);

function readPath(node: Record<string, unknown>, path: string): unknown {
  if (path.startsWith("content.")) {
    const content = node.content;
    if (!content || typeof content !== "object") return undefined;
    return (content as Record<string, unknown>)[path.slice("content.".length)];
  }
  return node[path];
}

/** 只挑 mask 內欄位的投影（before/after 都經過它 — payload 永遠有界）。 */
export function maskedValues(node: WhiteboardNode, mask: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of mask) {
    const value = readPath(node as unknown as Record<string, unknown>, path);
    if (value !== undefined) out[path] = value;
  }
  return out;
}

/** 比對兩版節點，產出實際變動的 mask（呼叫端也可自帶 mask）。 */
export function diffMask(before: WhiteboardNode, after: WhiteboardNode): string[] {
  const mask: string[] = [];
  for (const field of MASKABLE_FIELDS) {
    if (readPath(before as never, field) !== readPath(after as never, field)) mask.push(field);
  }
  const keys = new Set([
    ...Object.keys(before.content ?? {}),
    ...Object.keys(after.content ?? {}),
  ]);
  for (const key of keys) {
    const path = `content.${key}`;
    if (readPath(before as never, path) !== readPath(after as never, path)) mask.push(path);
  }
  return mask;
}

export function nodeUpdateDraft(
  opId: string,
  before: WhiteboardNode,
  after: WhiteboardNode,
  mask: string[] = diffMask(before, after),
): OperationDraft | null {
  if (mask.length === 0) return null;
  const isMoveOnly = mask.every((path) => path === "x" || path === "y");
  return {
    opId,
    whiteboardId: after.whiteboardId,
    opType: isMoveOnly ? "node-move" : "node-update",
    entityId: after.id,
    fieldMask: mask,
    before: maskedValues(before, mask),
    after: maskedValues(after, mask),
  };
}

export function nodeCreateDraft(opId: string, node: WhiteboardNode): OperationDraft {
  const mask = diffMask({ ...node, content: {} as WhiteboardNode["content"], x: NaN, y: NaN } as WhiteboardNode, node);
  return {
    opId,
    whiteboardId: node.whiteboardId,
    opType: "node-create",
    entityId: node.id,
    fieldMask: mask,
    before: {},
    after: maskedValues(node, mask),
  };
}

export function nodeDeleteDraft(opId: string, node: WhiteboardNode): OperationDraft {
  const mask = diffMask({ ...node, content: {} as WhiteboardNode["content"], x: NaN, y: NaN } as WhiteboardNode, node);
  return {
    opId,
    whiteboardId: node.whiteboardId,
    opType: "node-delete",
    entityId: node.id,
    fieldMask: mask,
    before: maskedValues(node, mask),
    after: {},
  };
}

/**
 * 反操作：before/after 對調、mask 不變。node-create ↔ node-delete。
 * 新 opId 由呼叫端給（undo 本身也是一個入帳的操作）。
 */
export function inverseDraft(op: WhiteboardOperation | OperationDraft, newOpId: string): OperationDraft {
  const flipped: Record<WhiteboardOpType, WhiteboardOpType> = {
    "node-create": "node-delete",
    "node-delete": "node-create",
    "node-update": "node-update",
    "node-move": "node-move",
    "edge-create": "edge-delete",
    "edge-delete": "edge-create",
    "edge-update": "edge-update",
    "frame-create": "frame-delete",
    "frame-delete": "frame-create",
    "frame-update": "frame-update",
    "board-arrange": "board-arrange",
    "bulk-restore": "bulk-restore",
  };
  return {
    opId: newOpId,
    whiteboardId: op.whiteboardId,
    opType: flipped[op.opType],
    entityId: op.entityId,
    fieldMask: [...op.fieldMask],
    before: { ...op.after },
    after: { ...op.before },
  };
}

/**
 * 把 masked 值套回節點（undo 的套用半邊）：只動 mask 內欄位，其餘
 * 一律保留 current 的值 — 這就是「幽靈 op 傷害面有界」的機械保證。
 * version 刻意不動：呼叫端以當前 acked version 走 OCC。
 */
export function applyMasked(
  current: WhiteboardNode,
  mask: string[],
  values: Record<string, unknown>,
): WhiteboardNode {
  const next: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) };
  let content: Record<string, unknown> | null = null;
  for (const path of mask) {
    if (path.startsWith("content.")) {
      if (!content) content = { ...(current.content as Record<string, unknown>) };
      const key = path.slice("content.".length);
      if (path in values) content[key] = values[path];
      else delete content[key];
    } else if (MASKABLE_FIELDS.has(path)) {
      if (path in values) next[path] = values[path];
      else delete next[path];
    }
    // mask 外的路徑靜默忽略 — 壞資料不放大
  }
  if (content) next.content = content;
  return next as unknown as WhiteboardNode;
}
