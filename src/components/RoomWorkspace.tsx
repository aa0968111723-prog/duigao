import { roomMediaType } from "../lib/types";
import type { CollabStatus } from "../lib/peer";
import { ImageWorkspace } from "../features/image-review/ImageWorkspace";
import { VideoWorkspace } from "../features/video-review/VideoWorkspace";
import type { WorkspaceApi } from "./api";

/**
 * The one place where image review and video review differ.
 *
 * Reviewing a poster and reviewing a cut are different jobs — one points at a
 * place, the other at a moment — so they get different screens rather than one
 * screen full of branches. Everything underneath (rooms, invites, membership,
 * Storage, Realtime, the discussion itself) is the same code for both, which is
 * why this file is four lines long instead of being a second application.
 *
 * A room with no `mediaType` is a room from before video existed: an image room.
 */
export function RoomWorkspace({
  api,
  presence,
}: {
  api: WorkspaceApi;
  presence: { status: CollabStatus | null; peers: number };
}) {
  return roomMediaType(api.room) === "video" ? (
    <VideoWorkspace api={api} presence={presence} />
  ) : (
    <ImageWorkspace api={api} presence={presence} />
  );
}
