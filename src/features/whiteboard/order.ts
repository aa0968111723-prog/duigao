/**
 * 繪製/命中的全序（WB02，ADR-014）：(z_index, created_at, id) 三鍵。
 *
 * render 與 hit-test **必須共用這一個排序** — 兩者一旦分叉，使用者會
 * 點到「看不見的節點」（Grok wb00 F5 的反例）。frame 恆 z<0、node 恆
 * z>=0 是 DB CHECK 不變式，所以 frames 與 nodes 即使進同一條 paint
 * list 也永遠分層。
 */
import type { WhiteboardFrame, WhiteboardNode } from "../collaboration/types";

type Ordered = { zIndex?: number; createdAt: number; id: string };

export function orderCompare(a: Ordered, b: Ordered): number {
  const za = a.zIndex ?? 0;
  const zb = b.zIndex ?? 0;
  if (za !== zb) return za - zb;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 由下而上的繪製順序（stable、不改輸入陣列）。 */
export function paintOrder<T extends Ordered>(items: T[]): T[] {
  return [...items].sort(orderCompare);
}

/** 命中 = 繪製順序的由上而下第一個 — 與 paintOrder 同一把尺。 */
export function hitTest(
  nodes: WhiteboardNode[],
  worldX: number,
  worldY: number,
): WhiteboardNode | undefined {
  const ordered = paintOrder(nodes);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const node = ordered[i];
    if (
      worldX >= node.x && worldX <= node.x + node.width &&
      worldY >= node.y && worldY <= node.y + node.height
    ) {
      return node;
    }
  }
  return undefined;
}

/** frame 命中（z<0 層）：節點都沒中時才輪到 frame。 */
export function frameHit(
  frames: WhiteboardFrame[],
  worldX: number,
  worldY: number,
): WhiteboardFrame | undefined {
  const ordered = paintOrder(frames);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const frame = ordered[i];
    if (
      worldX >= frame.x && worldX <= frame.x + frame.width &&
      worldY >= frame.y && worldY <= frame.y + frame.height
    ) {
      return frame;
    }
  }
  return undefined;
}
