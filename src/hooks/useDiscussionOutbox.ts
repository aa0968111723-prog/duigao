import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscussionMessage } from "../features/collaboration/types";
import { reconcileOutbox, type OutboxEntry } from "./discussionOutboxCore";

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
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const boundRef = useRef({ bound, boundRoomId });
  boundRef.current = { bound, boundRoomId };

  const dispatch = useCallback(async (message: DiscussionMessage) => {
    const doInsert = insertRef.current;
    if (!doInsert) return;
    const stampRoomId = boundRef.current.boundRoomId;
    const stamped = stampRoomId ? { ...message, roomId: stampRoomId } : message;
    const ok = await doInsert(stamped).catch(() => false);
    setEntries((current) => {
      const entry = current[message.id];
      if (!entry) return current;
      // 成功 ≠ 快照已包含：轉 acked 留著當 ghost，等 serverIds 對帳。
      return { ...current, [message.id]: { message: stamped, state: ok ? "acked" : "failed" } };
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
        if (!entry || entry.state !== "failed") return current;
        void dispatch(entry.message);
        return { ...current, [messageId]: { ...entry, state: "sending" } };
      });
    },
    [dispatch],
  );

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
    if (entry.state !== "acked") sendStates[id] = entry.state;
    if (!serverIds.has(id)) ghosts.push(entry.message);
  }
  ghosts.sort((a, b) => a.createdAt - b.createdAt);

  return { sendStates, ghosts, send, retry };
}
