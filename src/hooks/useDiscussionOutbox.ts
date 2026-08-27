import { useCallback, useEffect, useRef, useState } from "react";
import type { DiscussionMessage } from "../features/collaboration/types";

export type OutboxState = "sending" | "failed";

interface OutboxEntry {
  message: DiscussionMessage;
  state: OutboxState;
}

/**
 * 討論訊息的送出狀態機。討論是房間殼的主面，寫入不能再 fire-and-forget：
 *
 *   - 送出中／失敗要看得到（sendStates），失敗可重試（retry）。
 *   - 樂觀列在整包快照替換（applyRemoteRoom）後仍要活著（ghosts）——
 *     room.discussion 是 wholesale replace，沒送達的訊息會被洗掉。
 *   - 綁定完成前（cloud room 還沒建立）先扣住，綁定後補送並蓋上
 *     boundRoomId — 修掉「送出時蓋到本機暫時 id 導致 FK 失敗」與
 *     「未綁定時 run() 靜默丟棄」兩個舊問題。
 *   - retry 用同一個 message id 重送；insertDiscussion 端把 duplicate-key
 *     視為成功，所以重試是冪等的，不會重複貼文。
 *   - 本機/PeerJS 模式（insert 未提供）不註冊任何 entry — IndexedDB 是
 *     那條路的真相來源，不該出現「未送出」UI。
 */
export function useDiscussionOutbox(args: {
  insert?: (message: DiscussionMessage) => Promise<boolean>;
  bound: boolean;
  boundRoomId: string | null;
  serverIds: ReadonlySet<string>;
}): {
  sendStates: Record<string, OutboxState>;
  ghosts: DiscussionMessage[];
  send: (message: DiscussionMessage) => void;
  retry: (messageId: string) => void;
} {
  const { insert, bound, boundRoomId, serverIds } = args;
  const [entries, setEntries] = useState<Record<string, OutboxEntry>>({});
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const boundRef = useRef({ bound, boundRoomId });
  boundRef.current = { bound, boundRoomId };

  const dispatch = useCallback(async (message: DiscussionMessage) => {
    const doInsert = insertRef.current;
    if (!doInsert) return;
    const stamped = boundRef.current.boundRoomId
      ? { ...message, roomId: boundRef.current.boundRoomId }
      : message;
    const ok = await doInsert(stamped).catch(() => false);
    setEntries((current) => {
      if (!current[message.id]) return current;
      if (ok) {
        const { [message.id]: _sent, ...rest } = current;
        return rest;
      }
      return { ...current, [message.id]: { message: stamped, state: "failed" } };
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

  // 綁定完成後補送 pre-bind 期間扣住的訊息。
  const flushedForRoom = useRef<string | null>(null);
  useEffect(() => {
    if (!bound || !boundRoomId || flushedForRoom.current === boundRoomId) return;
    flushedForRoom.current = boundRoomId;
    setEntries((current) => {
      for (const entry of Object.values(current)) {
        if (entry.state === "sending") void dispatch(entry.message);
      }
      return current;
    });
  }, [bound, boundRoomId, dispatch]);

  // 快照對帳：出現在 server snapshot 裡的 entry 已經送達，丟掉。
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
    sendStates[id] = entry.state;
    if (!serverIds.has(id)) ghosts.push(entry.message);
  }
  ghosts.sort((a, b) => a.createdAt - b.createdAt);

  return { sendStates, ghosts, send, retry };
}
