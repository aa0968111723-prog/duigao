import { useMemo, useState } from "react";
import type { Guest, Room } from "../../lib/types";
import type { DiscussionMessage, DiscussionSupport } from "../collaboration/types";
import { RoomDiscussion } from "./RoomDiscussion";

/**
 * Single-mode 房的房級討論面：掛在對稿工作區自己的 sheet／側欄「裡面」，
 * 不是 MultiBranchRoom 的 tab 殼 — reviewer 的極簡對稿體驗不能被膨脹
 * （invariant: reviewer-progressive-disclosure / workspaces-separated）。
 *
 * 讀：room_discussion_messages（新 SSOT）＋ legacy messages 唯讀併入
 * （ADR-008：不遷移、不雙寫，新寫入一律走 sendDiscussion）。
 * 寫：只走 onSend → room_discussion_messages。
 * 草稿：自己的 local state，不與對稿工作區的 chatInput 打架。
 */
export function DiscussionDrawer({
  room,
  guest,
  userId,
  canManage,
  messages,
  legacyMessages,
  ghosts,
  supports,
  sendStates,
  onRetry,
  onSend,
  onSupport,
}: {
  room: Room;
  guest: Guest;
  userId: string;
  canManage: boolean;
  messages: DiscussionMessage[];
  legacyMessages: Room["messages"];
  ghosts: DiscussionMessage[];
  supports: DiscussionSupport[];
  sendStates: Record<string, "sending" | "failed">;
  onRetry: (messageId: string) => void;
  onSend: (input?: { body?: string; kind?: DiscussionMessage["kind"]; payload?: DiscussionMessage["payload"]; replyToId?: string }) => void;
  onSupport: (messageId: string, add: boolean) => void;
}) {
  const [draft, setDraft] = useState("");

  const feed = useMemo(() => {
    const ids = new Set(messages.map((message) => message.id));
    const merged: DiscussionMessage[] = [...messages];
    for (const ghost of ghosts) if (!ids.has(ghost.id)) { ids.add(ghost.id); merged.push(ghost); }
    // legacy 聊天列唯讀併入（顯示用；互動是 best-effort）
    for (const legacy of legacyMessages) {
      if (ids.has(legacy.id)) continue;
      merged.push({
        id: legacy.id,
        roomId: room.id,
        authorId: legacy.authorId,
        authorName: legacy.authorName,
        authorColor: legacy.authorColor,
        kind: "text",
        body: legacy.body,
        // legacy 標記：這些 id 不存在於 room_discussion_messages，
        // 支持/回覆/加入白板一律關閉（FK 會失敗）。
        payload: { legacy: true },
        createdAt: legacy.createdAt,
        updatedAt: legacy.createdAt,
      });
    }
    return merged;
  }, [messages, ghosts, legacyMessages, room.id]);

  return (
    <div className="discussion-drawer" data-testid="discussion-drawer">
      <RoomDiscussion
        api={{
          room,
          guest,
          userId,
          canManage,
          canTalk: true,
          messages: feed,
          supports,
          decisions: [],
          boards: room.whiteboards ?? [],
          hideTabs: true,
          pane: "chat",
          draft,
          setDraft,
          onSend: (input) => {
            onSend({ ...input, body: input?.body ?? draft });
            setDraft("");
          },
          onSupport,
          sendStates,
          onRetry,
          // single 房沒有投票/白板/決定的其他入口；一律隱藏（不留死按鈕），
          // reviewer progressive-disclosure 同時成立。
          showDecisions: false,
          showRoomActions: false,
          showVoiceNote: false,
          onCreatePoll: () => undefined,
          onAddToBoard: () => undefined,
          onOpenBoardNode: () => undefined,
          onCreateDecision: () => undefined,
          onFinalizeDecision: () => undefined,
        }}
      />
    </div>
  );
}
