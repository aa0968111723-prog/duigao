import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatMessage, CommentPin, CommentReply, Guest, Point, Room, Stroke, Version } from "../lib/types";
import { roomMediaType } from "../lib/types";
import { ensureSession } from "./auth";
import { CloudError } from "./errors";
import {
  dataUrlToBlob,
  proposalAssetPath,
  signedUrl,
  uploadAsset,
  versionPath,
} from "./assets";
import { signedVideoUrl } from "./videoAssets";
import {
  commentFromRow,
  mediaTypeOf,
  messageFromRow,
  prefFromRow,
  replyFromRow,
  strokeFromRow,
  supportFromRow,
  type CommentRow,
  type MessageRow,
  type PrefRow,
  type ProposalRow,
  type ReplyRow,
  type RoomRow,
  type StrokeRow,
  type SupportRow,
  type VersionRow,
} from "./types";

export type CloudProposal = {
  id: string;
  versionId: string;
  authorName: string;
  name: string;
  payload: Record<string, unknown>;
  revision: number;
};

export type CloudSnapshot = { room: Room; proposals: CloudProposal[] };

const uuid = () => crypto.randomUUID();

/**
 * The anchor half of a comment row.
 *
 * Image feedback keeps writing exactly what it always wrote (its anchor type is
 * derived from whether it circled an area), so nothing about the existing
 * comment path changes shape.
 */
function anchorColumns(pin: CommentPin): Record<string, unknown> {
  if (pin.anchor?.kind === "range") {
    return {
      anchor_type: "video-range",
      time_seconds: pin.anchor.startTime,
      end_time_seconds: pin.anchor.endTime,
    };
  }
  if (pin.anchor?.kind === "point") {
    return { anchor_type: "video-point", time_seconds: pin.anchor.time, end_time_seconds: null };
  }
  return {
    anchor_type: pin.region ? "image-region" : "image-point",
    time_seconds: null,
    end_time_seconds: null,
  };
}

/**
 * A stored version becomes a playable/viewable one.
 *
 * Signing is best-effort per asset: a video whose poster is missing still
 * plays, and a poster whose signing failed still leaves a usable version. The
 * alternative — one failed signature taking down the whole room load — is the
 * behaviour this shape exists to avoid.
 */
async function versionFromRow(supabase: SupabaseClient, row: VersionRow): Promise<Version> {
  const poster = row.image_path ? await signedUrl(supabase, row.image_path).catch(() => "") : "";
  if (row.media_kind !== "video") {
    return { id: row.id, label: row.label, imageDataUrl: poster, kind: "image" };
  }
  const videoUrl = row.video_path ? await signedVideoUrl(supabase, row.video_path).catch(() => "") : "";
  return {
    id: row.id,
    label: row.label,
    imageDataUrl: poster,
    kind: "video",
    videoUrl,
    videoPath: row.video_path ?? undefined,
    duration: row.duration_seconds ?? undefined,
    mimeType: row.mime_type ?? undefined,
    fileSize: row.file_size ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
  };
}

// ---- assets embedded in a proposal payload ---------------------------------
// data: URLs are uploaded to Storage and replaced with `asset:<path>` markers so
// binary never lands in Postgres JSONB; on load the markers become signed URLs.

async function externalizePayload(
  supabase: SupabaseClient,
  roomId: string,
  proposalId: string,
  value: unknown,
): Promise<unknown> {
  if (typeof value === "string") {
    if (value.startsWith("data:")) {
      const { blob, mime } = await dataUrlToBlob(value);
      const path = proposalAssetPath(roomId, proposalId, uuid(), mime);
      await uploadAsset(supabase, path, blob, mime);
      return `asset:${path}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => externalizePayload(supabase, roomId, proposalId, v)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await externalizePayload(supabase, roomId, proposalId, v);
    return out;
  }
  return value;
}

async function resolvePayload(supabase: SupabaseClient, value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    if (value.startsWith("asset:")) {
      try {
        return await signedUrl(supabase, value.slice("asset:".length));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => resolvePayload(supabase, v)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolvePayload(supabase, v);
    return out;
  }
  return value;
}

async function uploadVersion(supabase: SupabaseClient, roomId: string, versionId: string, imageDataUrl: string) {
  const { blob, mime } = await dataUrlToBlob(imageDataUrl);
  const path = versionPath(roomId, versionId, mime);
  await uploadAsset(supabase, path, blob, mime);
  return { path, mime };
}

/**
 * Create (or migrate a local room into) a cloud room. Ids are remapped to UUIDs
 * and version references are rewritten. Returns the new room id + raw invite
 * token; callers should then loadRoom() to adopt the canonical cloud state.
 */
export async function createRoom(
  supabase: SupabaseClient,
  local: { room: Room; proposals: CloudProposal[] },
  guest: Guest,
  token: string,
): Promise<{ roomId: string; token: string }> {
  await ensureSession(supabase);
  const roomId = uuid();

  const { error: rpcErr } = await supabase.rpc("create_room_with_invite", {
    p_room_id: roomId,
    p_title: local.room.title,
    p_invite_token: token,
    p_display_name: guest.name,
    p_color: guest.color,
  });
  if (rpcErr) throw new CloudError(rpcErr.message, "create");

  // The RPC predates media types and only ever creates image rooms, so a video
  // room states what it is right after. Failing here would leave a room that
  // renders with the wrong workspace, so it is checked rather than ignored.
  const mediaType = roomMediaType(local.room);
  if (mediaType === "video") {
    const { error } = await supabase.from("rooms").update({ media_type: "video" }).eq("id", roomId);
    if (error) throw new CloudError(error.message, "create");
  }

  const versionIdMap = new Map<string, string>();
  const versionRows = [];
  for (let i = 0; i < local.room.versions.length; i++) {
    const v = local.room.versions[i];
    const newId = uuid();
    versionIdMap.set(v.id, newId);
    if (v.kind === "video") {
      // Video versions never travel this path: a cut is uploaded straight into
      // its cloud room's folder, so there is no local-room migration to do.
      // Copying the row would keep a video_path under the OLD room id, which
      // membership RLS then refuses to read — better to skip it loudly than to
      // migrate a version nobody can play.
      versionIdMap.set(v.id, v.id);
      continue;
    }
    const { path, mime } = await uploadVersion(supabase, roomId, newId, v.imageDataUrl);
    versionRows.push({ id: newId, room_id: roomId, label: v.label, sort_order: i, image_path: path, mime_type: mime });
  }
  if (versionRows.length) {
    const { error } = await supabase.from("versions").insert(versionRows);
    if (error) throw new CloudError(error.message, "versions");
  }

  const remap = (vid: string) => versionIdMap.get(vid) ?? vid;

  const commentRows = local.room.comments.map((c) => ({
    id: uuid(),
    room_id: roomId,
    version_id: remap(c.versionId),
    author_name: c.authorName,
    author_color: c.authorColor,
    x: c.x,
    y: c.y,
    region: c.region ?? null,
    ...anchorColumns(c),
    body: c.body,
    suggestion: c.suggestion ?? "",
    problem_type: c.problemType ?? null,
    priority: c.priority ?? null,
    resolved: c.resolved,
  }));
  if (commentRows.length) await supabase.from("comments").insert(commentRows);

  const strokeRows = local.room.strokes.map((s) => ({
    id: uuid(),
    room_id: roomId,
    version_id: remap(s.versionId),
    color: s.color,
    width: s.width,
    points: s.points,
  }));
  if (strokeRows.length) await supabase.from("strokes").insert(strokeRows);

  const messageRows = local.room.messages.map((m) => ({
    id: uuid(),
    room_id: roomId,
    author_name: m.authorName,
    author_color: m.authorColor,
    body: m.body,
  }));
  if (messageRows.length) await supabase.from("messages").insert(messageRows);

  for (const p of local.proposals) {
    const newId = uuid();
    const payload = (await externalizePayload(supabase, roomId, newId, p.payload)) as Record<string, unknown>;
    const { error } = await supabase.rpc("upsert_visual_proposal", {
      p_id: newId,
      p_room_id: roomId,
      p_version_id: remap(p.versionId),
      p_author_name: p.authorName,
      p_name: p.name,
      p_payload: payload,
      p_expected_revision: null,
    });
    if (error) throw new CloudError(error.message, "proposal");
  }

  return { roomId, token };
}

export async function joinRoom(supabase: SupabaseClient, roomId: string, token: string, guest: Guest): Promise<void> {
  await ensureSession(supabase);
  const { error } = await supabase.rpc("join_room_by_invite", {
    p_room_id: roomId,
    p_invite_token: token,
    p_display_name: guest.name,
    p_color: guest.color,
  });
  if (error) throw new CloudError(error.message, "join");
}

export async function loadRoom(supabase: SupabaseClient, roomId: string): Promise<CloudSnapshot> {
  const [roomRes, versionsRes, commentsRes, strokesRes, messagesRes, proposalsRes, supportsRes, repliesRes, prefsRes] =
    await Promise.all([
      supabase.from("rooms").select("*").eq("id", roomId).single(),
      supabase.from("versions").select("*").eq("room_id", roomId).order("sort_order", { ascending: true }),
      supabase.from("comments").select("*").eq("room_id", roomId).order("created_at", { ascending: true }),
      supabase.from("strokes").select("*").eq("room_id", roomId).order("created_at", { ascending: true }),
      supabase.from("messages").select("*").eq("room_id", roomId).order("created_at", { ascending: true }),
      supabase.from("visual_proposals").select("*").eq("room_id", roomId).order("created_at", { ascending: true }),
      supabase.from("comment_supports").select("*").eq("room_id", roomId),
      supabase.from("comment_replies").select("*").eq("room_id", roomId).order("created_at", { ascending: true }),
      supabase.from("proposal_preferences").select("*").eq("room_id", roomId),
    ]);
  if (roomRes.error) throw new CloudError(roomRes.error.message, "load");
  const roomRow = roomRes.data as RoomRow;

  const versions: Version[] = await Promise.all(
    ((versionsRes.data as VersionRow[] | null) ?? []).map((row) => versionFromRow(supabase, row)),
  );

  const room: Room = {
    id: roomRow.id,
    title: roomRow.title,
    mediaType: mediaTypeOf(roomRow.media_type),
    versions,
    comments: ((commentsRes.data as CommentRow[] | null) ?? []).map(commentFromRow),
    strokes: ((strokesRes.data as StrokeRow[] | null) ?? []).map(strokeFromRow),
    messages: ((messagesRes.data as MessageRow[] | null) ?? []).map(messageFromRow),
    supports: ((supportsRes.data as SupportRow[] | null) ?? []).map(supportFromRow),
    replies: ((repliesRes.data as ReplyRow[] | null) ?? []).map(replyFromRow),
    proposalPrefs: ((prefsRes.data as PrefRow[] | null) ?? []).map(prefFromRow),
    updatedAt: Date.parse(roomRow.updated_at) || Date.now(),
  };

  const proposals: CloudProposal[] = await Promise.all(
    ((proposalsRes.data as ProposalRow[] | null) ?? []).map(async (row) => ({
      id: row.id,
      versionId: row.version_id,
      authorName: row.author_name,
      name: row.name,
      payload: (await resolvePayload(supabase, row.payload)) as Record<string, unknown>,
      revision: row.revision,
    })),
  );

  return { room, proposals };
}

// ---- entity-level writes (never overwrite the whole room) ------------------

export async function setRoomTitle(supabase: SupabaseClient, roomId: string, title: string) {
  await supabase.from("rooms").update({ title, updated_at: new Date().toISOString() }).eq("id", roomId);
}

export async function insertComment(supabase: SupabaseClient, roomId: string, pin: CommentPin) {
  const { error } = await supabase.from("comments").insert({
    id: pin.id.length === 36 ? pin.id : uuid(),
    room_id: roomId,
    version_id: pin.versionId,
    author_name: pin.authorName,
    author_color: pin.authorColor,
    x: pin.x,
    y: pin.y,
    region: pin.region ?? null,
    ...anchorColumns(pin),
    body: pin.body,
    suggestion: pin.suggestion ?? "",
    problem_type: pin.problemType ?? null,
    priority: pin.priority ?? null,
    resolved: pin.resolved,
  });
  if (error) throw new CloudError(error.message, "comment");
}

export async function setCommentResolved(supabase: SupabaseClient, id: string, resolved: boolean) {
  const { error } = await supabase.from("comments").update({ resolved, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new CloudError(error.message, "comment");
}

export async function insertStroke(supabase: SupabaseClient, roomId: string, stroke: Stroke) {
  const { error } = await supabase.from("strokes").insert({
    id: stroke.id.length === 36 ? stroke.id : uuid(),
    room_id: roomId,
    version_id: stroke.versionId,
    color: stroke.color,
    width: stroke.width,
    points: stroke.points as Point[],
  });
  if (error) throw new CloudError(error.message, "stroke");
}

export async function deleteStroke(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("strokes").delete().eq("id", id);
  if (error) throw new CloudError(error.message, "stroke");
}

export async function insertMessage(supabase: SupabaseClient, roomId: string, msg: ChatMessage) {
  const { error } = await supabase.from("messages").insert({
    id: msg.id.length === 36 ? msg.id : uuid(),
    room_id: roomId,
    author_name: msg.authorName,
    author_color: msg.authorColor,
    body: msg.body,
  });
  if (error) throw new CloudError(error.message, "message");
}

/** Upload one new poster version image and insert its row. */
export async function addVersion(
  supabase: SupabaseClient,
  roomId: string,
  label: string,
  sortOrder: number,
  imageDataUrl: string,
): Promise<Version> {
  const id = uuid();
  const { path, mime } = await uploadVersion(supabase, roomId, id, imageDataUrl);
  const { error } = await supabase
    .from("versions")
    .insert({ id, room_id: roomId, label, sort_order: sortOrder, image_path: path, mime_type: mime });
  if (error) throw new CloudError(error.message, "version");
  return { id, label, imageDataUrl: await signedUrl(supabase, path) };
}

/**
 * Insert the row for a video version whose bytes are already in Storage.
 *
 * Called after the upload finishes, so the row and the object can never
 * disagree about whether the video exists. The poster is optional on purpose:
 * a frame capture that failed costs a cover, not the version.
 */
export async function addVideoVersion(
  supabase: SupabaseClient,
  roomId: string,
  input: {
    id: string;
    label: string;
    sortOrder: number;
    videoPath: string;
    posterPath: string | null;
    mimeType: string;
    duration: number | null;
    fileSize: number | null;
    width: number | null;
    height: number | null;
  },
): Promise<void> {
  const { error } = await supabase.from("versions").insert({
    id: input.id,
    room_id: roomId,
    label: input.label,
    sort_order: input.sortOrder,
    media_kind: "video",
    image_path: input.posterPath,
    video_path: input.videoPath,
    mime_type: input.mimeType,
    duration_seconds: input.duration && input.duration > 0 ? input.duration : null,
    file_size: input.fileSize,
    width: input.width,
    height: input.height,
  });
  if (error) throw new CloudError(error.message, "version");
}

/** Mark a room as a video room. Used when a video room is created in the cloud. */
export async function setRoomMediaType(supabase: SupabaseClient, roomId: string, mediaType: "image" | "video") {
  const { error } = await supabase.from("rooms").update({ media_type: mediaType }).eq("id", roomId);
  if (error) throw new CloudError(error.message, "room");
}

export async function upsertProposal(
  supabase: SupabaseClient,
  roomId: string,
  proposal: CloudProposal,
): Promise<number> {
  const payload = (await externalizePayload(supabase, roomId, proposal.id, proposal.payload)) as Record<string, unknown>;
  const { data, error } = await supabase.rpc("upsert_visual_proposal", {
    p_id: proposal.id,
    p_room_id: roomId,
    p_version_id: proposal.versionId,
    p_author_name: proposal.authorName,
    p_name: proposal.name,
    p_payload: payload,
    p_expected_revision: proposal.revision,
  });
  if (error) throw new CloudError(error.message, "proposal");
  return typeof data === "number" ? data : proposal.revision + 1;
}

// ---- low-friction feedback (supports / replies / proposal preferences) -----

export async function setSupport(supabase: SupabaseClient, roomId: string, commentId: string, add: boolean) {
  if (add) {
    const { error } = await supabase
      .from("comment_supports")
      .upsert({ room_id: roomId, comment_id: commentId }, { onConflict: "comment_id,user_id" });
    if (error) throw new CloudError(error.message, "support");
  } else {
    // RLS delete policy limits this to the caller's own support row.
    const { error } = await supabase.from("comment_supports").delete().eq("comment_id", commentId);
    if (error) throw new CloudError(error.message, "support");
  }
}

export async function insertReply(supabase: SupabaseClient, roomId: string, reply: CommentReply) {
  const { error } = await supabase.from("comment_replies").insert({
    id: reply.id.length === 36 ? reply.id : uuid(),
    room_id: roomId,
    comment_id: reply.commentId,
    author_name: reply.authorName,
    author_color: reply.authorColor,
    body: reply.body,
  });
  if (error) throw new CloudError(error.message, "reply");
}

export async function setPreference(supabase: SupabaseClient, roomId: string, versionId: string, choice: string) {
  if (!choice) {
    // RLS delete policy limits this to the caller's own preference row.
    const { error } = await supabase.from("proposal_preferences").delete().eq("version_id", versionId);
    if (error) throw new CloudError(error.message, "preference");
    return;
  }
  const { error } = await supabase
    .from("proposal_preferences")
    .upsert({ room_id: roomId, version_id: versionId, choice }, { onConflict: "version_id,user_id" });
  if (error) throw new CloudError(error.message, "preference");
}
