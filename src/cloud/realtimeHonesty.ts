import { syncStatusLabel, type SyncStatus } from "./types";

/**
 * Channel join honesty (not a second discussion transport).
 *
 * One `room:${id}` channel carries presence and postgres_changes together.
 * `subscribe()` SUBSCRIBED means that channel joined — it does not mean a
 * discussion row has arrived. Presence count is also not a discussion event.
 *
 * A landed snapshot may open the room. 「已同步」/「N 人在線」may not paint
 * until that channel is actually joined. CHANNEL_ERROR / TIMED_OUT / closed
 * are not joined.
 */

export function realtimeSubscribeIsJoined(status: string): boolean {
  return status === "SUBSCRIBED";
}

export function roomLiveSyncClaim(input: {
  snapshotStatus: SyncStatus;
  realtimeJoined: boolean;
}): string {
  if (input.snapshotStatus === "local-only") return "";
  if (input.snapshotStatus === "error" || input.snapshotStatus === "offline-pending") {
    return syncStatusLabel(input.snapshotStatus);
  }
  if (!input.realtimeJoined) return syncStatusLabel("connecting");
  if (input.snapshotStatus === "synced") return syncStatusLabel("synced");
  return syncStatusLabel(input.snapshotStatus);
}

/** Project chrome. Count 0 or a channel that never joined is not「在線」. */
export function roomPresenceLabel(online: number, realtimeJoined: boolean): string {
  if (!realtimeJoined || online <= 0) return "";
  return `${online} 人在線`;
}
