/**
 * 白板上的 AI 協助（WB06）— 純函式層。
 *
 * 任務書的紅線：**AI 是可選擇的協助，不是自動執行者**。所以這一層只做
 * 三件事：把提案變成「看得到的預覽」、算出預覽要擺在哪、以及把預覽變成
 * 「要對板做哪些動作」的計畫。真正的寫入由呼叫端走既有節點管線（OCC、
 * op 帳、離線佇列都不繞過）。
 *
 * 預覽節點**不進房態、不寫 DB**：它們只活在 Workspace 的 render 裡，
 * 使用者按「套用」才變成真的節點。取消就整批消失，什麼都沒發生。
 */
import type { WhiteboardEdge, WhiteboardNode } from "../collaboration/types";
import type { AiProposal } from "../../ai/proposals";

export type BoardAiPreview = {
  /** 這批預覽對應的提案（套用時要一起入稽核）。 */
  proposals: AiProposal[];
  /** 預覽節點（id 是暫時的，套用時重新產生真 id）。 */
  nodes: WhiteboardNode[];
  /** 預覽連線（source/target 用預覽節點 id）。 */
  edges: WhiteboardEdge[];
};

/** 只有這些提案型別會落在白板上（其餘由既有的房間層 AI 面板處理）。 */
export function boardProposals(proposals: AiProposal[]): AiProposal[] {
  return proposals.filter((proposal) => proposal.type === "add_whiteboard_node");
}

const PREVIEW_W = 180;
const PREVIEW_H = 96;
const GAP_X = 24;
const GAP_Y = 20;

/**
 * 預覽擺放：從「視野中央偏下」開始往右排，滿三個換一行。
 *
 * 刻意**不做自動避讓**（找空位塞）：那會讓使用者看不出 AI 想放哪裡，
 * 而且每次重算位置都不一樣。整齊的一排比聰明的散佈好懂 — 使用者套用後
 * 可以自己拖。
 */
export function layoutPreview(
  count: number,
  origin: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const spots: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % 3;
    const row = Math.floor(index / 3);
    spots.push({
      x: origin.x + column * (PREVIEW_W + GAP_X),
      y: origin.y + row * (PREVIEW_H + GAP_Y),
    });
  }
  return spots;
}

/** 人話摘要：套用會發生什麼（確認列用）。 */
export function describePreview(preview: BoardAiPreview): string {
  if (!preview.nodes.length) return "沒有可以放上白板的建議";
  const kinds = new Map<string, number>();
  for (const node of preview.nodes) {
    kinds.set(node.nodeType, (kinds.get(node.nodeType) ?? 0) + 1);
  }
  const label = (type: string) =>
    type === "text" ? "便利貼" : type === "mindmap" ? "心智圖" : type === "flow" ? "流程" :
    type === "room_content" ? "內容卡" : type === "decision" ? "決策" : type;
  const parts = [...kinds.entries()].map(([type, count]) => `${count} 個${label(type)}`);
  if (preview.edges.length) parts.push(`${preview.edges.length} 條連線`);
  return `會加上 ${parts.join("、")}`;
}

/**
 * 套用計畫：把預覽節點換成真 id（並同步換掉連線的端點）。
 *
 * 為什麼要換 id：預覽 id 是本機臨時值，直接寫進 DB 會讓「同一批提案套用
 * 兩次」產生重複列 —— 真 id 由呼叫端的 uuid 產生器給，每次套用都是新的
 * 一批，重複套用是使用者的選擇而不是意外。
 */
export function planApply(
  preview: BoardAiPreview,
  newId: () => string,
): { nodes: WhiteboardNode[]; edges: WhiteboardEdge[] } {
  const idMap = new Map<string, string>();
  const nodes = preview.nodes.map((node) => {
    const id = newId();
    idMap.set(node.id, id);
    return { ...node, id };
  });
  const edges = preview.edges
    .map((edge) => {
      const source = idMap.get(edge.sourceNodeId);
      const target = idMap.get(edge.targetNodeId);
      // 端點對不到就丟掉 — 半截的線在畫面上是一條指向虛空的線
      if (!source || !target) return null;
      return { ...edge, id: newId(), sourceNodeId: source, targetNodeId: target };
    })
    .filter((edge): edge is WhiteboardEdge => edge !== null);
  return { nodes, edges };
}
