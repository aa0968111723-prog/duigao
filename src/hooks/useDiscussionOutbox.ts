import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscussionMessage } from "../features/collaboration/types";
import { blockedRepliesTo, failedBlockingParentId, isReplyParentReady, reconcileOutbox, type OutboxEntry } from "./discussionOutboxCore";

export type OutboxState = "sending" | "failed";

/**
 * 討論訊息的送出狀態機。討論是房間殼的主面，寫入不能再 fire-and-forget：
 *
 *   - 送出中／失敗要看得到（sendStates），失敗可重試（retry）。
 *   - 樂觀列在整包快照替換後仍要活著（ghosts）— 且 **insert 回成功不等於
 *     快照已包含它**：成功後 entry 轉 acked 繼續當 ghost，直到該 id 出現在
 *     伺服器快照（serverIds）才丟棄（Grok pr01a F4）。
 *   - 房間身分變化（bind re-key／換房）交給 reconcileOutbox 純函式：
 *     同房 re-key 遷移、綁定補送、跨房隔離（Grok pr01a F3 + r2 N1）。
 *   - retry 用同一個 message id 重送；insert 端 duplicate-key 視為成功，
 *     所以重試冪等。
 *   - 本機/PeerJS 模式（insert 未提供）不註冊 entry — IndexedDB 是那條路
 *     的真相來源。
 */
export function useDiscussionOutbox(args: {
  insert?: (message: DiscussionMessage) => Promise<boolean>;
  bound: boolean;
  boundRoomId: string | null;
  /** 目前本機房 id（綁定前的訊息會帶這個 id）。 */
  localRoomId: string | null;
  serverIds: ReadonlySet<string>;
}): {
  sendStates: Record<string, OutboxState>;
  ghosts: DiscussionMessage[];
  send: (message: DiscussionMessage) => void;
  retry: (messageId: string) => void;
} {
  const { insert, bound, boundRoomId, localRoomId, serverIds } = args;
  const [entries, setEntries] = useState<Record<string, OutboxEntry>>({});
  // dispatch 需要讀「現在」的 entries／serverIds 才能判斷回覆的來源落地沒有，
  // 而它是 useCallback([]) 的閉包 —— 用 ref 讀，不把它們放進相依。
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const serverIdsRef = useRef(serverIds);
  serverIdsRef.current = serverIds;
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const boundRef = useRef({ bound, boundRoomId });
  boundRef.current = { bound, boundRoomId };

  const dispatch = useCallback(async (message: DiscussionMessage) => {
    const doInsert = insertRef.current;
    if (!doInsert) return;
    // 回覆的來源還沒落地就先扣住：複合外鍵 (reply_to_id, room_id) 要求來源那
    // 一列已經在資料庫裡，先送會撞外鍵變成「未送出」。來源 ack 之後下面會
    // 把它放出去。entry 維持 sending —— 它確實還在排隊，不是失敗。
    if (!isReplyParentReady(message, entriesRef.current, serverIdsRef.current)) return;
    const stampRoomId = boundRef.current.boundRoomId;
    const stamped = stampRoomId ? { ...message, roomId: stampRoomId } : message;
    const ok = await doInsert(stamped).catch(() => false);
    setEntries((current) => {
      const entry = current[message.id];
      if (!entry) return current;
      // acked 永不降級（Grok 08b F1）：並行雙發（DEV updater 重跑）時
      // 晚到的失敗回呼不得把已確認的列打回 failed。
      if (entry.state === "acked") return current;
      if (ok) {
        // 成功 ≠ 快照已包含：轉 acked 留著當 ghost，等 serverIds 對帳。
        const next = { ...current, [message.id]: { message: stamped, state: "acked" as const } };
        // 來源落地了 → 被它擋住的回覆現在送得出去。
        for (const waiting of blockedRepliesTo(message.id, next)) void dispatch(waiting);
        return next;
      }
      // 死區 fetch 懸掛→abort 落地時網路常已恢復（PR-08b）：onLine 且
      // 這輪還沒自動補送過 → 立刻補一次（id 不變，重複=duplicate-key=
      // 成功）。上限一次 — 之後誠實 failed，等手動重試或 online 事件。
      if (typeof navigator !== "undefined" && navigator.onLine && !entry.autoRetried) {
        void dispatch(stamped);
        return { ...current, [message.id]: { message: stamped, state: "sending", autoRetried: true } };
      }
      return { ...current, [message.id]: { message: stamped, state: "failed", autoRetried: entry.autoRetried } };
    });
  }, []);

  const send = useCallback(
    (message: DiscussionMessage) => {
      if (!insertRef.current) return; // 本機模式：IndexedDB 是真相來源
      setEntries((current) => ({ ...current, [message.id]: { message, state: "sending" } }));
      if (boundRef.current.bound) void dispatch(message);
      // 未綁定：留在 sending，reconcile 的綁定補送會處理。
    },
    [dispatch],
  );

  const retry = useCallback(
    (messageId: string) => {
      setEntries((current) => {
        const entry = current[messageId];
        if (!entry) return current;
        // 回覆卡在失敗的來源後面時，重試要從來源開始 —— 先重送回覆一樣會
        // 撞外鍵。來源 ack 之後 dispatch 會把等著的回覆放出去。
        const blockingId = failedBlockingParentId(entry.message, current, serverIdsRef.current);
        if (blockingId) {
          const parent = current[blockingId];
          if (!parent) return current;
          void dispatch(parent.message);
          return { ...current, [blockingId]: { ...parent, state: "sending", autoRetried: false } };
        }
        if (entry.state !== "failed") return current;
        void dispatch(entry.message);
        // 手動重試重置 autoRetried：這是新的一輪。
        return { ...current, [messageId]: { ...entry, state: "sending", autoRetried: false } };
      });
    },
    [dispatch],
  );

  // 回網：failed 的一次性 flush（outbox 仍是唯一 retry owner — 這裡就是
  // outbox 自己）。sending 不碰（in-flight 或等 abort deadline）。
  useEffect(() => {
    const onOnline = () => {
      setEntries((current) => {
        let changed = false;
        const next: typeof current = { ...current };
        for (const [id, entry] of Object.entries(current)) {
          if (entry.state !== "failed") continue;
          changed = true;
          void dispatch(entry.message);
          next[id] = { ...entry, state: "sending", autoRetried: true };
        }
        return changed ? next : current;
      });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [dispatch]);

  // 房間身分變化：遷移（同房 re-key）→ 補送（剛綁定）→ 隔離（別房殘留）。
  const prevRoomRef = useRef<{ local: string | null; bound: string | null }>({ local: null, bound: null });
  useEffect(() => {
    const prev = prevRoomRef.current;
    prevRoomRef.current = { local: localRoomId, bound: boundRoomId };
    setEntries((current) => {
      const { entries: next, toFlush } = reconcileOutbox(current, {
        prevLocalRoomId: prev.local,
        prevBoundRoomId: prev.bound,
        localRoomId,
        boundRoomId,
      });
      for (const message of toFlush) void dispatch(message);
      return next;
    });
  }, [localRoomId, boundRoomId, dispatch]);

  // 快照對帳：出現在伺服器快照裡的 entry 才真正落地，丟棄。
  useEffect(() => {
    setEntries((current) => {
      const landed = Object.keys(current).filter((id) => serverIds.has(id));
      if (!landed.length) return current;
      const next = { ...current };
      for (const id of landed) delete next[id];
      return next;
    });
  }, [serverIds]);

  const belongsNow = (message: DiscussionMessage) =>
    Boolean(
      (boundRoomId && message.roomId === boundRoomId) ||
      (localRoomId && message.roomId === localRoomId),
    );

  const sendStates: Record<string, OutboxState> = {};
  const ghosts: DiscussionMessage[] = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (!belongsNow(entry.message)) continue; // 換房瞬間的殘影也不畫
    // 卡在失敗來源後面的回覆一起顯示失敗：永遠的「送出中」是假的送出中。
    if (entry.state !== "acked") {
      sendStates[id] = failedBlockingParentId(entry.message, entries, serverIds) ? "failed" : entry.state;
    }
    if (!serverIds.has(id)) ghosts.push(entry.message);
  }
  ghosts.sort((a, b) => a.createdAt - b.createdAt);

  return { sendStates, ghosts, send, retry };
}
