import type { DiscussionKind, DiscussionMessage } from "./types";

/**
 * 回覆引用的解析（PR-COMM-00）。
 *
 * 稽核發現：composer 送出回覆時把來源訊息的 body **複製**進
 * `payload.quotedBody`，而畫面只讀那份複製品 — `replyToId` 從資料庫讀回來
 * 之後沒有任何 UI 讀它（`grep -rn replyToId src/` 只有寫入端）。後果有三：
 *
 *   1. 引用點不下去 — 使用者看得到「他說了什麼」，卻回不到那句話在哪。
 *   2. 來源被編輯之後引用還停在舊字，畫面上兩句話對不起來。
 *   3. 引用變成失去來源的孤立內容（違反「不得複製出失去來源的孤立內容」）。
 *
 * 這裡把引用改成**解析**而不是複製：來源還在就一律用來源的現值，來源不在
 * 就誠實說「來源不在這份對話裡」，並把當初的快照標示成快照 —— 絕不假裝
 * 那是來源的現況。解析是純函式，因為它要能被兩端（房間殼與 drawer）共用，
 * 而且要能在沒有瀏覽器的情況下被測試。
 *
 * 「來源不在」有兩種真實成因，資料上分不出來，所以不猜：
 *   - 回覆比來源先到（Realtime nudge 後的快照還沒含來源）；
 *   - 來源被刪除（0014 的 FK 是 `on delete set null`，刪除會把
 *     `reply_to_id` 清成 NULL，連指標都不留 — 見 KNOWN_LIMITATIONS）。
 */

export type ReplyReference =
  | { state: "none" }
  | {
      state: "resolved";
      sourceId: string;
      authorName: string;
      authorColor: string;
      kind: DiscussionKind;
      snippet: string;
      /** 來源在這之後被編輯過（送出當下的快照與現值不同）。 */
      edited: boolean;
    }
  | {
      state: "missing";
      sourceId: string;
      /** 送出當下留下的快照。是快照，不是來源現況 — 呈現時必須這樣說。 */
      snapshot: string | null;
    };

/** 引用摘要的上限：一到兩行，手機上不吃掉訊息卡。 */
export const REPLY_SNIPPET_MAX = 80;

/**
 * 一則訊息在引用列裡該顯示什麼。`body` 對純文字就是內容；對附件／連結／
 * 白板卡，body 可能是檔名或 URL，光看它讀不出「這是什麼」，所以按 kind
 * 補一個前綴。空 body 不留白 —— 空白引用等於沒有引用。
 */
export function replySnippet(message: Pick<DiscussionMessage, "kind" | "body" | "payload">): string {
  const body = (message.body ?? "").replace(/\s+/g, " ").trim();
  const title = (message.payload?.title ?? "").toString().trim();
  const label = (() => {
    switch (message.kind) {
      case "attachment":
        return `📎 ${(message.payload?.name ?? "").toString().trim() || title || body || "附件"}`;
      case "link":
        return `🔗 ${title || body || (message.payload?.href ?? "").toString()}`;
      case "whiteboard":
      case "node":
        return `▦ ${title || body || "白板"}`;
      case "poster":
      case "video":
      case "plan":
        return `▧ ${title || body || "房間內容"}`;
      case "poll":
        return `☑ ${title || body || "投票"}`;
      case "decision":
        return `✓ ${title || body || "決策"}`;
      default:
        return body || title;
    }
  })();
  const flat = label.replace(/\s+/g, " ").trim();
  if (!flat) return "（沒有文字內容）";
  return flat.length > REPLY_SNIPPET_MAX ? `${flat.slice(0, REPLY_SNIPPET_MAX - 1)}…` : flat;
}

/**
 * 把一則訊息的 `replyToId` 解析成可呈現、可點擊的引用。
 *
 * `byId` 是目前這份對話裡看得到的訊息（含 outbox ghost）。來源在就用現值；
 * 不在就回 `missing` —— 呼叫端據此顯示「來源不在這份對話裡」而不是假裝
 * 引用還有效。自我回覆（replyToId === 自己）視為沒有引用：那是壞資料，
 * 讓它渲染成無限自指沒有意義。
 */
export function resolveReply(
  message: Pick<DiscussionMessage, "id" | "replyToId" | "payload">,
  byId: ReadonlyMap<string, DiscussionMessage>,
): ReplyReference {
  const sourceId = message.replyToId;
  if (!sourceId || sourceId === message.id) {
    return { state: "none" };
  }
  const source = byId.get(sourceId);
  if (!source) {
    const snapshot = (message.payload?.quotedBody ?? "").toString().trim();
    return { state: "missing", sourceId, snapshot: snapshot || null };
  }
  const snippet = replySnippet(source);
  const snapshot = (message.payload?.quotedBody ?? "").toString().trim();
  return {
    state: "resolved",
    sourceId,
    authorName: source.authorName,
    authorColor: source.authorColor,
    kind: source.kind,
    snippet,
    // 快照存在且與來源現值不同 → 來源在這之後被改過。沒有快照就不宣稱。
    edited: Boolean(snapshot) && snapshot !== (source.body ?? "").replace(/\s+/g, " ").trim(),
  };
}

/** 對話清單 → id 索引。ghost（尚未落地的樂觀列）也要在裡面，否則剛送出的回覆會顯示「來源不在」。 */
export function indexMessages(messages: readonly DiscussionMessage[]): Map<string, DiscussionMessage> {
  const map = new Map<string, DiscussionMessage>();
  for (const message of messages) map.set(message.id, message);
  return map;
}
