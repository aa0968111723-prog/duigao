import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscussionMessage } from "../features/collaboration/types";

export type OutboxState = "sending" | "failed";

interface OutboxEntry {
  message: DiscussionMessage;
  /** acked = insert 已回成功，但還沒在伺服器快照裡看到；ghost 仍要撐著。 */
  state: OutboxState | "acked";
}

/**
 * 討論訊息的送出狀態機。討論是房間殼的主面，寫入不能再 fire-and-forget：
 *
 *   - 送出中／失敗要看得到（sendStates），失敗可重試（retry）。
 *   - 樂觀列在整包快照替換後仍要活著（ghosts）— 且 **insert 回成功不等於
 *     快照已包含它**：成功後 entry 轉 acked 繼續當 ghost，直到該 id 出現在
 *     伺服器快照（serverIds）才丟棄。否則「送出成功 → 併發 reload 的舊快照
 *     蓋掉樂觀列 → 訊息消失等 echo」（Grok pr01a F4）。
 *   - entries 以房間隔離：房間切換時，roomId 不屬於目前房的 entry 一律丟棄，
 *     不會把 A 房的 ghost 畫進 B 房、更不會把 sending 補送進 B 房
 *     （Grok pr01a F3）。
 *   - 綁定完成前先扣住（roomId 還是本機暫時 id），綁定後補送並蓋上
 *     boundRoomId。
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

  const belongsToCurrentRoom = useCallback(
    (message: DiscussionMessage) =>
      Boolean(
        (boundRoomId && message.roomId === boundRoomId) ||
        (localRoomId && message.roomId === localRoomId),
      ),
    [boundRoomId, localRoomId],
  );

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
      // 未綁定：留在 sending，等 boundRoomId 到位的 effect 補送。
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

  // 房間切換：不屬於目前房的 entry 一律丟棄（含 sending — 絕不補送進別房）。
  useEffect(() => {
    setEntries((current) => {
      const stale = Object.values(current).filter((entry) => !belongsToCurrentRoom(entry.message));
      if (!stale.length) return current;
      const next = { ...current };
      for (const entry of stale) delete next[entry.message.id];
      return next;
    });
  }, [belongsToCurrentRoom]);

  // 綁定完成後補送 pre-bind 期間扣住、且屬於目前房的訊息。
  const flushedForRoom = useRef<string | null>(null);
  useEffect(() => {
    if (!bound || !boundRoomId || flushedForRoom.current === boundRoomId) return;
    flushedForRoom.current = boundRoomId;
    setEntries((current) => {
      for (const entry of Object.values(current)) {
        if (entry.state === "sending" && belongsToCurrentRoom(entry.message)) void dispatch(entry.message);
      }
      return current;
    });
  }, [bound, boundRoomId, belongsToCurrentRoom, dispatch]);

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

  const sendStates: Record<string, OutboxState> = {};
  const ghosts: DiscussionMessage[] = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (!belongsToCurrentRoom(entry.message)) continue; // 換房瞬間的殘影也不畫
    if (entry.state !== "acked") sendStates[id] = entry.state;
    if (!serverIds.has(id)) ghosts.push(entry.message);
  }
  ghosts.sort((a, b) => a.createdAt - b.createdAt);

  return { sendStates, ghosts, send, retry };
}
