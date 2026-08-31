import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { BranchRow, CommentRow, MessageRow, PlanRow, PollRow, PollVoteRow, ProposalRow, RelationRow, RoomRow, StrokeRow, VersionRow } from "./types";
import type { EdgeRow, NodeRow, FrameRow } from "./collaborationRepository";
import { acceptRealtimePayload } from "./realtimeApply";
import { realtimeSubscribeIsJoined } from "./realtimeHonesty";

export type SyncHandlers = {
  onRoom?: (row: RoomRow) => void;
  onCommentUpsert?: (row: CommentRow) => void;
  onStrokeInsert?: (row: StrokeRow) => void;
  onStrokeDelete?: (id: string) => void;
  onMessageInsert?: (row: MessageRow) => void;
  onVersionInsert?: (row: VersionRow) => void;
  onProposalUpsert?: (row: ProposalRow) => void;
  onFeedbackChange?: () => void;
  onProjectChange?: () => void;
  /** 開著的白板即時 row-patch（PR-02c）：不再整房 reload。 */
  onBoardNodeUpsert?: (row: NodeRow) => void;
  onBoardNodeDelete?: (id: string) => void;
  /** frames 即時（WB04）：WB03 只在開板時載一次，別人建的區塊看不到。 */
  onBoardFrameUpsert?: (row: FrameRow) => void;
  onBoardFrameDelete?: (id: string) => void;
  onBoardEdgeInsert?: (row: EdgeRow) => void;
  onBoardEdgeDelete?: (id: string) => void;
  onPresence?: (count: number) => void;
  /** 具名在場者（WB04）：誰在線上、各自開著哪塊板。無游標流。 */
  onPresenceList?: (people: PresencePerson[]) => void;
  /**
   * 目前開著的白板 id。channel 重建時 track 的初值就靠它 — 舊寫法初始化成
   * null，重訂閱後即使人還在板上也顯示「不在板上」，要等下一次開關板才
   * 修正（Grok F3）。**刻意不含姓名**：presence payload 沒有 RLS（P1）。
   */
  getPresenceIdentity?: () => { boardId: string | null; focusNodeId?: string | null };
  onStatus?: (connected: boolean) => void;
  /** 討論列增量：不走整房 reload。SPA HTML / 無 id 的 payload 在此丟棄。 */
  onDiscussionUpsert?: (row: Record<string, unknown>) => void;
  onDiscussionDelete?: (id: string) => void;
};

function acceptedRow(payload: unknown): Record<string, unknown> | null {
  const result = acceptRealtimePayload(payload);
  return result.ok ? result.row : null;
}

export type Unsubscribe = () => void;

/**
 * Subscribe to a room's row changes (RLS-scoped) plus presence for the online
 * count. Realtime is transient: the source of truth stays in Postgres, so a
 * missed event is healed by the next loadRoom.
 */
export type PresencePerson = {
  /** presence key＝auth uid。姓名不走線路（P1），由客戶端對照成員清單。 */
  userId: string;
  /** 這個人此刻開著的白板 id（null＝不在白板上）。 */
  boardId: string | null;
  /** 房間焦點節點 id。不透明 uuid，不含姓名（P1 與 boardId 同一紀律）。 */
  focusNodeId: string | null;
  at: number;
};

export type RoomSubscription = Unsubscribe & {
  /** 身分或所在板變了：重新 track（開關板時呼叫，不是每次移動）。 */
  retrack: () => void;
};

export async function subscribeRoom(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
  handlers: SyncHandlers,
): Promise<RoomSubscription> {
  const topic = `room:${roomId}`;
  // channel() reuses a leftover joined channel; adding .on() after subscribe()
  // throws and used to flip a loaded empty room into a fake load-error.
  const leftovers = supabase.getChannels().filter((ch) => ch.topic === `realtime:${topic}` || ch.topic === topic);
  await Promise.all(leftovers.map((ch) => supabase.removeChannel(ch)));
  const filter = `room_id=eq.${roomId}`;
  const channel: RealtimeChannel = supabase.channel(topic, {
    config: { presence: { key: userId } },
  });
  // **不送姓名**（自審 P1）：Realtime 的 presence 是 channel 層的東西，
  // postgres_changes 有 RLS 擋、presence 沒有 — 這個 topic 名稱只含房間
  // uuid（邀請連結裡就有），任何持公開 anon key 的人都能 join 並讀到
  // payload。WB04 一度把姓名與「開著哪塊板」放進來，等於把成員名單publish
  // 給房外。現在只送不透明的 id 與 boardId（id 本來就是 presence key），
  // 姓名在客戶端用房內成員清單（走 RLS）對照出來。
  const trackPayload = () => {
    const live = handlers.getPresenceIdentity?.() ?? { boardId: null, focusNodeId: null };
    const focusNodeId = typeof live.focusNodeId === "string" && live.focusNodeId.trim()
      ? live.focusNodeId.trim()
      : null;
    return { at: Date.now(), boardId: live.boardId, focusNodeId };
  };

  channel
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `id=eq.${roomId}` }, (p) =>
      handlers.onRoom?.(p.new as RoomRow),
    )
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "comments", filter }, (p) =>
      handlers.onCommentUpsert?.(p.new as CommentRow),
    )
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "comments", filter }, (p) =>
      handlers.onCommentUpsert?.(p.new as CommentRow),
    )
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "strokes", filter }, (p) =>
      handlers.onStrokeInsert?.(p.new as StrokeRow),
    )
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "strokes", filter: undefined }, (p) => {
      const id = (p.old as { id?: string })?.id;
      if (id) handlers.onStrokeDelete?.(id);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter }, (p) =>
      handlers.onMessageInsert?.(p.new as MessageRow),
    )
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "versions", filter }, (p) =>
      handlers.onVersionInsert?.(p.new as VersionRow),
    )
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "visual_proposals", filter }, (p) =>
      handlers.onProposalUpsert?.(p.new as ProposalRow),
    )
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "visual_proposals", filter }, (p) =>
      handlers.onProposalUpsert?.(p.new as ProposalRow),
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "comment_supports", filter }, () =>
      handlers.onFeedbackChange?.(),
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "comment_replies", filter }, () =>
      handlers.onFeedbackChange?.(),
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "proposal_preferences", filter }, () =>
      handlers.onFeedbackChange?.(),
    )
    .on("postgres_changes", { event: "*", schema: "public", table: "room_branches", filter }, (p) => {
      void (p.new as BranchRow | undefined);
      handlers.onProjectChange?.();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "plan_documents", filter }, (p) => {
      void (p.new as PlanRow | undefined);
      handlers.onProjectChange?.();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "content_relations", filter }, (p) => {
      void (p.new as RelationRow | undefined);
      handlers.onProjectChange?.();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "room_polls", filter }, (p) => {
      void (p.new as PollRow | undefined);
      handlers.onProjectChange?.();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "room_poll_votes", filter }, (p) => {
      void (p.new as PollVoteRow | undefined);
      handlers.onProjectChange?.();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "whiteboards", filter }, () => handlers.onProjectChange?.())
    // 白板節點/邊改 row-patch：開著的板直接收增量，不觸發整房快照
    // （summary 的 nodes 本來就是空的，nudge 對開板是純浪費 — PR-02c）。
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "whiteboard_nodes", filter }, (p) =>
      handlers.onBoardNodeUpsert?.(p.new as NodeRow),
    )
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "whiteboard_nodes", filter }, (p) =>
      handlers.onBoardNodeUpsert?.(p.new as NodeRow),
    )
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "whiteboard_nodes", filter: undefined }, (p) => {
      const id = (p.old as { id?: string })?.id;
      if (id) handlers.onBoardNodeDelete?.(id);
    })
    // frames（0023）：與節點同樣走 row-patch — 不觸發整房快照
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "whiteboard_frames", filter }, (p) =>
      handlers.onBoardFrameUpsert?.(p.new as FrameRow),
    )
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "whiteboard_frames", filter }, (p) =>
      handlers.onBoardFrameUpsert?.(p.new as FrameRow),
    )
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "whiteboard_frames", filter: undefined }, (p) => {
      const id = (p.old as { id?: string })?.id;
      if (id) handlers.onBoardFrameDelete?.(id);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "whiteboard_edges", filter }, (p) =>
      handlers.onBoardEdgeInsert?.(p.new as EdgeRow),
    )
    // edge UPDATE（WB04）：0022 之後 edges 有 label/handle/version 可以改，
    // 但只訂了 INSERT/DELETE — 別人改的線標籤在對方重載前都看不到。
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "whiteboard_edges", filter }, (p) =>
      handlers.onBoardEdgeInsert?.(p.new as EdgeRow),
    )
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "whiteboard_edges", filter: undefined }, (p) => {
      const id = (p.old as { id?: string })?.id;
      if (id) handlers.onBoardEdgeDelete?.(id);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "room_discussion_messages", filter }, (p) => {
      const row = acceptedRow(p.new);
      if (row) handlers.onDiscussionUpsert?.(row);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "room_discussion_messages", filter }, (p) => {
      const row = acceptedRow(p.new);
      if (row) handlers.onDiscussionUpsert?.(row);
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "room_discussion_messages", filter: undefined }, (p) => {
      const id = (p.old as { id?: string })?.id;
      if (id) handlers.onDiscussionDelete?.(id);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "room_discussion_supports", filter }, () => handlers.onProjectChange?.())
    .on("postgres_changes", { event: "*", schema: "public", table: "decision_records", filter }, () => handlers.onProjectChange?.())
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, Array<Record<string, unknown>>>;
      handlers.onPresence?.(Object.keys(state).length);
      const people: PresencePerson[] = [];
      for (const [key, metas] of Object.entries(state)) {
        // 取 `at` 最新的一筆（P9）：metas 是 join 順序，同一人多開一個分頁
        // 時「最後一筆」會是那個沒開板的新分頁 — 他就從「在板上」名單消失。
        let meta: Record<string, unknown> = {};
        let newest = -1;
        for (const item of metas) {
          const at = typeof item.at === "number" ? item.at : 0;
          if (at >= newest) {
            newest = at;
            meta = item;
          }
        }
        people.push({
          userId: key,
          boardId: typeof meta.boardId === "string" ? meta.boardId : null,
          focusNodeId: typeof meta.focusNodeId === "string" && meta.focusNodeId.trim()
            ? meta.focusNodeId.trim()
            : null,
          at: newest < 0 ? 0 : newest,
        });
      }
      handlers.onPresenceList?.(people);
    })
    .subscribe((status) => {
      const connected = realtimeSubscribeIsJoined(status);
      handlers.onStatus?.(connected);
      if (connected) void channel.track(trackPayload());
    });

  // 身分／所在板變動時重新 track（**只在開關板時**，不是每次移動 —
  // 「行動裝置友善的在場感：不送游標、不送 16ms 心跳」的既有紀律）。
  // 真值一律現查 getPresenceIdentity()，這裡不留可能過期的副本。
  const retrack = () => {
    void channel.track(trackPayload());
  };

  return Object.assign(
    () => {
      void supabase.removeChannel(channel);
    },
    { retrack },
  );
}
