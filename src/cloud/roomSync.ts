import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { CommentRow, MessageRow, ProposalRow, RoomRow, StrokeRow, VersionRow } from "./types";

export type SyncHandlers = {
  onRoom?: (row: RoomRow) => void;
  onCommentUpsert?: (row: CommentRow) => void;
  onStrokeInsert?: (row: StrokeRow) => void;
  onStrokeDelete?: (id: string) => void;
  onMessageInsert?: (row: MessageRow) => void;
  onVersionInsert?: (row: VersionRow) => void;
  onProposalUpsert?: (row: ProposalRow) => void;
  onFeedbackChange?: () => void;
  onPresence?: (count: number) => void;
  onStatus?: (connected: boolean) => void;
};

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
