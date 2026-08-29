import type { WhiteboardFrame } from "../features/collaboration/types";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContentRelation,
  Guest,
  PlanDocument,
  PollVote,
  ReactionType,
  ReviewBrief,
  ReviewProgress,
  ReviewStatus,
  Room,
  RoomBranch,
  RoomPoll,
  Verdict,
  Version,
  VersionVerdict,
  VideoReaction,
} from "../lib/types";
import { roomMediaType } from "../lib/types";
import { saveRoom } from "../lib/store";
import type { ShowToast } from "../toast";
import {
  applyCloudProposals,
  getProposalDocs,
  normalizeDoc,
  setProposalCloudSync,
  type VisualProposal,
} from "../features/visual-proposal/store";
import { isCloudConfigured } from "./config";
import { getSupabase } from "./client";
import { ensureSession } from "./auth";
import { isDuplicateKey, isInvalidInvite, isRevisionConflict, isStaleWrite } from "./errors";
import { isDecisionNotSaved } from "./decisionAck";
import { buildInviteUrl, generateInviteToken, readRoomLink } from "./invite";
import { clearCloudMapping, getCloudMapping, saveCloudMapping } from "./mapping";
import {
  addVersion as repoAddVersion,
  archiveVersion as repoArchiveVersion,
  completeRoomSetup,
  createRoom,
  deleteRelation,
  deleteStroke as repoDeleteStroke,
  insertBranch,
  insertComment,
  insertMessage,
  insertPoll,
  insertReply as repoInsertReply,
  insertRelation,
  insertStroke,
  joinRoom,
  canManageMedia,
  loadRoom,
  restoreVersion as repoRestoreVersion,
  updateBranch,
  upsertPlan,
  votePoll,
  type RoomRole,
  setCommentResolved,
  setPreference,
  setRoomTitle,
  setSupport,
  upsertProposal,
  type CloudProposal,
} from "./roomRepository";
import {
  ensureRoomPreview,
  rotateRoomPreview,
  type SharePreview,
  type SharePreviewPatch,
} from "./sharePreview";
import {
  addReaction,
  clearBrief,
  loadBriefs,
  loadProgress,
  loadReactions,
  loadVerdicts,
  reportProgress,
  saveBrief,
  saveVerdict,
  setReviewStatus,
  type BriefInput,
} from "./videoReview";
import { uploadVideoVersion, type VideoUploadHandle, type VideoUploadInput } from "./videoRoom";
import { signedVideoUrl } from "./videoAssets";
import { subscribeRoom, type Unsubscribe } from "./roomSync";
import type { SyncStatus } from "./types";
import { mergeRoomBranch } from "../lib/roomBranches";
import { uuid } from "../lib/id";
import {
  edgeFromRow,
  insertDecision as repoInsertDecision,
  insertAiApplyAudit,
  insertDiscussion,
  insertEdge,
  nodeFromRow,
  insertWhiteboard,
  loadWhiteboardGraph,
  setAllowBoardEdit as repoSetAllowBoardEdit,
  setDiscussionSupport as repoSetDiscussionSupport,
  updateDecision as repoUpdateDecision,
  updateWhiteboard as repoUpdateWhiteboard,
  upsertNode as repoUpsertNode,
  softDeleteNode as repoSoftDeleteNode,
  frameFromRow,
  upsertFrame as repoUpsertFrame,
  deleteFrame as repoDeleteFrame,
  restoreDeletedNode as repoRestoreDeletedNode,
  insertOperation as repoInsertOperation,
} from "./collaborationRepository";
import { decideNodeWriteRetry } from "../features/collaboration/offline";
import {
  acknowledgePendingWrite,
  enqueuePendingWrite,
  flushPendingWrites,
  type PendingWrite,
} from "./pendingWrites";

/** frames 即時事件（WB04）：別人建/移/刪的區塊。 */
export type FrameEvent =
  | { type: "upsert"; frame: WhiteboardFrame }
  | { type: "delete"; id: string };
export type FrameEventHandler = (event: FrameEvent) => void;

export type CloudWrites = {
  setTitle: (title: string) => void;
  insertComment: (pin: import("../lib/types").CommentPin) => void;
  setResolved: (id: string, resolved: boolean) => void;
  insertStroke: (stroke: import("../lib/types").Stroke) => void;
  deleteStroke: (id: string) => void;
  insertMessage: (msg: import("../lib/types").ChatMessage) => void;
  addVersion: (label: string, sortOrder: number, imageDataUrl: string, branchId?: string) => void;
  /** Resolves after the branch FK exists, so a first version/plan can follow it. */
  createBranch: (branch: RoomBranch) => Promise<void>;
  updateBranch: (branchId: string, patch: Partial<Pick<RoomBranch, "name" | "sortOrder" | "status">>) => void;
  savePlan: (plan: PlanDocument) => void;
  createRelation: (relation: ContentRelation) => void;
  deleteRelation: (relationId: string) => void;
  createPoll: (poll: RoomPoll) => void;
  votePoll: (vote: PollVote) => void;
  insertDiscussion?: (message: import("../features/collaboration/types").DiscussionMessage) => Promise<boolean>;
  /** AI 套用稽核列（0019）。回傳成敗；失敗不重試 — 討論串訊息是人看的 fallback。 */
  recordAiApplyAudit?: (entry: { proposalId: string; proposalType: string; label: string }) => Promise<boolean>;
  setDiscussionSupport?: (messageId: string, add: boolean) => void;
  createWhiteboard?: (board: import("../features/collaboration/types").Whiteboard) => void;
  updateWhiteboard?: (board: import("../features/collaboration/types").Whiteboard) => void;
  upsertNode?: (node: import("../features/collaboration/types").WhiteboardNode) => Promise<import("../features/collaboration/types").WhiteboardNode | false | "conflict">;
  deleteNode?: (id: string, version: number) => Promise<boolean | "conflict">;
  upsertFrame?: (
    frame: import("../features/collaboration/types").WhiteboardFrame,
    onPersisted?: (frame: import("../features/collaboration/types").WhiteboardFrame) => void,
    /** stale-write：這次寫入被丟棄，上層應重讀該板 frames 並提示。 */
    onConflict?: () => void,
  ) => void;
  deleteFrame?: (id: string) => void;
  /** 版本還原專用：復活被軟刪的節點（F1）。 */
  restoreNode?: (node: import("../features/collaboration/types").WhiteboardNode) => void;
  insertOperation?: (op: import("../features/collaboration/types").WhiteboardOperation) => void;
  createEdge?: (edge: import("../features/collaboration/types").WhiteboardEdge) => void;
  createDecision?: (decision: import("../features/collaboration/types").DecisionRecord) => Promise<void>;
  updateDecision?: (decision: import("../features/collaboration/types").DecisionRecord) => void;
  setAllowBoardEdit?: (allow: boolean) => void;
  toggleSupport: (commentId: string, add: boolean) => void;
  insertReply: (reply: import("../lib/types").CommentReply) => void;
  setProposalPref: (versionId: string, choice: string) => void;
  archiveVersion?: (versionId: string) => Promise<void>;
  restoreVersion?: (versionId: string) => Promise<void>;
};

/**
 * The result of asking for a permanent share link. Failure never carries a URL
 * — the caller has nothing safe to fall back to by design.
 */
export type ShareResult =
  | { ok: true; url: string }
  | { ok: false; reason: "not-configured" | "no-room" | "failed" };

/**
 * Open Graph preview control (PR #21). Every call is best-effort: the caller
 * already holds a working permanent share URL, and a preview must never be
 * allowed to take that away.
 */
export type SharePreviewApi = {
  /** Create or refresh this room's preview. null = nothing to preview yet. */
  ensure: (opts?: PreviewOpts) => Promise<SharePreview | null>;
  /** Revoke the current preview id and mint a new one. */
  rotate: (opts?: PreviewOpts) => Promise<SharePreview | null>;
};

/**
 * Everything 影片對稿 2.0 adds on top of comments (#32).
 *
 * Kept OUT of `Room` on purpose. Room is cached in IndexedDB, sent over PeerJS
 * and replayed into image workspaces; threading four review tables through it
 * would put video-only data on every one of those paths for no benefit. This is
 * a separate slice that only a video room ever reads.
 */
export type ReviewData = {
  briefs: ReviewBrief[];
  reactions: VideoReaction[];
  verdicts: VersionVerdict[];
  progress: ReviewProgress[];
};

export const EMPTY_REVIEW: ReviewData = { briefs: [], reactions: [], verdicts: [], progress: [] };

export type ReviewApi = {
  /** owner/editor only; RLS refuses a reviewer regardless of what the UI shows. */
  saveBrief: (versionId: string, input: BriefInput) => Promise<void>;
  clearBrief: (versionId: string) => Promise<void>;
  /** Returns false when the tap was a duplicate inside the 2s bucket. */
  react: (versionId: string, time: number, type: ReactionType) => Promise<boolean>;
  setVerdict: (versionId: string, verdict: Verdict, note?: string) => Promise<void>;
  reportProgress: (versionId: string, maxWatched: number, completed: boolean) => Promise<void>;
  setStatus: (commentId: string, status: ReviewStatus) => Promise<void>;
};

/**
 * `patch` carries edits to the CARD only. Nothing in it can reach rooms.title,
 * the version image, the poster frame or the original upload — that separation
 * is the whole point of customising a share (PR #30).
 */
export type PreviewOpts = {
  versionId?: string;
  showThumbnail?: boolean;
  patch?: SharePreviewPatch;
};

export type BoardPatch =
  | { type: "node-upsert"; node: import("../features/collaboration/types").WhiteboardNode }
  | { type: "node-delete"; id: string }
  | { type: "edge-insert"; edge: import("../features/collaboration/types").WhiteboardEdge }
  | { type: "edge-delete"; id: string };

type Params = {
  guest: Guest | null;
  room: Room | null;
  activeBranchId?: string | null;
  /** 開著的白板 id：channel 重連/revive 時對它做 loadWhiteboard 自癒。 */
  activeWhiteboardId?: string | null;
  isGuestSession: boolean;
  onSnapshot: (room: Room) => void;
  /** 白板增量（PR-02c）：走專屬回呼，不經 applyRemoteRoom（deep-link 消耗不得重跑）。 */
  onBoardPatch?: (patch: BoardPatch) => void;
  /**
   * 板級自癒（Grok pr02c F3）：整板以雲端 graph 替換 — 走 applyRemoteRoom
   * 會被空陣列守門與 reconcile 的「本地補回」擋住，斷線期間的 DELETE
   * 永遠癒不掉。
   */
  onBoardReplace?: (whiteboardId: string, graph: { nodes: import("../features/collaboration/types").WhiteboardNode[]; edges: import("../features/collaboration/types").WhiteboardEdge[] }) => void;
  showToast: ShowToast;
};

/**
 * Visual proposal 2.0 keeps its extra fields (type / status / description /
 * supports / discussion / linked pin) inside the existing `payload` jsonb, so
 * the cloud schema, RLS and RPCs are untouched. The row columns still win for
 * identity and name.
 */
function proposalToStore(p: CloudProposal): VisualProposal {
  const payload = (p.payload ?? {}) as Record<string, unknown>;
  const doc = normalizeDoc({
    ...payload,
    id: p.id,
    versionId: p.versionId,
    name: p.name,
    title: typeof payload.title === "string" && payload.title.trim() ? payload.title : p.name,
    authorName: p.authorName,
  });
  // id and versionId are always supplied above, so normalization cannot reject it.
  return doc!;
}

function proposalToPayload(doc: VisualProposal): Record<string, unknown> {
  return {
    items: doc.items,
    background: doc.background,
    title: doc.title,
    description: doc.description,
    type: doc.type,
    status: doc.status,
    createdBy: doc.createdBy,
    linkedCommentId: doc.linkedCommentId ?? null,
    supports: doc.supports,
    comments: doc.comments,
    createdAt: doc.createdAt,
  };
}

/**
 * Remember a room's cloud identity under BOTH ids.
 *
 * The moment a room reaches the cloud, the snapshot that comes back carries the
 * cloud UUID as the room's id — the local six-character code is gone from
 * state. A mapping filed only under the local code therefore stops being
 * findable exactly when it starts mattering: on the next bind (or the next time
 * the room is opened from 最近討論) the lookup misses and the room quietly
 * drops to local-only, taking realtime and every cloud write with it.
 *
 * Filing it under the cloud id as well makes the room self-describing.
 */
function rememberCloudRoom(localRoomId: string, roomId: string, token: string, pendingSetup?: boolean): void {
  const mapping = pendingSetup ? { roomId, token, pendingSetup: true as const } : { roomId, token };
  saveCloudMapping(localRoomId, mapping);
  saveCloudMapping(roomId, mapping);
}

/**
 * Binds the active room to the cloud when configured. Inert (returns
 * local-only) otherwise, so the local IndexedDB + PeerJS path is untouched.
 */
export function useCloudRoom({ guest, room, activeBranchId, activeWhiteboardId, isGuestSession, onSnapshot, onBoardPatch, onBoardReplace, showToast }: Params) {
  const [status, setStatus] = useState<SyncStatus>(isCloudConfigured ? "connecting" : "local-only");
  const [online, setOnline] = useState(0);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteInvalid, setInviteInvalid] = useState(false);
  /**
   * This visitor's capability in the bound room. Null until the first snapshot
   * lands (and in a local-only session); the UI treats "unknown" as "cannot
   * manage" only after the room is actually bound, so a purely local room keeps
   * behaving like a room you own.
   */
  const [role, setRole] = useState<RoomRole | null>(null);
  const [bindNonce, setBindNonce] = useState(0);
  /** 影片對稿 2.0 (#32). Empty and untouched for image rooms. */
  const [review, setReview] = useState<ReviewData>(EMPTY_REVIEW);
  /**
   * This visitor's CLOUD id (`auth.uid()`), which is what every per-user row is
   * keyed by. Deliberately not `guest.id` — that is a locally generated `g_…`
   * string for display, and matching it against a database `user_id` would mean
   * "my verdict" and "my reaction" never find anything.
   */
  const [userId, setUserId] = useState<string | null>(null);
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = userId;

  const boundRef = useRef<string | null>(null); // cloud room id
  const unsubRef = useRef<Unsubscribe | null>(null);
  const revisions = useRef<Map<string, number>>(new Map());
  const pending = useRef<PendingWrite[]>([]);
  const reloadTimer = useRef<number | null>(null);
  const roomRef = useRef<Room | null>(room);
  const activeBranchRef = useRef<string | null>(activeBranchId ?? null);
  const activeWhiteboardRef = useRef<string | null>(activeWhiteboardId ?? null);
  activeWhiteboardRef.current = activeWhiteboardId ?? null;
  const onBoardPatchRef = useRef(onBoardPatch);
  onBoardPatchRef.current = onBoardPatch;
  const onBoardReplaceRef = useRef(onBoardReplace);
  onBoardReplaceRef.current = onBoardReplace;
  roomRef.current = room;
  activeBranchRef.current = activeBranchId ?? null;
  const supabase = getSupabase();

  /**
   * Pull the four review tables for a video room.
   *
   * Best-effort by design: a room whose database has not run 0012 yet, or a
   * transient failure, must still leave the video playable and the comments
   * readable. An empty slice degrades the review UI, never the room.
   */
  const reloadReview = useCallback(
    async (rid: string, mediaType: string) => {
      if (!supabase || mediaType !== "video") {
        setReview(EMPTY_REVIEW);
        return;
      }
      try {
        const [briefs, reactions, verdicts, progress] = await Promise.all([
          loadBriefs(supabase, rid),
          loadReactions(supabase, rid),
          loadVerdicts(supabase, rid),
          loadProgress(supabase, rid),
        ]);
        setReview({ briefs, reactions, verdicts, progress });
      } catch {
        /* the room still works; only the review extras are missing */
      }
    },
    [supabase],
  );

  const reload = useCallback(async () => {
    const rid = boundRef.current;
    if (!supabase || !rid) return;
    setStatus("syncing");
    try {
      const selected = activeBranchRef.current;
      const current = roomRef.current;
      const selectedBranch = selected ? current?.branches?.find((branch) => branch.id === selected) : undefined;
      const detailBranchId = selectedBranch && (selectedBranch.branchType === "poster" || selectedBranch.branchType === "video")
        ? selectedBranch.id
        : null;
      const snap = detailBranchId
        ? await loadRoom(supabase, rid, { mode: "branch", branchId: detailBranchId })
        : await loadRoom(supabase, rid);
      const nextRoom = detailBranchId && current?.projectMode
        ? mergeRoomBranch(current, snap.room, detailBranchId)
        : snap.room;
      setRole(snap.role);
      onSnapshot(nextRoom);
      saveRoom(nextRoom).catch(() => undefined);
      revisions.current = new Map(snap.proposals.map((p) => [p.id, p.revision]));
      applyCloudProposals(rid, snap.proposals.map(proposalToStore));
      setStatus("synced");
      // After the room, not with it: the review slice is an enhancement and must
      // never delay the video or the discussion appearing. Riding on `reload`
      // also means every realtime nudge and every reconnect refreshes it, which
      // is exactly the "at least reload after reconnect" the spec asks for.
      const selectedMediaType = selectedBranch?.branchType === "video" ? "video" : roomMediaType(nextRoom);
      void reloadReview(rid, selectedMediaType);
    } catch {
      setStatus("error");
    }
  }, [supabase, onSnapshot, reloadReview]);

  /** Load one content branch without pulling other branches' assets/comments. */
  const loadBranch = useCallback(async (branchId: string): Promise<boolean> => {
    const rid = boundRef.current;
    if (!supabase || !rid) return false;
    setStatus("syncing");
    try {
      const snap = await loadRoom(supabase, rid, { mode: "branch", branchId });
      const current = roomRef.current;
      const nextRoom = current?.projectMode ? mergeRoomBranch(current, snap.room, branchId) : snap.room;
      setRole(snap.role);
      onSnapshot(nextRoom);
      saveRoom(nextRoom).catch(() => undefined);
      revisions.current = new Map(snap.proposals.map((p) => [p.id, p.revision]));
      applyCloudProposals(rid, snap.proposals.map(proposalToStore));
      setStatus("synced");
      const branch = current?.branches?.find((item) => item.id === branchId) ?? snap.room.branches?.find((item) => item.id === branchId);
      const selectedMediaType = branch?.branchType === "video" ? "video" : roomMediaType(nextRoom);
      void reloadReview(rid, selectedMediaType);
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }, [supabase, onSnapshot, reloadReview]);

  const loadWhiteboard = useCallback(async (whiteboardId: string): Promise<boolean> => {
    const rid = boundRef.current;
    if (!supabase || !rid) return false;
    try {
      const graph = await loadWhiteboardGraph(supabase, rid, whiteboardId);
      if (onBoardReplaceRef.current) {
        // 整板替換：斷線期間的 DELETE 也癒得掉（Grok pr02c F3）。
        onBoardReplaceRef.current(whiteboardId, graph);
        return true;
      }
      const current = roomRef.current;
      if (!current) return false;
      const otherNodes = (current.whiteboardNodes ?? []).filter((node) => node.whiteboardId !== whiteboardId);
      const otherEdges = (current.whiteboardEdges ?? []).filter((edge) => edge.whiteboardId !== whiteboardId);
      onSnapshot({ ...current, whiteboardNodes: [...otherNodes, ...graph.nodes], whiteboardEdges: [...otherEdges, ...graph.edges] });
      return true;
    } catch {
      return false;
    }
  }, [supabase, onSnapshot]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void reload(), 200);
  }, [reload]);

  const flushPending = useCallback(async () => {
    if (!pending.current.length) return;
    const queue = pending.current;
    pending.current = [];
    pending.current = await flushPendingWrites(queue, isDuplicateKey);
    setStatus(pending.current.length ? "offline-pending" : "synced");
  }, []);

  /** Run a cloud write with optimistic UI already done; queue + degrade on failure. */
  // ---- WB04 realtime ----
  const [presencePeople, setPresencePeople] = useState<import("./roomSync").PresencePerson[]>([]);
  const sessionUserIdRef = useRef<string | null>(null);
  /** frames 即時事件出口（App 掛上）。 */
  const onFrameEventRef = useRef<FrameEventHandler | null>(null);
  const displayNameRef = useRef("");
  /** 重連／回前景時要一起自癒的東西（App 掛 frames 重讀）。 */
  const reviveExtraRef = useRef<(() => void) | null>(null);
  // frame 的「執行時最新值」— 見 writes.upsertFrame（S6 版本簿記）
  const frameLatest = useRef(new Map<string, import("../features/collaboration/types").WhiteboardFrame>());
  const run = useCallback(
    (key: string, task: () => Promise<void>) => {
      if (!supabase || !boundRef.current) return;
      setStatus("syncing");
      task()
        .then(() => {
          pending.current = acknowledgePendingWrite(pending.current, key);
          setStatus(pending.current.length ? "offline-pending" : "synced");
        })
        .catch((err) => {
          if (isDuplicateKey(err)) {
            pending.current = acknowledgePendingWrite(pending.current, key);
            setStatus(pending.current.length ? "offline-pending" : "synced");
            return;
          }
          pending.current = enqueuePendingWrite(pending.current, { key, task });
          setStatus("offline-pending");
        });
    },
    [supabase],
  );

  /**
   * A small awaitable sibling for writes whose dependants are sent in the same
   * gesture. The normal `run` intentionally swallows errors into the offline
   * queue; branch creation must be observable so a first plan/version never
   * races its `(branch_id, room_id)` foreign key on a slow mobile connection.
   */
  const runAndWait = useCallback(
    async (key: string, task: () => Promise<void>): Promise<void> => {
      if (!supabase || !boundRef.current) return;
      setStatus("syncing");
      try {
        await task();
        pending.current = acknowledgePendingWrite(pending.current, key);
        setStatus(pending.current.length ? "offline-pending" : "synced");
      } catch (err) {
        if (isDuplicateKey(err)) {
          pending.current = acknowledgePendingWrite(pending.current, key);
          setStatus(pending.current.length ? "offline-pending" : "synced");
          return;
        }
        pending.current = enqueuePendingWrite(pending.current, { key, task });
        setStatus("offline-pending");
        throw err;
      }
    },
    [supabase],
  );

  /**
   * Awaitable node write. Failures are NOT pushed to the in-memory `pending`
   * queue — IndexedDB is the only retry owner, so a later successful edit
   * cannot be overwritten by a stale captured closure.
   */
  const writeAck = useCallback(
    async <T>(task: () => Promise<T>): Promise<T | false | "conflict"> => {
      if (!supabase || !boundRef.current) return false;
      setStatus("syncing");
      try {
        const value = await task();
        setStatus(pending.current.length ? "offline-pending" : "synced");
        return value;
      } catch (err) {
        if (isDuplicateKey(err)) {
          setStatus(pending.current.length ? "offline-pending" : "synced");
          return false;
        }
        if (isStaleWrite(err)) {
          // 版本衝突：舊 payload 不可能被接受。refetch 由呼叫端負責 —
          // 這裡不 scheduleReload：summary 路徑的 nodes 是空的（lazy），
          // 對開著的白板是空操作（Grok pr02b F2），真正的取新是
          // loadWhiteboard(該板)。
          setStatus(pending.current.length ? "offline-pending" : "synced");
          return "conflict";
        }
        const retry = decideNodeWriteRetry("failed");
        // queueMemory stays false: IndexedDB is the only node retry owner.
        void retry;
        setStatus("offline-pending");
        return false;
      }
    },
    [supabase],
  );

  // Bind: join (guest with invite) or reconnect (owner via mapping), then load + subscribe.
  useEffect(() => {
    if (!supabase || !guest) return;
    const link = readRoomLink();
    const mapping = room ? getCloudMapping(room.id) : null;

    let targetRoomId: string | null = null;
    let token: string | null = null;
    if (isGuestSession) {
      // Only a cloud link (`#room=<uuid>&invite=<token>`) can join a cloud
      // room. A legacy `#room=<6碼>` link carries no invite, so it must not
      // touch the cloud at all — it stays on the PeerJS compatibility path.
      if (link.kind !== "cloud") {
        setStatus("local-only");
        return;
      }
      targetRoomId = link.roomId;
      token = link.invite;
    } else if (mapping) {
      targetRoomId = mapping.roomId;
      token = mapping.token;
    }
    if (!targetRoomId) {
      setStatus("local-only");
      return;
    }
    // Bound AND listening is the state worth skipping. Bound-but-unsubscribed
    // happens when a video room was just created here (ensureCloudRoom binds
    // first so its upload can authorise), and that room still needs realtime.
    if (boundRef.current === targetRoomId && unsubRef.current) return;

    let cancelled = false;
    unsubRef.current?.();
    unsubRef.current = null;
    setStatus("connecting");
    setInviteInvalid(false);
    (async () => {
      try {
        const sessionUserId = await ensureSession(supabase);
        setUserId(sessionUserId);
        sessionUserIdRef.current = sessionUserId;
        if (isGuestSession && token) {
          await joinRoom(supabase, targetRoomId, token, guest);
        }
        if (cancelled) return;
        boundRef.current = targetRoomId;
        setInviteUrl(token ? buildInviteUrl(targetRoomId, token) : null);
        await reload();
        // The snapshot that just landed re-keys the room to its cloud id, which
        // re-runs this effect. Subscribing now would leave a channel the next
        // cleanup no longer knows about.
        if (cancelled) return;
        setProposalCloudSync(targetRoomId, (doc) => {
          run(`proposal:${doc.id}`, async () => {
            const expected = revisions.current.get(doc.id) ?? 0;
            try {
              const next = await upsertProposal(supabase, targetRoomId!, {
                id: doc.id,
                versionId: doc.versionId,
                authorName: doc.authorName,
                name: doc.title,
                payload: proposalToPayload(doc),
                revision: expected,
              });
              revisions.current.set(doc.id, next);
            } catch (err) {
              if (isRevisionConflict(err)) {
                showToast("提案剛被其他夥伴更新，已載入最新內容");
                await reload();
              } else {
                throw err;
              }
            }
          });
        });
        // presence key 必須與 cloud.userId 同源（P8）：舊寫法用 getUser()
        // （會打網路，失敗回 "anon"），自我過濾卻比對 ensureSession 的 id —
        // 兩者分歧時使用者會在「也在這塊板」看到自己。
        unsubRef.current = subscribeRoom(supabase, targetRoomId, sessionUserIdRef.current ?? "anon", {
          onRoom: scheduleReload,
          onCommentUpsert: scheduleReload,
          onStrokeInsert: scheduleReload,
          onStrokeDelete: scheduleReload,
          onMessageInsert: scheduleReload,
          onVersionInsert: scheduleReload,
          onProposalUpsert: (r) => {
            revisions.current.set(r.id, r.revision);
            applyCloudProposals(targetRoomId!, [
              proposalToStore({ id: r.id, versionId: r.version_id, authorName: r.author_name, name: r.name, payload: r.payload, revision: r.revision }),
            ]);
          },
          onFeedbackChange: scheduleReload,
          onProjectChange: scheduleReload,
          // 白板增量：row → domain，直接 patch（不整房 reload — PR-02c）
          onBoardNodeUpsert: (row) => {
            const node = nodeFromRow(row);
            if (!node) return;
            // tombstone 的 UPDATE echo 轉刪除 patch（Grok wb00 F3：照 upsert
            // 走會把本地已刪節點以更高 version 復活）。applyBoardPatches 內
            // 另有同語意防線 — 兩層都測。
            if (node.deletedAt) onBoardPatchRef.current?.({ type: "node-delete", id: node.id });
            else onBoardPatchRef.current?.({ type: "node-upsert", node });
          },
          onBoardNodeDelete: (id) => onBoardPatchRef.current?.({ type: "node-delete", id }),
          onBoardEdgeInsert: (row) => {
            const edge = edgeFromRow(row);
            if (edge) onBoardPatchRef.current?.({ type: "edge-insert", edge });
          },
          onBoardEdgeDelete: (id) => onBoardPatchRef.current?.({ type: "edge-delete", id }),
          // frames 即時（WB04）：別人建/移/刪的區塊直接進畫面
          onBoardFrameUpsert: (row) => {
            const frame = frameFromRow(row);
            if (frame) onFrameEventRef.current?.({ type: "upsert", frame });
          },
          onBoardFrameDelete: (id) => onFrameEventRef.current?.({ type: "delete", id }),
          onPresence: setOnline,
          onPresenceList: (people) => setPresencePeople(people),
          // 重訂閱時 track 的初值現查（F3）
          getPresenceIdentity: () => ({ boardId: activeWhiteboardRef.current }),
          onStatus: (connected) => {
            if (connected) {
              void flushPending();
              // row-patch 拿掉了 nudge 的意外自癒：重連時對開著的板
              // 刻意 loadWhiteboard 補齊斷線期間漏掉的增量。
              if (activeWhiteboardRef.current) void loadWhiteboard(activeWhiteboardRef.current);
              reviveExtraRef.current?.(); // frames 不在 graph 裡，另外補（R2）
            }
            setStatus((s) => (connected ? (pending.current.length ? "offline-pending" : "synced") : "connecting"));
          },
        });
      } catch (err) {
        if (cancelled) return;
        if (isInvalidInvite(err)) {
          setInviteInvalid(true);
          showToast("這個分享連結已失效，請向主辦方取得新連結", { tone: "error" });
        }
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (boundRef.current) setProposalCloudSync(boundRef.current, null);
      unsubRef.current?.();
      unsubRef.current = null;
      boundRef.current = null;
      // 在場名單只由 sync 事件推進，channel 一收掉就再也不會更新 —
      // 不清空的話「N 在板上」會凍結在最後一次 sync（P10）。
      setPresencePeople([]);
      setOnline(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, guest?.id, isGuestSession, room?.id, bindNonce]);

  /**
   * Self-heal after phone freezes / network loss: whenever the tab is visible
   * or online again, push queued writes out and pull the latest snapshot, so
   * coming back from LINE never leaves the room stale or stuck.
   */
  useEffect(() => {
    const revive = () => {
      void (async () => {
        await flushPending();
        if (boundRef.current) await reload();
        // 開著的板另外補一次增量（整房 reload 的 summary 不含 nodes）。
        if (boundRef.current && activeWhiteboardRef.current) await loadWhiteboard(activeWhiteboardRef.current);
      })();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") revive();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", revive);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", revive);
    };
  }, [flushPending, reload]);

  /** 再試一次: reload when bound, otherwise redo auth + join + load from scratch. */
  const retry = useCallback(() => {
    setInviteInvalid(false);
    if (boundRef.current) {
      void (async () => {
        await flushPending();
        await reload();
        if (activeWhiteboardRef.current) await loadWhiteboard(activeWhiteboardRef.current);
      })();
    } else {
      setStatus("connecting");
      setBindNonce((n) => n + 1);
    }
  }, [flushPending, reload]);

  /**
   * Creates (or re-reads) the room's permanent cloud share link. The only
   * success shape is a `#room=<uuid>&invite=<token>` URL: callers must never
   * fall back to a legacy host-must-stay-online URL when this fails (PR #16).
   */
  const ensureShared = useCallback(async (): Promise<ShareResult> => {
    if (!supabase) return { ok: false, reason: "not-configured" };
    if (!guest || !room) return { ok: false, reason: "no-room" };
    if (boundRef.current) {
      const token = getCloudMapping(room.id)?.token;
      const url = token ? buildInviteUrl(boundRef.current, token) : inviteUrl;
      // Bound as a guest without the raw token (never persisted for guests):
      // there is no link to hand out, so say so instead of inventing one.
      return url ? { ok: true, url } : { ok: false, reason: "failed" };
    }
    if (isGuestSession) {
      // A guest re-sharing must not fork a second cloud room off their copy.
      return { ok: false, reason: "no-room" };
    }
    setStatus("syncing");
    try {
      await ensureSession(supabase);
      const token = generateInviteToken();
      // Gather the room's proposals from the store cache so they migrate too.
      const localProposals: CloudProposal[] = getProposalDocs(room.id).map((d) => ({
        id: d.id,
        versionId: d.versionId,
        authorName: d.authorName,
        name: d.title,
        payload: proposalToPayload(d),
        revision: 1,
      }));
      const { roomId } = await createRoom(supabase, { room, proposals: localProposals }, guest, token);
      rememberCloudRoom(room.id, roomId, token);
      boundRef.current = roomId;
      const url = buildInviteUrl(roomId, token);
      setInviteUrl(url);
      await reload();
      setProposalCloudSync(roomId, (doc) => {
        run(`proposal:${doc.id}`, async () => {
          const expected = revisions.current.get(doc.id) ?? 0;
          const next = await upsertProposal(supabase, roomId, {
            id: doc.id,
            versionId: doc.versionId,
            authorName: doc.authorName,
            name: doc.title,
            payload: proposalToPayload(doc),
            revision: expected,
          });
          revisions.current.set(doc.id, next);
        });
      });
      setStatus("synced");
      return { ok: true, url };
    } catch {
      setStatus("error");
      showToast("建立分享連結失敗，內容仍保存在這台裝置。", { tone: "error" });
      return { ok: false, reason: "failed" };
    }
  }, [supabase, guest, room, isGuestSession, inviteUrl, reload, run, showToast]);

  /**
   * Put a room in the cloud NOW, from an explicitly passed Room.
   *
   * Poster rooms reach the cloud lazily, when someone taps 分享. A video room
   * cannot: Storage authorises an upload by looking at `rooms/<room-id>/…` and
   * checking membership, so the room and the membership row have to exist
   * before the first byte moves. The Room is passed in rather than read from
   * this hook's props because the caller has just created it — React has not
   * re-rendered yet, and the stale value would create the wrong room.
   */
  const ensureCloudRoom = useCallback(
    async (target: Room): Promise<{ roomId: string; url: string } | null> => {
      if (!supabase || !guest) return null;
      if (boundRef.current) {
        // Already bound — that is the whole requirement for an upload, because
        // Storage authorises on membership. A guest has no stored token (theirs
        // lives in the URL and is never persisted), so the URL is best-effort.
        const token = getCloudMapping(target.id)?.token;
        return {
          roomId: boundRef.current,
          url: token ? buildInviteUrl(boundRef.current, token) : (inviteUrl ?? ""),
        };
      }
      const mapped = getCloudMapping(target.id);
      if (mapped) {
        if (mapped.pendingSetup) {
          // 上一次 create 死在 RPC 之後：房間列在，設定未確認。先冪等
          // 補完（PATCH＋branch upsert），成功才清旗標 — 失敗就原樣拋出，
          // 映射留著，下一次重試仍沿用同一間房。
          setStatus("syncing");
          await ensureSession(supabase);
          await completeRoomSetup(supabase, target, mapped.roomId);
          rememberCloudRoom(target.id, mapped.roomId, mapped.token);
        }
        boundRef.current = mapped.roomId;
        const url = buildInviteUrl(mapped.roomId, mapped.token);
        setInviteUrl(url);
        if (mapped.pendingSetup) {
          setStatus("synced");
          setBindNonce((n) => n + 1);
        }
        return { roomId: mapped.roomId, url };
      }
      setStatus("syncing");
      await ensureSession(supabase);
      const token = generateInviteToken();
      // 無版本可搬的房（影片首上傳在同手勢現建的那種）啟用早期映射：
      // RPC 一成功就記下 pendingSetup 映射，之後任何一步死掉，重試都
      // 沿用同一間房（NOTE_SLOW_DEVICE_FIRSTUPLOAD）。有版本要搬的房
      // 維持全成功才記映射的舊語意 — 半途映射會讓重試跳過版本搬移。
      const earlyMap = (target.versions?.length ?? 0) === 0
        ? (roomId: string) => rememberCloudRoom(target.id, roomId, token, true)
        : undefined;
      const { roomId } = await createRoom(supabase, { room: target, proposals: [] }, guest, token, earlyMap);
      rememberCloudRoom(target.id, roomId, token);
      boundRef.current = roomId;
      const url = buildInviteUrl(roomId, token);
      setInviteUrl(url);
      setStatus("synced");
      // Re-run the bind effect so realtime + presence attach to the new room.
      setBindNonce((n) => n + 1);
      return { roomId, url };
    },
    [supabase, guest],
  );

  /**
   * Forget a cloud room this device created but never filled.
   *
   * Without this, a failed first upload leaves the mapping pointing at an empty
   * room; the next attempt starts from a fresh local id, creates a SECOND cloud
   * room, and the first one is unreachable forever.
   */
  const forgetCloudRoom = useCallback((localRoomId: string): string | null => {
    const mapped = getCloudMapping(localRoomId);
    clearCloudMapping(localRoomId);
    if (mapped) clearCloudMapping(mapped.roomId);
    unsubRef.current?.();
    unsubRef.current = null;
    boundRef.current = null;
    setInviteUrl(null);
    setStatus(isCloudConfigured ? "connecting" : "local-only");
    return mapped?.roomId ?? null;
  }, []);

  /**
   * Upload one cut and write its row. Progress is reported in real bytes; the
   * caller owns the UI state machine and the cancel button.
   */
  const uploadVideo = useCallback(
    (
      input: Omit<VideoUploadInput, "roomId"> & { roomId?: string },
      onPhase: (phase: "preparing" | "optimizing" | "uploading" | "paused" | "retrying" | "processing", progress: number) => void,
    ): VideoUploadHandle | null => {
      const rid = input.roomId ?? boundRef.current;
      if (!supabase || !rid) return null;
      // Storage RLS refuses a reviewer's upload anyway (migration 0007); this
      // stops a 100MB transfer that was always going to end in a 403.
      if (boundRef.current === rid && role === "reviewer") {
        showToast("你在這個房間是「檢視者」，可以留言但不能換版本。請房主把你設為協作者。");
        return null;
      }
      return uploadVideoVersion(supabase, { ...input, roomId: rid }, onPhase);
    },
    [supabase, role, showToast],
  );

  /** A signed video URL expires mid-session; the player asks for a fresh one. */
  const refreshVideoUrl = useCallback(
    async (path: string): Promise<string | null> => {
      if (!supabase || !path) return null;
      return await signedVideoUrl(supabase, path).catch(() => null);
    },
    [supabase],
  );

  /**
   * Resolve the room title + the version to put on the card straight from the
   * cloud, not from React state: right after a migration the local room object
   * still carries pre-migration version ids, and a share tap can land before
   * the snapshot has re-rendered.
   */
  const resolvePreviewTarget = useCallback(
    async (versionHint?: string): Promise<{ roomId: string; versionId: string; title: string } | null> => {
      const rid = boundRef.current;
      if (!supabase || !rid) return null;
      const [roomRes, versionsRes] = await Promise.all([
        supabase.from("rooms").select("title").eq("id", rid).single(),
        supabase.from("versions").select("id").eq("room_id", rid).order("sort_order", { ascending: true }),
      ]);
      const rows = (versionsRes.data as { id: string }[] | null) ?? [];
      if (rows.length === 0) return null; // nothing worth putting on a card yet
      const chosen = rows.find((v) => v.id === versionHint) ?? rows[0];
      const title = ((roomRes.data as { title?: string } | null)?.title ?? "").trim();
      // An empty room title falls back inside sharePresentation(), which knows
      // whether the product label should be 文宣討論區 or 影片對稿.
      return { roomId: rid, versionId: chosen.id, title };
    },
    [supabase],
  );

  // A video room's card says what a video room asks for. The picture is the
  // poster frame, which is already this version's stored image — so the whole
  // Open Graph pipeline, and the anonymous read surface behind it, is unchanged.
  //
  // It is written for image rooms too, not only video ones: `media_type` is what
  // the Edge Function reads to pick a fallback brand, so leaving it implicit
  // would make an untouched poster card indistinguishable from a row that
  // predates the column.
  const previewExtras = () => {
    const branch = activeBranchRef.current
      ? roomRef.current?.branches?.find((item) => item.id === activeBranchRef.current)
      : undefined;
    return {
      mediaType: branch
        ? branch.branchType === "video" ? "video" as const : "image" as const
        : roomRef.current ? roomMediaType(roomRef.current) : "image" as const,
    };
  };

  const preview: SharePreviewApi = {
    ensure: async (opts) => {
      const target = await resolvePreviewTarget(opts?.versionId);
      if (!target || !supabase) return null;
      return ensureRoomPreview(supabase, {
        ...target,
        ...previewExtras(),
        showThumbnail: opts?.showThumbnail,
        patch: opts?.patch,
      });
    },
    rotate: async (opts) => {
      const target = await resolvePreviewTarget(opts?.versionId);
      if (!target || !supabase) return null;
      return rotateRoomPreview(supabase, {
        ...target,
        ...previewExtras(),
        showThumbnail: opts?.showThumbnail,
        patch: opts?.patch,
      });
    },
  };

  /**
   * Every write refreshes the slice from the server rather than patching local
   * state. These are low-frequency, human-paced actions (one tap, one save), so
   * a round trip is cheap — and it keeps one source of truth instead of two
   * that can drift when a write is rejected by RLS.
   */
  const refreshReview = () => {
    const rid = boundRef.current;
    const branch = activeBranchRef.current
      ? room?.branches?.find((item) => item.id === activeBranchRef.current)
      : undefined;
    const mediaType = branch?.branchType === "video" ? "video" : room ? roomMediaType(room) : "image";
    if (rid && room) void reloadReview(rid, mediaType);
  };

  const reviewApi: ReviewApi = {
    saveBrief: async (versionId, input) => {
      const rid = boundRef.current;
      if (!supabase || !rid) return;
      await saveBrief(supabase, rid, versionId, input);
      refreshReview();
    },
    clearBrief: async (versionId) => {
      if (!supabase) return;
      await clearBrief(supabase, versionId);
      refreshReview();
    },
    react: async (versionId, time, type) => {
      const rid = boundRef.current;
      if (!supabase || !rid) return false;
      const added = await addReaction(supabase, rid, versionId, time, type);
      if (added) refreshReview();
      return Boolean(added);
    },
    setVerdict: async (versionId, verdict, note) => {
      const rid = boundRef.current;
      if (!supabase || !rid) return;
      await saveVerdict(supabase, rid, versionId, verdict, note);
      refreshReview();
    },
    reportProgress: async (versionId, maxWatched, completed) => {
      const rid = boundRef.current;
      if (!supabase || !rid) return;
      await reportProgress(supabase, rid, versionId, maxWatched, completed);
      // No refresh: progress is written far more often than it is read, and
      // nobody is watching their own number change while the video plays.
    },
    setStatus: async (commentId, status) => {
      if (!supabase) return;
      await setReviewStatus(supabase, commentId, status);
      scheduleReload();
    },
  };

  const writes: CloudWrites = {
    setTitle: (title) => run("room-title", () => setRoomTitle(supabase!, boundRef.current!, title)),
    insertComment: (pin) => run(`comment:${pin.id}`, () => insertComment(supabase!, boundRef.current!, pin)),
    setResolved: (id, resolved) => run(`comment-resolved:${id}`, () => setCommentResolved(supabase!, id, resolved)),
    insertStroke: (stroke) => run(`stroke:${stroke.id}`, () => insertStroke(supabase!, boundRef.current!, stroke)),
    deleteStroke: (id) => run(`stroke-del:${id}`, () => repoDeleteStroke(supabase!, id)),
    insertMessage: (msg) => run(`message:${msg.id}`, () => insertMessage(supabase!, boundRef.current!, msg)),
    addVersion: (label, sortOrder, imageDataUrl, branchId) => {
      // 穩定 id 在排隊當下鑄一次：run() 的 duplicate-key=acknowledge 因此
      // 對 replay 真正冪等（回應丟失的重送不會複製版本）。
      const stableId = uuid();
      run(`version:${branchId ?? "room"}:${sortOrder}:${label}`, async () => {
        const v: Version = await repoAddVersion(supabase!, boundRef.current!, label, sortOrder, imageDataUrl, branchId, stableId);
        void v;
        scheduleReload();
      });
    },
    createBranch: (branch) => runAndWait(`branch-insert:${branch.id}`, () => insertBranch(supabase!, branch)),
    updateBranch: (branchId, patch) => run(`branch:${branchId}`, () => updateBranch(supabase!, boundRef.current!, branchId, patch)),
    savePlan: (plan) => run(`plan:${plan.branchId}`, () => upsertPlan(supabase!, plan, boundRef.current!)),
    createRelation: (relation) => run(`relation:${relation.id}`, () => insertRelation(supabase!, relation)),
    deleteRelation: (relationId) => run(`relation-del:${relationId}`, () => deleteRelation(supabase!, boundRef.current!, relationId)),
    createPoll: (poll) => run(`poll:${poll.id}`, () => insertPoll(supabase!, poll)),
    votePoll: (vote) => run(`vote:${vote.pollId}:${vote.userId}`, () => votePoll(supabase!, vote)),
    // 討論訊息要能在 UI 上呈現「未送出／重試」，所以回傳可等待的成敗，
    // 而且失敗不進 pending 佇列（keyed run 也不用）— 重試的唯一擁有者是
    // App 端的 outbox（自動補送會跟使用者手動重試打架）。
    // duplicate-key 視為成功：id 相同代表上一次其實已寫入、只是回應沒到。
    recordAiApplyAudit: async (entry) => {
      if (!supabase || !boundRef.current || !userIdRef.current) return false;
      try {
        await insertAiApplyAudit(supabase, {
          roomId: boundRef.current,
          actorUserId: userIdRef.current,
          proposalId: entry.proposalId,
          proposalType: entry.proposalType,
          label: entry.label,
        });
        return true;
      } catch {
        return false; // 稽核失敗不擋套用結果；App 端以 toast 誠實告知
      }
    },
    insertDiscussion: async (message) => {
      if (!supabase || !boundRef.current) return false;
      setStatus("syncing");
      try {
        await insertDiscussion(supabase, message);
        setStatus(pending.current.length ? "offline-pending" : "synced");
        return true;
      } catch (err) {
        if (isDuplicateKey(err)) {
          setStatus(pending.current.length ? "offline-pending" : "synced");
          return true;
        }
        setStatus("offline-pending");
        return false;
      }
    },
    setDiscussionSupport: (messageId, add) => run(`support:${messageId}`, () => repoSetDiscussionSupport(supabase!, boundRef.current!, messageId, add)),
    createWhiteboard: (board) => run(`whiteboard-insert:${board.id}`, () => insertWhiteboard(supabase!, board)),
    updateWhiteboard: (board) => run(`whiteboard:${board.id}`, () => repoUpdateWhiteboard(supabase!, board)),
    upsertNode: (node) => writeAck(() => repoUpsertNode(supabase!, { ...node, roomId: boundRef.current! })),
    // tombstone（0021）：帶最後 ack 的 version 走 OCC — stale 即 conflict，
    // 由 writeAck 的既有衝突路徑接手（drop+refetch+誠實 toast）。
    deleteNode: (id, version) => writeAck(async () => {
      await repoSoftDeleteNode(supabase!, boundRef.current!, id, version);
      return true;
    }),
    createEdge: (edge) => run(`edge:${edge.id}`, () => insertEdge(supabase!, edge)),
    // frame 寫入的版本簿記（S6）：0023 的 touch trigger 會 bump version，
    // 但舊寫法丟棄回傳、App 端版本永遠停在 1 → 同一板的第二次寫入必被
    // stale-write 拒絕，且 run() 的重試 closure 捕捉的是同一份過期
    // payload，重放永遠失敗（佇列中毒）。改為：送出前查 latest（重試時
    // 自動用到已 ack 的版本），ack 後把 persisted 版本回報給呼叫端。
    upsertFrame: (frame, onPersisted, onConflict) => {
      frameLatest.current.set(frame.id, frame);
      run(`frame:${frame.id}`, async () => {
        const latest = frameLatest.current.get(frame.id) ?? frame;
        try {
          const persisted = await repoUpsertFrame(supabase!, { ...latest, roomId: boundRef.current! });
          frameLatest.current.set(persisted.id, persisted);
          onPersisted?.(persisted);
        } catch (error) {
          // stale-write：別人已存了較新版本。**不能進重試佇列** — 同一份
          // 過期 payload 重放永遠 409（節點路徑早就是這個紀律）。丟棄這次
          // 寫入、要求上層重讀，並誠實告訴使用者。
          if (isStaleWrite(error)) {
            frameLatest.current.delete(frame.id);
            onConflict?.();
            return;
          }
          throw error;
        }
      });
    },
    deleteFrame: (id) => run(`frame:${id}`, () => repoDeleteFrame(supabase!, boundRef.current!, id)),
    restoreNode: (node) =>
      run(`node:${node.id}`, () => repoRestoreDeletedNode(supabase!, boundRef.current!, node).then(() => undefined)),
    // op 入帳 best-effort：duplicate（重試）在 repository 折成成功；
    // 失敗只損 undo 粒度不損資料 — 不進佇列、不擋操作（ADR-014）。
    insertOperation: (op) => run(`op:${op.opId}`, () => repoInsertOperation(supabase!, { ...op, roomId: boundRef.current! })),
    createDecision: async (decision) => {
      const rid = boundRef.current;
      const key = `decision-insert:${decision.id}`;
      if (!supabase || !rid) return;
      setStatus("syncing");
      try {
        await repoInsertDecision(supabase, decision);
        pending.current = acknowledgePendingWrite(pending.current, key);
        setStatus(pending.current.length ? "offline-pending" : "synced");
      } catch (err) {
        if (isDuplicateKey(err)) {
          pending.current = acknowledgePendingWrite(pending.current, key);
          setStatus(pending.current.length ? "offline-pending" : "synced");
          return;
        }
        if (isDecisionNotSaved(err)) {
          setStatus(pending.current.length ? "offline-pending" : "synced");
          throw err;
        }
        pending.current = enqueuePendingWrite(pending.current, {
          key,
          task: () => repoInsertDecision(supabase, decision),
        });
        setStatus("offline-pending");
      }
    },
    updateDecision: (decision) => run(`decision:${decision.id}`, () => repoUpdateDecision(supabase!, decision)),
    setAllowBoardEdit: (allow) => run("allow-board-edit", () => repoSetAllowBoardEdit(supabase!, boundRef.current!, allow)),
    toggleSupport: (commentId, add) => run(`comment-support:${commentId}`, () => setSupport(supabase!, boundRef.current!, commentId, add)),
    insertReply: (reply) => run(`reply:${reply.id}`, () => repoInsertReply(supabase!, boundRef.current!, reply)),
    setProposalPref: (versionId, choice) => run(`pref:${versionId}`, () => setPreference(supabase!, boundRef.current!, versionId, choice)),
    archiveVersion: async (versionId) => {
      if (!supabase) return;
      await repoArchiveVersion(supabase, versionId);
      scheduleReload();
    },
    restoreVersion: async (versionId) => {
      if (!supabase) return;
      await repoRestoreVersion(supabase, versionId);
      scheduleReload();
    },
  };

  return {
    // ---- WB04 realtime ----
    presencePeople,
    /** frames 即時事件出口：App 掛一個 handler 進來。 */
    setFrameEventHandler: (handler: FrameEventHandler | null) => {
      onFrameEventRef.current = handler;
    },
    /** 重連/回前景的額外自癒（frames 不在 loadWhiteboardGraph 裡）。 */
    setReviveHandler: (handler: (() => void) | null) => {
      reviveExtraRef.current = handler;
    },
    /** 在場身分／所在板變了就重新 track（開關板時呼叫）。 */
    retrackPresence: (next: { name?: string }) => {
      if (next.name !== undefined) displayNameRef.current = next.name;
      const sub = unsubRef.current as unknown as { retrack?: () => void } | null;
      sub?.retrack?.();
    },
    status,
    online,
    inviteUrl,
    inviteInvalid,
    boundRoomId: boundRef.current,
    role,
    // A local-only room has no membership row and no server to ask; it belongs
    // to whoever is holding the phone, so it stays fully editable.
    canManageMedia: boundRef.current ? canManageMedia(role) : true,
    active: Boolean(supabase),
    ensureShared,
    ensureCloudRoom,
    forgetCloudRoom,
    loadBranch,
    loadWhiteboard,
    uploadVideo,
    refreshVideoUrl,
    retry,
    writes,
    preview,
    review,
    reviewApi,
    userId,
  };
}
