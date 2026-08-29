import type { DiscussionMessage } from "../features/collaboration/types";

export type OutboxEntryState = "sending" | "failed" | "acked";

export interface OutboxEntry {
  message: DiscussionMessage;
  state: OutboxEntryState;
  /** 這輪失敗後已自動補送過一次（上限一次；之後只聽手動重試/online）。 */
  autoRetried?: boolean;
}

export interface OutboxRoomContext {
  prevLocalRoomId: string | null;
  prevBoundRoomId: string | null;
  localRoomId: string | null;
  boundRoomId: string | null;
}

/**
 * 房間身分變化時的 outbox 對帳（純函式，unit-testable — Grok pr01a r2 N1）。
 *
 * 三條規則，順序重要：
 *
 * 1. **Bind re-key 遷移**：綁定完成時 App 會把 room.id 從本機暫時 id 換成
 *    cloud uuid（localRoomId === boundRoomId）。此時 in-flight／failed entry
 *    的 message.roomId 還是舊本機 id — 它們屬於「同一間房」，必須改 stamp
 *    而不是被當成別房殘留刪掉。否則 pre-bind 送出的訊息在 insert 失敗時
 *    會無聲消失、無法重試。
 * 2. **補送**：綁定剛完成（prevBound null → 有值）時，屬於本房、仍在
 *    sending 的 entry 要補送（pre-bind 扣住的那些）。
 * 3. **隔離**：不屬於目前房（localRoomId／boundRoomId 都對不上）的 entry
 *    丟棄 — A 房的 ghost 不畫進 B 房、sending 不補送進 B 房。
 */
export function reconcileOutbox(
  entries: Record<string, OutboxEntry>,
  ctx: OutboxRoomContext,
): { entries: Record<string, OutboxEntry>; toFlush: DiscussionMessage[] } {
  const { prevLocalRoomId, prevBoundRoomId, localRoomId, boundRoomId } = ctx;
  let next = entries;
  const ensureCopy = () => { if (next === entries) next = { ...entries }; };

  // 1. bind re-key：本機 id → cloud id 的同房遷移。
  //    bound 與 re-key 可能分兩次 render 到達（boundRoomId 是 ref 讀值），
  //    所以條件是「local 剛換成 cloud id」而非「剛綁定」；prevBound 守門
  //    擋掉 A→B 跨房誤遷（換房時 prevBound 是 A 的 cloud id，對不上）。
  const rekeyed =
    Boolean(boundRoomId) &&
    localRoomId === boundRoomId &&
    (prevBoundRoomId === null || prevBoundRoomId === boundRoomId) &&
    Boolean(prevLocalRoomId) &&
    prevLocalRoomId !== boundRoomId;
  if (rekeyed) {
    for (const [id, entry] of Object.entries(next)) {
      if (entry.message.roomId === prevLocalRoomId) {
        ensureCopy();
        next[id] = { ...entry, message: { ...entry.message, roomId: boundRoomId! } };
      }
    }
  }

  const belongs = (message: DiscussionMessage) =>
    Boolean(
      (boundRoomId && message.roomId === boundRoomId) ||
      (localRoomId && message.roomId === localRoomId),
    );

  // 2. 綁定剛完成：屬於本房、仍在 sending 的補送
  const justBound = Boolean(boundRoomId) && prevBoundRoomId !== boundRoomId;
  const toFlush: DiscussionMessage[] = [];
  if (justBound) {
    for (const entry of Object.values(next)) {
      if (entry.state === "sending" && belongs(entry.message)) toFlush.push(entry.message);
    }
  }

  // 3. 隔離：別房的殘留一律丟
  for (const [id, entry] of Object.entries(next)) {
    if (!belongs(entry.message)) {
      ensureCopy();
      delete next[id];
    }
  }

  return { entries: next, toFlush };
}

/**
 * 這則訊息現在送得出去嗎？（PR-COMM-00）
 *
 * `room_discussion_messages` 的回覆外鍵是複合的：
 * `(reply_to_id, room_id) references room_discussion_messages (id, room_id)`。
 * 也就是**來源那一列必須已經在資料庫裡**，回覆才插得進去。
 *
 * 但是「回覆自己剛剛送出的那則」是最自然的操作之一，而 outbox 對每則訊息
 * 各發各的 insert —— 回覆的請求可以比來源的請求先到伺服器，於是回覆撞上
 * 外鍵、變成「未送出」。來源還停在 failed 的時候更是每次都撞。
 *
 * 所以送出前先確認來源已經落地。三種算落地：
 *   1. 來源在伺服器快照裡（`serverIds`）——它本來就在資料庫。
 *   2. 來源根本不在 outbox —— 那是既有的伺服器訊息。
 *   3. 來源在 outbox 且已 `acked` —— insert 已被接受，row 存在。
 *
 * 其他情況（來源還在 sending／failed）先扣住，等來源 ack 之後再送。
 * 扣住的 entry 維持 `sending`：對使用者仍然是「送出中」，因為它確實還在
 * 排隊，而不是失敗。
 */
export function isReplyParentReady(
  message: DiscussionMessage,
  entries: Record<string, OutboxEntry>,
  serverIds: ReadonlySet<string>,
): boolean {
  const parentId = message.replyToId;
  if (!parentId) return true;
  if (serverIds.has(parentId)) return true;
  const parent = entries[parentId];
  if (!parent) return true;
  return parent.state === "acked";
}

/**
 * 來源落地之後，被它擋住、還在等的回覆。
 * 只回 `sending` 的：`failed` 由重試路徑負責，不在這裡偷偷重送。
 */
export function blockedRepliesTo(
  parentId: string,
  entries: Record<string, OutboxEntry>,
): DiscussionMessage[] {
  const waiting: DiscussionMessage[] = [];
  for (const entry of Object.values(entries)) {
    if (entry.state === "sending" && entry.message.replyToId === parentId) waiting.push(entry.message);
  }
  return waiting.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 擋住這則訊息、而且**自己已經失敗**的來源 id。
 *
 * `isReplyParentReady` 會把「來源還沒落地」的回覆扣住。如果來源是暫時在飛，
 * 扣住是對的 —— 使用者看到「送出中」，因為它確實在排隊。但如果來源已經
 * `failed`，扣住就變成永遠的「送出中」：一個不會前進、也給不出重試鈕的狀態，
 * 那是假的送出中。
 *
 * 所以回覆要跟著來源一起顯示失敗，而且重試要從**來源**開始 —— 先重試回覆
 * 沒有意義，外鍵一樣會擋。
 */
export function failedBlockingParentId(
  message: DiscussionMessage,
  entries: Record<string, OutboxEntry>,
  serverIds: ReadonlySet<string>,
): string | null {
  const parentId = message.replyToId;
  if (!parentId || serverIds.has(parentId)) return null;
  const parent = entries[parentId];
  if (!parent || parent.state !== "failed") return null;
  return parentId;
}
