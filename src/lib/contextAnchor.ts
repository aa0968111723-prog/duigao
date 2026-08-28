/**
 * ContextAnchor 契約層（ADR-004，PR-02d）。
 *
 * 房間裡「這則內容指著什麼」目前存在三套機制，各自有欄位與編解碼：
 *
 *  1. 意見列（comments）：anchor_type / time_seconds / end_time_seconds
 *     ＋ region jsonb ＋ x/y（0003、0006 migrations 是欄位的最終權威）。
 *  2. 白板節點：linkedEntityType / linkedEntityId ＋ content.startTime/endTime。
 *  3. 討論 payload：branchId / versionId / whiteboardId / nodeId / pollId /
 *     decisionId ＋ startTime/endTime。
 *
 * 這一層不新增第四套機制、不動 DB —— 它是三套機制之間的翻譯契約：
 * 每個 adapter 一邊是某機制的實際列/物件形狀，另一邊是 ContextAnchor。
 * 舊 codec（cloud/types.ts anchorFromRow、roomRepository anchorColumns、
 * links.ts discussionPayloadFromNode、ai/proposals 的 link 正規化）委派到
 * 這裡，行為不變。
 *
 * 已知缺口（契約點名、本 PR 不解）：
 *  - 意見列無法錨到 whiteboard_node（沒有欄位）。
 *  - （WB01 已補）message 與 plan-section 臂 — 意見列仍無表示法，
 *    節點/討論兩機制有。
 *  - entity 錨的 plan / asset / discussion 臂沒有討論 payload 表示法
 *    （anchorToDiscussionPayload 回空）。
 *
 * union 刻意保持可擴充：PR-06 的 3D 錨（planform）將是新臂。消費端
 * switch 一律要有 default（回 none / 空物件），新臂才不會炸舊碼。
 */
import type { AnnotationRegion, VideoAnchor } from "./types";
import { normalizeRegion } from "./region";
// features/collaboration/types 是葉模組（零 import）：從 lib 取用其封閉
// 詞彙表不成環。LINKED_ENTITY_TYPES 是 entity 臂的唯一權威，不得複製。
import { LINKED_ENTITY_TYPES, type LinkedEntityType } from "../features/collaboration/types";
import type { DiscussionPayload, WhiteboardNode } from "../features/collaboration/types";

export type ContextAnchor =
  | { type: "image-point"; x: number; y: number; versionId?: string }
  | { type: "image-region"; region: AnnotationRegion; versionId?: string }
  | { type: "video-point"; time: number; versionId?: string; branchId?: string }
  | { type: "video-range"; startTime: number; endTime: number; versionId?: string; branchId?: string }
  // entity / board-node 臂刻意無版本：來源機制沒有版本事實，捏造 versionId
  // 是假資料（implementation-plan 裁定）。
  | { type: "entity"; entityType: LinkedEntityType; entityId: string }
  | { type: "board-node"; whiteboardId: string; nodeId?: string }
  // 3D 場佈錨（PR-06 / ADR-006）：指向 planform project 裡的某個
  // zone/object。三套既有機制目前都沒有它的表示法（已知缺口 —
  // adapters 回空、openTarget 回 none）；第二階段 live embed 探測完
  // host headers 後由 planform 表面自己消費。
  | { type: "planform-scene"; projectId: string; targetId?: string }
  // WB01（任務書 §14）：訊息錨（白板節點的 provenance — createSticky 的
  // 「回得去原訊息」）與企劃段落錨。sectionId 是 plan_documents 內容裡的
  // 段落識別（client 產生的穩定 id；DB 無獨立段落表 — 誠實記錄）。
  | { type: "message"; messageId: string }
  | { type: "plan-section"; branchId: string; sectionId?: string };

/** 有 comment 欄位表示法的臂 — entity/board-node 寫不進意見列（已知缺口）。 */
export type MediaAnchor = Extract<
  ContextAnchor,
  { type: "image-point" | "image-region" | "video-point" | "video-range" }
>;

const finiteTime = (value: unknown): number | null => {
  const time = Number(value);
  return Number.isFinite(time) && time >= 0 ? time : null;
};

// ---- 機制 1：意見列（0003 region、0006 time anchors） ---------------------

/** 結構型輸入：cloud 的 CommentRow 直接滿足，lib 不需要 import cloud。 */
export type CommentAnchorColumns = {
  anchor_type?: string | null;
  time_seconds?: number | null;
  end_time_seconds?: number | null;
  region?: unknown;
  x?: number | null;
  y?: number | null;
  version_id?: string | null;
};

/**
 * 意見列 → 錨。與 0006 的 derive trigger 同一份契約：缺 anchor_type 的
 * legacy 列從 region 有無推回 image-region / image-point；宣稱 video 但
 * 數字不可用的列同樣退回 image 語意（與 anchorFromRow 一致 —— 讀到
 * 說不通的列時，最接近真話的讀法勝過 NaN）。
 */
export function anchorFromCommentColumns(cols: CommentAnchorColumns): ContextAnchor {
  const versionId = cols.version_id ?? undefined;
  const kind = cols.anchor_type ?? "";
  if (kind.startsWith("video-")) {
    const time = finiteTime(cols.time_seconds);
    if (time !== null) {
      const end = Number(cols.end_time_seconds);
      if (kind === "video-range" && Number.isFinite(end) && end > time) {
        return { type: "video-range", startTime: time, endTime: end, versionId };
      }
      return { type: "video-point", time, versionId };
    }
  }
  const region = normalizeRegion(cols.region);
  if (region) return { type: "image-region", region, versionId };
  return { type: "image-point", x: Number(cols.x) || 0, y: Number(cols.y) || 0, versionId };
}

/** 意見 pin（domain 側）→ 錨。region/anchor 已是正規化後的 domain 值。 */
export function anchorFromComment(pin: {
  x: number;
  y: number;
  region?: AnnotationRegion | null;
  anchor?: VideoAnchor;
  versionId?: string;
}): MediaAnchor {
  if (pin.anchor?.kind === "range") {
    return { type: "video-range", startTime: pin.anchor.startTime, endTime: pin.anchor.endTime, versionId: pin.versionId };
  }
  if (pin.anchor?.kind === "point") {
    return { type: "video-point", time: pin.anchor.time, versionId: pin.versionId };
  }
  if (pin.region) return { type: "image-region", region: pin.region, versionId: pin.versionId };
  return { type: "image-point", x: pin.x, y: pin.y, versionId: pin.versionId };
}

/**
 * 錨 → 意見列的 anchor 欄位。輸出形狀與 roomRepository 的 anchorColumns
 * 逐欄相同（image 臂 time 欄一律 null；region 本體另走 0003 的 region 欄，
 * 不在這個函式的責任裡）。
 */
export function anchorToCommentColumns(anchor: MediaAnchor): {
  anchor_type: string;
  time_seconds: number | null;
  end_time_seconds: number | null;
} {
  switch (anchor.type) {
    case "video-range":
      return { anchor_type: "video-range", time_seconds: anchor.startTime, end_time_seconds: anchor.endTime };
    case "video-point":
      return { anchor_type: "video-point", time_seconds: anchor.time, end_time_seconds: null };
    case "image-region":
      return { anchor_type: "image-region", time_seconds: null, end_time_seconds: null };
    default:
      return { anchor_type: "image-point", time_seconds: null, end_time_seconds: null };
  }
}

// ---- 機制 2：白板節點 link ------------------------------------------------

type NodeLinkFields = Pick<WhiteboardNode, "id" | "whiteboardId" | "content"> &
  Partial<Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId">>;

/**
 * 節點 → 錨。link 齊備（type＋id）才算數 —— 半截 link 在讀側從來讀不出
 * 東西，這裡把同一條規則講明。version 或 branch link 帶 content.startTime
 * 時升級成 video 錨（節點指著影片的某一刻/某一段）。
 */
export function anchorFromNode(node: NodeLinkFields): ContextAnchor {
  if (node.linkedEntityType && node.linkedEntityId) {
    // version link（placeAsset/AI）與 branch link（placeBranch 的影片段落
    // 上板）都可能帶 content.startTime — 兩者都是 video 錨，各自帶回
    // 自己真實知道的 id，不互相捏造。
    if (node.linkedEntityType === "version" || node.linkedEntityType === "branch") {
      const start = finiteTime(node.content.startTime);
      if (start !== null) {
        const ids =
          node.linkedEntityType === "version"
            ? { versionId: node.linkedEntityId }
            : { branchId: node.linkedEntityId };
        const end = Number(node.content.endTime);
        if (Number.isFinite(end) && end > start) {
          return { type: "video-range", startTime: start, endTime: end, ...ids };
        }
        return { type: "video-point", time: start, ...ids };
      }
    }
    return { type: "entity", entityType: node.linkedEntityType, entityId: node.linkedEntityId };
  }
  return { type: "board-node", whiteboardId: node.whiteboardId, nodeId: node.id };
}

/**
 * 錨 → 節點的 link 欄位（給節點工廠/AI apply 展開用）。board-node 臂回空：
 * 節點本身就是它的板上錨，不需要 link 自己。image 臂在節點機制沒有表示法。
 */
export function anchorToNodeLink(anchor: ContextAnchor): {
  linkedEntityType?: LinkedEntityType;
  linkedEntityId?: string;
  content?: { startTime?: number; endTime?: number };
} {
  const videoLink = (times: { startTime?: number; endTime?: number }, branchId?: string, versionId?: string) => {
    // 節點機制只有一個 link 位：branch 是可導航的那個事實，優先；
    // 沒有 branch 才寫 version。兩者皆無 → 無表示法。
    if (branchId) return { linkedEntityType: "branch" as const, linkedEntityId: branchId, content: times };
    if (versionId) return { linkedEntityType: "version" as const, linkedEntityId: versionId, content: times };
    return {};
  };
  switch (anchor.type) {
    case "message":
      // 'discussion' 在 0014 的 CHECK 詞彙裡從第一天就存在、至今零生產者
      // （audit §7 的 provenance 缺口）— 這裡是它的第一個合法寫入路徑。
      return { linkedEntityType: "discussion", linkedEntityId: anchor.messageId };
    case "plan-section":
      // 節點機制單 link 位：段落細節（sectionId）由節點的 anchor jsonb 欄
      // 保存（0021），link 只到分支層級。
      return { linkedEntityType: "plan", linkedEntityId: anchor.branchId };
    case "entity":
      return { linkedEntityType: anchor.entityType, linkedEntityId: anchor.entityId };
    case "video-point":
      return videoLink({ startTime: anchor.time }, anchor.branchId, anchor.versionId);
    case "video-range":
      return videoLink({ startTime: anchor.startTime, endTime: anchor.endTime }, anchor.branchId, anchor.versionId);
    default:
      return {};
  }
}

/** 封閉詞彙檢查後的 entity 錨；type 或 id 缺一即 null（不產半截 link）。 */
export function entityAnchor(entityType: string, entityId: string): ContextAnchor | null {
  if (!entityId) return null;
  if (!(LINKED_ENTITY_TYPES as readonly string[]).includes(entityType)) return null;
  return { type: "entity", entityType: entityType as LinkedEntityType, entityId };
}

// ---- 機制 3：討論 payload -------------------------------------------------

/**
 * 討論 payload → 錨。優先序：板（whiteboardId）＞內容分支（branchId，帶
 * startTime 時升級 video 錨）＞version/poll/decision。什麼都沒指 → null
 * （純文字/附件卡沒有錨）。
 */
export function anchorFromDiscussion(payload: DiscussionPayload): ContextAnchor | null {
  // 優先權（Grok wb01 F7）：whiteboardId 維持最高 — 既有 board-node 生產者
  // 的 payload 永不被新臂遮蔽；messageId 只在沒有板參照時生效。
  if (payload.whiteboardId) {
    return { type: "board-node", whiteboardId: payload.whiteboardId, nodeId: payload.nodeId };
  }
  if (payload.messageId) {
    return { type: "message", messageId: payload.messageId };
  }
  if (payload.branchId && payload.planSectionId) {
    return { type: "plan-section", branchId: payload.branchId, sectionId: payload.planSectionId };
  }
  if (payload.whiteboardId) {
    return { type: "board-node", whiteboardId: payload.whiteboardId, nodeId: payload.nodeId };
  }
  if (payload.branchId) {
    const start = finiteTime(payload.startTime);
    if (start !== null) {
      const end = Number(payload.endTime);
      if (Number.isFinite(end) && end > start) {
        return { type: "video-range", startTime: start, endTime: end, branchId: payload.branchId };
      }
      return { type: "video-point", time: start, branchId: payload.branchId };
    }
    return { type: "entity", entityType: "branch", entityId: payload.branchId };
  }
  if (payload.versionId) return { type: "entity", entityType: "version", entityId: payload.versionId };
  if (payload.pollId) return { type: "entity", entityType: "poll", entityId: payload.pollId };
  if (payload.decisionId) return { type: "entity", entityType: "decision", entityId: payload.decisionId };
  return null;
}

/**
 * 錨 → 討論 payload 的參照欄位（title/thumbnail 等呈現欄位是呼叫端的事）。
 * plan / asset / discussion entity 臂與 image 臂在這套機制沒有表示法（已知
 * 缺口，回空物件）；whiteboard entity 臂視為板參照。
 */
export function anchorToDiscussionPayload(anchor: ContextAnchor): DiscussionPayload {
  switch (anchor.type) {
    case "message":
      return { messageId: anchor.messageId };
    case "plan-section":
      return anchor.sectionId
        ? { branchId: anchor.branchId, planSectionId: anchor.sectionId }
        : { branchId: anchor.branchId };
    case "board-node":
      return anchor.nodeId
        ? { whiteboardId: anchor.whiteboardId, nodeId: anchor.nodeId }
        : { whiteboardId: anchor.whiteboardId };
    case "entity":
      switch (anchor.entityType) {
        case "branch":
          return { branchId: anchor.entityId };
        case "version":
          return { versionId: anchor.entityId };
        case "poll":
          return { pollId: anchor.entityId };
        case "decision":
          return { decisionId: anchor.entityId };
        case "whiteboard":
          return { whiteboardId: anchor.entityId };
        default:
          return {};
      }
    case "video-point":
      if (anchor.branchId) return { branchId: anchor.branchId, startTime: anchor.time };
      return anchor.versionId ? { versionId: anchor.versionId, startTime: anchor.time } : {};
    case "video-range":
      if (anchor.branchId) return { branchId: anchor.branchId, startTime: anchor.startTime, endTime: anchor.endTime };
      return anchor.versionId
        ? { versionId: anchor.versionId, startTime: anchor.startTime, endTime: anchor.endTime }
        : {};
    default:
      return {};
  }
}

// ---- 導航契約 -------------------------------------------------------------

/**
 * 「點了這個錨要打開什麼」的單一答案。餵 App 現有的三個 handler：
 * board → onOpenBoardNode、content → onOpenBranch/onOpenContent（startTime
 * 進 setOpenAtSeconds）、entity → 各實體自己的打開路徑。導航「怎麼開」是
 * App 的事；這裡只回答「開什麼」。
 */
export type OpenTarget =
  | { surface: "board"; whiteboardId: string; nodeId?: string }
  | { surface: "content"; branchId: string; startTime?: number }
  | { surface: "entity"; entityType: LinkedEntityType; entityId: string }
  | { surface: "discussion"; messageId: string }
  | { surface: "none" };

export function openTarget(anchor: ContextAnchor | null): OpenTarget {
  if (!anchor) return { surface: "none" };
  switch (anchor.type) {
    case "message":
      return { surface: "discussion", messageId: anchor.messageId };
    case "plan-section":
      return { surface: "content", branchId: anchor.branchId };
    case "board-node":
      return { surface: "board", whiteboardId: anchor.whiteboardId, nodeId: anchor.nodeId };
    case "video-point":
      return anchor.branchId
        ? { surface: "content", branchId: anchor.branchId, startTime: anchor.time }
        : { surface: "none" };
    case "video-range":
      return anchor.branchId
        ? { surface: "content", branchId: anchor.branchId, startTime: anchor.startTime }
        : { surface: "none" };
    case "entity":
      return anchor.entityType === "branch"
        ? { surface: "content", branchId: anchor.entityId }
        : { surface: "entity", entityType: anchor.entityType, entityId: anchor.entityId };
    default:
      return { surface: "none" };
  }
}
