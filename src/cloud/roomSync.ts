import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { BranchRow, CommentRow, MessageRow, PlanRow, PollRow, PollVoteRow, ProposalRow, RelationRow, RoomRow, StrokeRow, VersionRow } from "./types";
import type { EdgeRow, NodeRow } from "./collaborationRepository";
import { acceptRealtimePayload } from "./realtimeApply";

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
  onBoardEdgeInsert?: (row: EdgeRow) => void;
  onBoardEdgeDelete?: (id: string) => void;
  onPresence?: (count: number) => void;
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
export function subscribeRoom(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
  handlers: SyncHandlers,
): Unsubscribe {
  const filter = `room_id=eq.${roomId}`;
  const channel: RealtimeChannel = supabase.channel(`room:${roomId}`, {
    config: { presence: { key: userId } },
  });

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
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "whiteboard_edges", filter }, (p) =>
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
      handlers.onPresence?.(Object.keys(channel.presenceState()).length);
    })
    .subscribe((status) => {
      const connected = status === "SUBSCRIBED";
      handlers.onStatus?.(connected);
      if (connected) void channel.track({ at: Date.now() });
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}
