import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { BranchRow, CommentRow, MessageRow, PlanRow, PollRow, PollVoteRow, ProposalRow, RelationRow, RoomRow, StrokeRow, VersionRow } from "./types";
import type { EdgeRow, NodeRow, FrameRow } from "./collaborationRepository";

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
  /** 自己的顯示名稱（track 用）。 */
  displayName?: string;
  onStatus?: (connected: boolean) => void;
};

export type Unsubscribe = () => void;

/**
 * Subscribe to a room's row changes (RLS-scoped) plus presence for the online
 * count. Realtime is transient: the source of truth stays in Postgres, so a
 * missed event is healed by the next loadRoom.
 */
export type PresencePerson = {
  userId: string;
  name: string;
  /** 這個人此刻開著的白板 id（null＝不在白板上）。 */
  boardId: string | null;
  at: number;
};

export type RoomSubscription = Unsubscribe & {
  /** 身分或所在板變了：重新 track（開關板時呼叫，不是每次移動）。 */
  retrack: (next: { name?: string; boardId?: string | null }) => void;
};

export function subscribeRoom(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
  handlers: SyncHandlers,
): RoomSubscription {
  const filter = `room_id=eq.${roomId}`;
  const channel: RealtimeChannel = supabase.channel(`room:${roomId}`, {
    config: { presence: { key: userId } },
  });
  const identity: { name: string; boardId: string | null } = { name: handlers.displayName ?? "", boardId: null };
  const trackPayload = () => ({ at: Date.now(), name: identity.name, boardId: identity.boardId });

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
    .on("postgres_changes", { event: "*", schema: "public", table: "room_discussion_messages", filter }, () => handlers.onProjectChange?.())
    .on("postgres_changes", { event: "*", schema: "public", table: "room_discussion_supports", filter }, () => handlers.onProjectChange?.())
    .on("postgres_changes", { event: "*", schema: "public", table: "decision_records", filter }, () => handlers.onProjectChange?.())
    .on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as Record<string, Array<Record<string, unknown>>>;
      handlers.onPresence?.(Object.keys(state).length);
      const people: PresencePerson[] = [];
      for (const [key, metas] of Object.entries(state)) {
        const meta = metas[metas.length - 1] ?? {};
        people.push({
          userId: key,
          name: typeof meta.name === "string" ? meta.name : "",
          boardId: typeof meta.boardId === "string" ? meta.boardId : null,
          at: typeof meta.at === "number" ? meta.at : 0,
        });
      }
      handlers.onPresenceList?.(people);
    })
    .subscribe((status) => {
      const connected = status === "SUBSCRIBED";
      handlers.onStatus?.(connected);
      if (connected) void channel.track(trackPayload());
    });

  // 身分／所在板變動時重新 track（**只在開關板時**，不是每次移動 —
  // 「行動裝置友善的在場感：不送游標、不送 16ms 心跳」的既有紀律）。
  const retrack = (next: { name?: string; boardId?: string | null }) => {
    if (next.name !== undefined) identity.name = next.name;
    if (next.boardId !== undefined) identity.boardId = next.boardId;
    void channel.track(trackPayload());
  };

  return Object.assign(
    () => {
      void supabase.removeChannel(channel);
    },
    { retrack },
  );
}
