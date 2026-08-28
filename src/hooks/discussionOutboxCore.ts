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
