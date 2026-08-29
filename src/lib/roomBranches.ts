import type {
  BranchStatus,
  BranchSummary,
  BranchType,
  Room,
  RoomBranch,
  Version,
} from "./types";
import { BRANCH_STATUS_LABEL, BRANCH_TYPE_LABEL } from "./types";

export const BRANCH_TYPES: BranchType[] = ["poster", "video", "plan", "copy"];
export const BRANCH_STATUSES: BranchStatus[] = ["in_progress", "pending", "completed", "archived"];

export function branchTypeForVersion(version: Pick<Version, "kind">): BranchType {
  return version.kind === "video" ? "video" : "poster";
}

export function branchTypeLabel(type: BranchType): string {
  return BRANCH_TYPE_LABEL[type];
}

export function branchStatusLabel(status: BranchStatus): string {
  return BRANCH_STATUS_LABEL[status];
}

/** Stable local id prevents repeated compatibility normalization creating duplicates. */
export function defaultBranchId(roomId: string): string {
  return `branch_default_${roomId}`;
}

export function makeDefaultBranch(room: Pick<Room, "id" | "title" | "mediaType" | "versions">): RoomBranch {
  const now = Date.now();
  const branchType: BranchType = room.mediaType === "video"
    ? "video"
    : room.versions.some((version) => version.kind === "video")
      ? "video"
      : "poster";
  return {
    id: defaultBranchId(room.id),
    roomId: room.id,
    name: room.title || (branchType === "video" ? "影片" : "文宣"),
    branchType,
    sortOrder: 0,
    status: "in_progress",
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Adds the branch projection without changing the meaning of old rooms.
 * Cloud rows are allowed to arrive before the migration has been deployed, so
 * the client also owns this harmless read-time fallback.
 */
export function normalizeRoomBranches(room: Room): Room {
  if (room.branches?.length) {
    const branches = [...room.branches].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
    const known = new Set(branches.map((branch) => branch.id));
    const fallback = branches[0];
    const versions = room.versions.map((version) => {
      if (version.branchId && known.has(version.branchId)) return version;
      const compatible = branches.find((branch) => branchTypeForVersion(version) === branch.branchType);
      return { ...version, branchId: (compatible ?? fallback).id };
    });
    return { ...room, branches, versions };
  }
  if (room.projectMode) return { ...room, branches: [] };
  const branch = makeDefaultBranch(room);
  return {
    ...room,
    branches: [branch],
    versions: room.versions.map((version) => ({ ...version, branchId: version.branchId ?? branch.id })),
  };
}

export function branchForId(room: Room, branchId: string): RoomBranch | undefined {
  return normalizeRoomBranches(room).branches?.find((branch) => branch.id === branchId);
}

export function branchVersions(room: Room, branchId: string): Version[] {
  const normalized = normalizeRoomBranches(room);
  return normalized.versions.filter((version) => version.branchId === branchId);
}

export function branchSummaryFor(room: Room, branchId: string): BranchSummary | undefined {
  return room.branchSummaries?.find((summary) => summary.branchId === branchId);
}

/** Derive overview counts for local rooms, while preserving cloud summary rows. */
export function branchSummary(room: Room, branchId: string): BranchSummary {
  const existing = branchSummaryFor(room, branchId);
  const versions = branchVersions(room, branchId).filter((version) => !version.archivedAt);
  const versionIds = new Set(versions.map((version) => version.id));
  const comments = room.comments.filter((comment) => versionIds.has(comment.versionId));
  const latest = versions[versions.length - 1];
  if (!versions.length && existing) return existing;
  return {
    branchId,
    versionCount: versions.length,
    ...(latest ? { latestVersionId: latest.id, latestLabel: latest.label } : {}),
    latestUpdatedAt: latest ? room.updatedAt : undefined,
    openCommentCount: comments.filter((comment) => !comment.resolved).length,
    feedbackCount: comments.length,
  };
}

/** Replace one branch's detail slice without disturbing room-level summary data. */
export function mergeRoomBranch(room: Room, detail: Room, branchId: string): Room {
  const detailVersionIds = new Set(detail.versions.map((version) => version.id));
  const keepVersion = (version: Version) => version.branchId !== branchId && !detailVersionIds.has(version.id);
  const keepVersionChild = <T extends { versionId: string }>(row: T) => !detailVersionIds.has(row.versionId);
  const branches = (room.branches ?? []).map((branch) =>
    branch.id === branchId ? detail.branches?.find((item) => item.id === branchId) ?? branch : branch,
  );
  return normalizeRoomBranches({
    ...room,
    ...detail,
    projectMode: true,
    branches,
    branchSummaries: room.branchSummaries ?? detail.branchSummaries,
    versions: [...room.versions.filter(keepVersion), ...detail.versions],
    comments: [...room.comments.filter(keepVersionChild), ...detail.comments],
    strokes: [...room.strokes.filter(keepVersionChild), ...detail.strokes],
    messages: room.messages,
    supports: [
      ...(room.supports ?? []).filter((support) => room.comments.some((comment) => comment.id === support.commentId && keepVersionChild(comment))),
      ...(detail.supports ?? []),
    ],
    replies: [
      ...(room.replies ?? []).filter((reply) => room.comments.some((comment) => comment.id === reply.commentId && keepVersionChild(comment))),
      ...(detail.replies ?? []),
    ],
    proposalPrefs: [
      ...(room.proposalPrefs ?? []).filter(keepVersionChild),
      ...(detail.proposalPrefs ?? []),
    ],
    relations: detail.relations ?? room.relations,
    polls: detail.polls ?? room.polls,
    pollVotes: detail.pollVotes ?? room.pollVotes,
    // 討論殼在 branch 對稿期間仍然掛著；collab slice 明寫 fallback 規則
    // （branch 快照缺鍵時沿用房間現值），不再默默依賴 ...detail 的展開。
    discussion: detail.discussion ?? room.discussion,
    discussionSupports: detail.discussionSupports ?? room.discussionSupports,
    whiteboards: detail.whiteboards ?? room.whiteboards,
    decisions: detail.decisions ?? room.decisions,
    todos: detail.todos ?? room.todos,
    members: detail.members ?? room.members,
    allowBoardEdit: detail.allowBoardEdit ?? room.allowBoardEdit,
    plans: [
      ...(room.plans ?? []).filter((plan) => plan.branchId !== branchId),
      // Branch reload 與使用者連續編輯會賽跑：快照發出時的 plan 可能比
      // 本地這一刻的還舊，整包蓋回去會把剛打的段落吃掉。以 updatedAt
      // 保新 — 本地較新就留本地，遠端較新（別人存的）才接受。
      ...(detail.plans ?? []).map((incoming) => {
        const local = room.plans?.find((plan) => plan.branchId === incoming.branchId);
        return local && local.updatedAt > incoming.updatedAt ? local : incoming;
      }),
    ],
    updatedAt: Math.max(room.updatedAt, detail.updatedAt),
  });
}

/** Build a review-only projection; the source Room remains the shared truth. */
export function roomForBranch(room: Room, branchId: string): Room {
  const normalized = normalizeRoomBranches(room);
  const branch = normalized.branches?.find((item) => item.id === branchId);
  if (!branch) return normalized;
  const versions = normalized.versions.filter((version) => version.branchId === branchId);
  const versionIds = new Set(versions.map((version) => version.id));
  return {
    ...normalized,
    title: branch.name,
    mediaType: branch.branchType === "video" ? "video" : "image",
    versions,
    comments: normalized.comments.filter((comment) => versionIds.has(comment.versionId)),
    strokes: normalized.strokes.filter((stroke) => versionIds.has(stroke.versionId)),
    proposalPrefs: normalized.proposalPrefs?.filter((pref) => versionIds.has(pref.versionId)),
    branchSummaries: normalized.branchSummaries?.filter((summary) => summary.branchId === branchId),
  };
}

export function latestBranchVersion(room: Room, branchId: string): Version | undefined {
  const versions = branchVersions(room, branchId).filter((version) => !version.archivedAt);
  // Local versions have no sort_order field; their array order is the same
  // append order used by the existing workspace and cloud loader.
  return versions[versions.length - 1];
}

export function branchOpenCommentCount(room: Room, branchId: string): number {
  const ids = new Set(branchVersions(room, branchId).map((version) => version.id));
  return room.comments.filter((comment) => ids.has(comment.versionId) && !comment.resolved).length;
}

export function sortBranchesByRecent(branches: RoomBranch[]): RoomBranch[] {
  return [...branches].sort((a, b) => b.updatedAt - a.updatedAt || a.sortOrder - b.sortOrder);
}
