import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BranchStatus,
  BranchSummary,
  BranchType,
  ChatMessage,
  CommentPin,
  CommentReply,
  ContentRelation,
  Guest,
  PlanDocument,
  PollVote,
  Room,
  RoomBranch,
  RoomPoll,
  Point,
  Stroke,
  Version,
} from "../lib/types";
import { roomMediaType } from "../lib/types";
import { normalizeRoomBranches } from "../lib/roomBranches";
import { ensureSession } from "./auth";
import { CloudError } from "./errors";
import {
  dataUrlToBlob,
  proposalAssetPath,
  sha256Blob,
  signedUrl,
  uploadAsset,
  versionPath,
} from "./assets";
import { signedVideoUrl } from "./videoAssets";
import {
  commentFromRow,
  branchFromRow,
  branchSummaryFromRow,
  mediaTypeOf,
  messageFromRow,
  planFromRow,
  pollFromRow,
  pollVoteFromRow,
  prefFromRow,
  relationFromRow,
  replyFromRow,
  strokeFromRow,
  supportFromRow,
  type CommentRow,
  type BranchRow,
  type BranchSummaryRow,
  type MessageRow,
  type PlanRow,
  type PollRow,
  type PollVoteRow,
  type PrefRow,
  type ProposalRow,
  type ReplyRow,
  type RelationRow,
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

/**
 * What this person may do in this room.
 *
 * A room capability, not an account: anonymous auth is untouched, the visitor
 * still only types a name. `owner`/`editor` may change the media versions
 * themselves; `reviewer` reads everything and joins the discussion. The server
 * enforces all of it (migration 0007) — this type exists so the UI can stop
 * offering a button that would only fail.
 */
export type RoomRole = "owner" | "editor" | "reviewer";

export function canManageMedia(role: RoomRole | null): boolean {
  return role === "owner" || role === "editor";
}

export type CloudSnapshot = { room: Room; proposals: CloudProposal[]; role: RoomRole | null };

const uuid = () => crypto.randomUUID();
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

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
  const archivedAt = row.archived_at ?? undefined;
  if (row.media_kind !== "video") {
    return { id: row.id, label: row.label, imageDataUrl: poster, kind: "image", branchId: row.branch_id ?? undefined, archivedAt };
  }
  const videoUrl = row.video_path ? await signedVideoUrl(supabase, row.video_path).catch(() => "") : "";
  return {
    id: row.id,
    label: row.label,
    imageDataUrl: poster,
    branchId: row.branch_id ?? undefined,
    kind: "video",
    archivedAt,
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
  const sourceRoom = normalizeRoomBranches(local.room);

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

  // 0013 is additive. Keep the migration path usable while an older project is
  // being upgraded: the old room/version model still works if the optional
  // branch table is not exposed yet.
  const { error: modeError } = await supabase
    .from("rooms")
    .update({ room_mode: sourceRoom.projectMode ? "project" : "single" })
    .eq("id", roomId);
  const hasBranchSchema = !modeError;
  const branchIdMap = new Map<string, string>();
  const sourceBranches = sourceRoom.branches ?? [];
  if (hasBranchSchema && sourceBranches.length) {
    const branchRows = sourceBranches.map((branch) => {
      // Project branches are created locally before the first share. Keeping
      // their UUIDs lets an upload that creates the cloud room in the same
      // gesture continue writing into the branch it just created. Legacy
      // compatibility ids (branch_default_...) still get a fresh UUID.
      const id = isUuid(branch.id) ? branch.id : uuid();
      branchIdMap.set(branch.id, id);
      return {
        id,
        room_id: roomId,
        name: branch.name,
        branch_type: branch.branchType,
        sort_order: branch.sortOrder,
        status: branch.status,
        created_by: isUuid(branch.createdBy) ? branch.createdBy : null,
      };
    });
    const { error } = await supabase.from("room_branches").insert(branchRows);
    if (error) throw new CloudError(error.message, "branches");
  }

  const versionIdMap = new Map<string, string>();
  const versionRows = [];
  for (let i = 0; i < sourceRoom.versions.length; i++) {
    const v = sourceRoom.versions[i];
    const newId = uuid();
    versionIdMap.set(v.id, newId);
    if (v.kind === "video") {
      // Video versions never travel this path: a cut is uploaded straight into
      // its cloud room's folder, so there is no local-room migration to do, and
      // copying the row would leave video_path under the OLD room id — which
      // membership RLS then refuses to read.
      //
      // Refusing outright rather than skipping: a skipped version leaves its
      // comments and strokes pointing at a row that was never inserted, and
      // losing feedback silently is worse than a migration that says no.
      throw new CloudError("影片房間不需要搬移，請直接分享", "versions");
    }
    const { path, mime } = await uploadVersion(supabase, roomId, newId, v.imageDataUrl);
    versionRows.push({
      id: newId,
      room_id: roomId,
      label: v.label,
      sort_order: i,
      image_path: path,
      mime_type: mime,
      ...(hasBranchSchema && v.branchId && branchIdMap.get(v.branchId)
        ? { branch_id: branchIdMap.get(v.branchId) }
        : {}),
    });
  }
  if (versionRows.length) {
    const { error } = await supabase.from("versions").insert(versionRows);
    if (error) throw new CloudError(error.message, "versions");
  }

  const remap = (vid: string) => versionIdMap.get(vid) ?? vid;

  const commentRows = sourceRoom.comments.map((c) => ({
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

  const strokeRows = sourceRoom.strokes.map((s) => ({
    id: uuid(),
    room_id: roomId,
    version_id: remap(s.versionId),
    color: s.color,
    width: s.width,
    points: s.points,
  }));
  if (strokeRows.length) await supabase.from("strokes").insert(strokeRows);

  const messageRows = sourceRoom.messages.map((m) => ({
    id: uuid(),
    room_id: roomId,
    author_name: m.authorName,
    author_color: m.authorColor,
    body: m.body,
  }));
  if (messageRows.length) await supabase.from("messages").insert(messageRows);

  if (hasBranchSchema) {
    const planRows = (sourceRoom.plans ?? [])
      .map((plan) => ({
        room_id: roomId,
        branch_id: plan.branchId ? branchIdMap.get(plan.branchId) : undefined,
        title: plan.title,
        description: plan.description,
        blocks: plan.blocks,
        updated_by: isUuid(plan.updatedBy ?? "") ? plan.updatedBy : null,
      }))
      .filter((row): row is typeof row & { branch_id: string } => Boolean(row.branch_id));
    if (planRows.length) {
      const { error } = await supabase.from("plan_documents").insert(planRows);
      if (error) throw new CloudError(error.message, "plans");
    }

    const relationRows = (sourceRoom.relations ?? [])
      .map((relation) => ({
        id: uuid(),
        room_id: roomId,
        from_branch_id: branchIdMap.get(relation.fromBranchId),
        to_branch_id: branchIdMap.get(relation.toBranchId),
        relation_type: "related",
        created_by: isUuid(relation.createdBy) ? relation.createdBy : null,
      }))
      .filter((row): row is typeof row & { from_branch_id: string; to_branch_id: string } =>
        Boolean(row.from_branch_id && row.to_branch_id),
      );
    if (relationRows.length) {
      const { error } = await supabase.from("content_relations").insert(relationRows);
      if (error) throw new CloudError(error.message, "relations");
    }

    const pollIdMap = new Map<string, string>();
    const pollRows = (sourceRoom.polls ?? []).map((poll) => {
      const id = uuid();
      pollIdMap.set(poll.id, id);
      return {
        id,
        room_id: roomId,
        question: poll.question,
        options: poll.options,
        created_by: isUuid(poll.createdBy) ? poll.createdBy : null,
      };
    });
    if (pollRows.length) {
      const { error } = await supabase.from("room_polls").insert(pollRows);
      if (error) throw new CloudError(error.message, "polls");
    }
    // Local guest ids are intentionally not auth UUIDs. Poll definitions are
    // migrated; votes are device-local and are not fabricated as another user.
    void pollIdMap;
  }

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

async function loadRoomFull(supabase: SupabaseClient, roomId: string): Promise<CloudSnapshot> {
  const [
    roomRes,
    versionsRes,
    commentsRes,
    strokesRes,
    messagesRes,
    proposalsRes,
    supportsRes,
    repliesRes,
    prefsRes,
    branchesRes,
    plansRes,
    relationsRes,
    pollsRes,
    pollVotesRes,
    roleRes,
  ] =
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
      // These are additive to the entity-level room load. A project that has
      // not run 0013 yet returns an error for these queries; old rooms still
      // load through the compatibility branch created below.
      supabase.from("room_branches").select("*").eq("room_id", roomId).order("sort_order", { ascending: true }),
      supabase.from("plan_documents").select("*").eq("room_id", roomId),
      supabase.from("content_relations").select("*").eq("room_id", roomId),
      supabase.from("room_polls").select("*").eq("room_id", roomId).order("created_at", { ascending: false }),
      supabase.from("room_poll_votes").select("*").eq("room_id", roomId),
      // The caller's own membership row. A member can always read it (0001's
      // room_members_select), and it is the only place the role lives.
      supabase.rpc("room_role", { p_room_id: roomId }),
    ]);
  if (roomRes.error) throw new CloudError(roomRes.error.message, "load");
  const roomRow = roomRes.data as RoomRow;

  // An older deployment without migration 0007 has no room_role(); treating
  // that as "editor" keeps those rooms working exactly as they do today
  // rather than locking everyone out of their own uploads.
  const role: RoomRole | null = roleRes.error
    ? "editor"
    : normaliseRole(roleRes.data as unknown);

  const versions: Version[] = await Promise.all(
    ((versionsRes.data as VersionRow[] | null) ?? []).map((row) => versionFromRow(supabase, row)),
  );

  const branches = ((branchesRes.data as BranchRow[] | null) ?? [])
    .map(branchFromRow)
    .filter((branch): branch is RoomBranch => Boolean(branch));
  const projectMode = roomRow.room_mode === "project" || branches.some((branch) => branch.branchType === "plan" || branch.branchType === "copy") || branches.length > 1;
  const room: Room = normalizeRoomBranches({
    id: roomRow.id,
    title: roomRow.title,
    mediaType: mediaTypeOf(roomRow.media_type),
    projectMode,
    versions,
    comments: ((commentsRes.data as CommentRow[] | null) ?? []).map(commentFromRow),
    strokes: ((strokesRes.data as StrokeRow[] | null) ?? []).map(strokeFromRow),
    messages: ((messagesRes.data as MessageRow[] | null) ?? []).map(messageFromRow),
    supports: ((supportsRes.data as SupportRow[] | null) ?? []).map(supportFromRow),
    replies: ((repliesRes.data as ReplyRow[] | null) ?? []).map(replyFromRow),
    proposalPrefs: ((prefsRes.data as PrefRow[] | null) ?? []).map(prefFromRow),
    ...(branches.length ? { branches } : {}),
    plans: ((plansRes.data as PlanRow[] | null) ?? []).map(planFromRow),
    relations: ((relationsRes.data as RelationRow[] | null) ?? []).map(relationFromRow),
    polls: ((pollsRes.data as PollRow[] | null) ?? []).map(pollFromRow),
    pollVotes: ((pollVotesRes.data as PollVoteRow[] | null) ?? []).map(pollVoteFromRow),
    updatedAt: Date.parse(roomRow.updated_at) || Date.now(),
  });

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

  return { room, proposals, role };
}

export type RoomLoadOptions = {
  /** auto (default) keeps legacy single-media rooms on the old full path. */
  mode?: "auto" | "summary" | "branch";
  branchId?: string;
};

function roleFromResult(value: { error?: unknown; data?: unknown }): RoomRole | null {
  return value.error ? "editor" : normaliseRole(value.data);
}

/**
 * Project-room first paint. It intentionally contains branch/poll summaries,
 * recent feedback and the last few room messages, but no signed media URLs,
 * strokes, proposals or complete comment history. A branch fetch fills those
 * slices only after the person opens that branch.
 */
async function loadRoomSummary(supabase: SupabaseClient, roomId: string, force = false): Promise<CloudSnapshot> {
  const [roomRes, branchesRes, roleRes] = await Promise.all([
    supabase.from("rooms").select("*").eq("id", roomId).single(),
    supabase.from("room_branches").select("*").eq("room_id", roomId).order("sort_order", { ascending: true }),
    supabase.rpc("room_role", { p_room_id: roomId }),
  ]);
  if (roomRes.error) throw new CloudError(roomRes.error.message, "load");
  // Before 0013 the branch table does not exist. Falling back here preserves
  // the exact old image/video loading path during a rolling deployment.
  if (branchesRes.error) return loadRoomFull(supabase, roomId);
  const roomRow = roomRes.data as RoomRow;
  const branches = ((branchesRes.data as BranchRow[] | null) ?? [])
    .map(branchFromRow)
    .filter((branch): branch is RoomBranch => Boolean(branch));
  const isProject = force
    || roomRow.room_mode === "project"
    || branches.length > 1;
  if (!isProject) return loadRoomFull(supabase, roomId);

  const [summaryRes, plansRes, relationsRes, pollsRes, pollVotesRes, messagesRes, commentsRes] = await Promise.all([
    supabase.rpc("get_room_branch_summaries", { p_room_id: roomId }),
    supabase.from("plan_documents").select("branch_id,room_id,title,description,updated_by,updated_at").eq("room_id", roomId),
    supabase.from("content_relations").select("*").eq("room_id", roomId),
    supabase.from("room_polls").select("*").eq("room_id", roomId).order("created_at", { ascending: false }),
    supabase.from("room_poll_votes").select("*").eq("room_id", roomId),
    supabase.from("messages").select("*").eq("room_id", roomId).order("created_at", { ascending: false }).limit(3),
    // The embedded relation is metadata only: it labels recent feedback with
    // its branch without loading version paths or signing any media URL.
    supabase.from("comments").select("*,versions(branch_id)").eq("room_id", roomId).order("created_at", { ascending: false }).limit(4),
  ]);
  const summaries = !summaryRes.error
    ? ((summaryRes.data as BranchSummaryRow[] | null) ?? []).map(branchSummaryFromRow)
    : branches.map((branch) => ({
        branchId: branch.id,
        versionCount: 0,
        openCommentCount: 0,
        feedbackCount: 0,
      } satisfies BranchSummary));
  const room: Room = {
    id: roomRow.id,
    title: roomRow.title,
    mediaType: mediaTypeOf(roomRow.media_type),
    projectMode: true,
    versions: [],
    comments: ((commentsRes.data as CommentRow[] | null) ?? []).map(commentFromRow),
    strokes: [],
    messages: ((messagesRes.data as MessageRow[] | null) ?? []).map(messageFromRow),
    supports: [],
    replies: [],
    proposalPrefs: [],
    branches,
    branchSummaries: summaries,
    plans: ((plansRes.data as PlanRow[] | null) ?? []).map((row) => planFromRow({ ...row, blocks: Array.isArray(row.blocks) ? row.blocks : [] })),
    relations: ((relationsRes.data as RelationRow[] | null) ?? []).map(relationFromRow),
    polls: ((pollsRes.data as PollRow[] | null) ?? []).map(pollFromRow),
    pollVotes: ((pollVotesRes.data as PollVoteRow[] | null) ?? []).map(pollVoteFromRow),
    updatedAt: Date.parse(roomRow.updated_at) || Date.now(),
  };
  return { room: normalizeRoomBranches(room), proposals: [], role: roleFromResult(roleRes) };
}

/** Fetch one branch's signed assets and annotation children on demand. */
async function loadRoomBranch(supabase: SupabaseClient, roomId: string, branchId: string): Promise<CloudSnapshot> {
  const [roomRes, branchRes, versionsRes, roleRes] = await Promise.all([
    supabase.from("rooms").select("*").eq("id", roomId).single(),
    supabase.from("room_branches").select("*").eq("room_id", roomId).eq("id", branchId).limit(1),
    supabase.from("versions").select("*").eq("room_id", roomId).eq("branch_id", branchId).order("sort_order", { ascending: true }),
    supabase.rpc("room_role", { p_room_id: roomId }),
  ]);
  if (roomRes.error) throw new CloudError(roomRes.error.message, "load");
  if (versionsRes.error) throw new CloudError(versionsRes.error.message, "load");
  const roomRow = roomRes.data as RoomRow;
  const branches = ((branchRes.data as BranchRow[] | null) ?? [])
    .map(branchFromRow)
    .filter((branch): branch is RoomBranch => Boolean(branch));
  if (!branches.length) throw new CloudError("找不到這份內容", "load");
  const versionRows = (versionsRes.data as VersionRow[] | null) ?? [];
  const versions = await Promise.all(versionRows.map((row) => versionFromRow(supabase, row)));
  const versionIds = versionRows.map((row) => row.id);
  const empty = <T>() => Promise.resolve({ data: [] as T[], error: null });
  const [commentsRes, strokesRes, prefsRes, proposalsRes, plansRes, relationsRes, pollsRes, pollVotesRes] = await Promise.all([
    versionIds.length ? supabase.from("comments").select("*").eq("room_id", roomId).in("version_id", versionIds).order("created_at", { ascending: true }) : empty<CommentRow>(),
    versionIds.length ? supabase.from("strokes").select("*").eq("room_id", roomId).in("version_id", versionIds).order("created_at", { ascending: true }) : empty<StrokeRow>(),
    versionIds.length ? supabase.from("proposal_preferences").select("*").eq("room_id", roomId).in("version_id", versionIds) : empty<PrefRow>(),
    versionIds.length ? supabase.from("visual_proposals").select("*").eq("room_id", roomId).in("version_id", versionIds).order("created_at", { ascending: true }) : empty<ProposalRow>(),
    supabase.from("plan_documents").select("*").eq("room_id", roomId).eq("branch_id", branchId),
    // These are room-level metadata. Keeping them in a branch response lets a
    // realtime refresh while a branch is open update relations and decisions
    // without downloading any other branch's media.
    supabase.from("content_relations").select("*").eq("room_id", roomId),
    supabase.from("room_polls").select("*").eq("room_id", roomId).order("created_at", { ascending: false }),
    supabase.from("room_poll_votes").select("*").eq("room_id", roomId),
  ]);
  const comments = ((commentsRes.data as CommentRow[] | null) ?? [])
    .map(commentFromRow)
    .map((comment) => ({ ...comment, branchId }));
  const commentIds = comments.map((comment) => comment.id);
  // The first parallel batch above deliberately avoids an all-room child read.
  // Resolve support/reply rows with the now-known comment ids for this branch.
  const [branchSupportsRes, branchRepliesRes] = await Promise.all([
    commentIds.length ? supabase.from("comment_supports").select("*").eq("room_id", roomId).in("comment_id", commentIds) : empty<SupportRow>(),
    commentIds.length ? supabase.from("comment_replies").select("*").eq("room_id", roomId).in("comment_id", commentIds).order("created_at", { ascending: true }) : empty<ReplyRow>(),
  ]);
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
  const room: Room = normalizeRoomBranches({
    id: roomRow.id,
    title: roomRow.title,
    mediaType: mediaTypeOf(roomRow.media_type),
    projectMode: true,
    versions,
    comments,
    strokes: ((strokesRes.data as StrokeRow[] | null) ?? []).map(strokeFromRow),
    messages: [],
    supports: ((branchSupportsRes.data as SupportRow[] | null) ?? []).map(supportFromRow),
    replies: ((branchRepliesRes.data as ReplyRow[] | null) ?? []).map(replyFromRow),
    proposalPrefs: ((prefsRes.data as PrefRow[] | null) ?? []).map(prefFromRow),
    branches,
    plans: ((plansRes.data as PlanRow[] | null) ?? []).map(planFromRow),
    relations: relationsRes.error
      ? undefined
      : ((relationsRes.data as RelationRow[] | null) ?? []).map(relationFromRow),
    polls: pollsRes.error
      ? undefined
      : ((pollsRes.data as PollRow[] | null) ?? []).map(pollFromRow),
    pollVotes: pollVotesRes.error
      ? undefined
      : ((pollVotesRes.data as PollVoteRow[] | null) ?? []).map(pollVoteFromRow),
    updatedAt: Date.parse(roomRow.updated_at) || Date.now(),
  });
  return { room, proposals, role: roleFromResult(roleRes) };
}

/** Public loader with a safe default: project shells are summary-first. */
export async function loadRoom(supabase: SupabaseClient, roomId: string, options: RoomLoadOptions = {}): Promise<CloudSnapshot> {
  if (options.mode === "branch") {
    if (!options.branchId) throw new CloudError("缺少內容定位", "load");
    return loadRoomBranch(supabase, roomId, options.branchId);
  }
  return loadRoomSummary(supabase, roomId, options.mode === "summary");
}

function normaliseRole(value: unknown): RoomRole | null {
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value[0] : null;
  return raw === "owner" || raw === "editor" || raw === "reviewer" ? raw : null;
}

/**
 * Archive a version instead of deleting it.
 *
 * Every child table points at versions with `on delete cascade`, so deleting a
 * version that people have discussed takes the whole discussion with it. The
 * database refuses that delete (migration 0008); this is the action that is
 * always safe — the version leaves the picker, the discussion stays readable.
 */
export async function archiveVersion(supabase: SupabaseClient, versionId: string): Promise<void> {
  const { error } = await supabase.rpc("archive_version", { p_version_id: versionId });
  if (error) throw new CloudError(error.message, "write");
}

export async function restoreVersion(supabase: SupabaseClient, versionId: string): Promise<void> {
  const { error } = await supabase.rpc("restore_version", { p_version_id: versionId });
  if (error) throw new CloudError(error.message, "write");
}

/** Owner-only: change what a link visitor becomes when they join. */
export async function setRoomDefaultRole(
  supabase: SupabaseClient,
  roomId: string,
  role: "editor" | "reviewer",
): Promise<void> {
  const { error } = await supabase.rpc("set_room_default_role", { p_room_id: roomId, p_role: role });
  if (error) throw new CloudError(error.message, "write");
}

/** Owner-only: promote a reviewer to editor, or put an editor back to reviewer. */
export async function setMemberRole(
  supabase: SupabaseClient,
  roomId: string,
  userId: string,
  role: "editor" | "reviewer",
): Promise<void> {
  const { error } = await supabase.rpc("set_member_role", {
    p_room_id: roomId,
    p_user_id: userId,
    p_role: role,
  });
  if (error) throw new CloudError(error.message, "write");
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
  branchId?: string,
): Promise<Version> {
  const id = uuid();
  const { blob, mime } = await dataUrlToBlob(imageDataUrl);
  const path = versionPath(roomId, id, mime);
  await uploadAsset(supabase, path, blob, mime);
  const contentHash = await sha256Blob(blob).catch(() => undefined);
  const versionRow = {
    id,
    room_id: roomId,
    label,
    sort_order: sortOrder,
    image_path: path,
    mime_type: mime,
    ...(contentHash ? { content_hash: contentHash } : {}),
    ...(branchId ? { branch_id: branchId } : {}),
  };
  let { error } = await supabase
    .from("versions")
    .insert(versionRow);
  // A mixed-version deployment may not have 0014 yet. The upload is already
  // in the existing private bucket, so retry the legacy row shape rather than
  // breaking the established review flow while the migration rolls out.
  if (error && /content_hash|column/i.test(error.message)) {
    const { content_hash: _ignored, ...legacyRow } = versionRow;
    ({ error } = await supabase.from("versions").insert(legacyRow));
  }
  if (error) throw new CloudError(error.message, "version");
  return { id, label, imageDataUrl: await signedUrl(supabase, path), ...(branchId ? { branchId } : {}) };
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
    branchId?: string;
    videoPath: string;
    posterPath: string | null;
    mimeType: string;
    duration: number | null;
    fileSize: number | null;
    width: number | null;
    height: number | null;
    contentHash?: string;
  },
): Promise<void> {
  const versionRow = {
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
    ...(input.contentHash ? { content_hash: input.contentHash } : {}),
    ...(input.branchId ? { branch_id: input.branchId } : {}),
  };
  let { error } = await supabase.from("versions").insert(versionRow);
  if (error && /content_hash|column/i.test(error.message)) {
    const { content_hash: _ignored, ...legacyRow } = versionRow;
    ({ error } = await supabase.from("versions").insert(legacyRow));
  }
  if (error) throw new CloudError(error.message, "version");
}

// ---- project-room branches / plans / relations / decisions ---------------

export async function insertBranch(supabase: SupabaseClient, branch: RoomBranch): Promise<void> {
  const { error } = await supabase.from("room_branches").insert({
    id: branch.id,
    room_id: branch.roomId,
    name: branch.name,
    branch_type: branch.branchType,
    sort_order: branch.sortOrder,
    status: branch.status,
    created_by: isUuid(branch.createdBy) ? branch.createdBy : null,
  });
  if (error) throw new CloudError(error.message, "branch");
}

export async function updateBranch(
  supabase: SupabaseClient,
  roomId: string,
  branchId: string,
  patch: Partial<Pick<RoomBranch, "name" | "sortOrder" | "status">>,
): Promise<void> {
  const row = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.sortOrder !== undefined ? { sort_order: patch.sortOrder } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("room_branches").update(row).eq("id", branchId).eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "branch");
}

export async function upsertPlan(supabase: SupabaseClient, plan: PlanDocument, roomId: string): Promise<void> {
  const { error } = await supabase.from("plan_documents").upsert(
    {
      room_id: roomId,
      branch_id: plan.branchId,
      title: plan.title,
      description: plan.description,
      blocks: plan.blocks,
      updated_by: isUuid(plan.updatedBy ?? "") ? plan.updatedBy : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "branch_id" },
  );
  if (error) throw new CloudError(error.message, "plan");
}

export async function insertRelation(supabase: SupabaseClient, relation: ContentRelation): Promise<void> {
  const { error } = await supabase.from("content_relations").insert({
    id: relation.id,
    room_id: relation.roomId,
    from_branch_id: relation.fromBranchId,
    to_branch_id: relation.toBranchId,
    relation_type: "related",
    created_by: isUuid(relation.createdBy) ? relation.createdBy : null,
  });
  if (error) throw new CloudError(error.message, "relation");
}

export async function deleteRelation(supabase: SupabaseClient, roomId: string, relationId: string): Promise<void> {
  const { error } = await supabase.from("content_relations").delete().eq("id", relationId).eq("room_id", roomId);
  if (error) throw new CloudError(error.message, "relation");
}

export async function insertPoll(supabase: SupabaseClient, poll: RoomPoll): Promise<void> {
  const { error } = await supabase.from("room_polls").insert({
    id: poll.id,
    room_id: poll.roomId,
    question: poll.question,
    options: poll.options,
    created_by: isUuid(poll.createdBy) ? poll.createdBy : null,
  });
  if (error) throw new CloudError(error.message, "poll");
}

export async function votePoll(supabase: SupabaseClient, vote: PollVote): Promise<void> {
  const { error } = await supabase.from("room_poll_votes").upsert(
    { poll_id: vote.pollId, room_id: vote.roomId, option: vote.option },
    { onConflict: "poll_id,user_id" },
  );
  if (error) throw new CloudError(error.message, "poll-vote");
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
