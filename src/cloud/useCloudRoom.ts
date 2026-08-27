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
import { isDuplicateKey, isInvalidInvite, isRevisionConflict } from "./errors";
import { buildInviteUrl, generateInviteToken, readRoomLink } from "./invite";
import { clearCloudMapping, getCloudMapping, saveCloudMapping } from "./mapping";
import {
  addVersion as repoAddVersion,
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
import {
  insertDecision,
  insertDiscussion,
  insertEdge,
  insertWhiteboard,
  loadWhiteboardGraph,
  setAllowBoardEdit as repoSetAllowBoardEdit,
  setDiscussionSupport as repoSetDiscussionSupport,
  updateDecision as repoUpdateDecision,
  updateWhiteboard as repoUpdateWhiteboard,
  upsertNode as repoUpsertNode,
  deleteNode as repoDeleteNode,
} from "./collaborationRepository";

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
  insertDiscussion?: (message: import("../features/collaboration/types").DiscussionMessage) => void;
  setDiscussionSupport?: (messageId: string, add: boolean) => void;
  createWhiteboard?: (board: import("../features/collaboration/types").Whiteboard) => void;
  updateWhiteboard?: (board: import("../features/collaboration/types").Whiteboard) => void;
  upsertNode?: (node: import("../features/collaboration/types").WhiteboardNode) => void;
  deleteNode?: (id: string) => void;
  createEdge?: (edge: import("../features/collaboration/types").WhiteboardEdge) => void;
  createDecision?: (decision: import("../features/collaboration/types").DecisionRecord) => void;
  updateDecision?: (decision: import("../features/collaboration/types").DecisionRecord) => void;
  setAllowBoardEdit?: (allow: boolean) => void;
  toggleSupport: (commentId: string, add: boolean) => void;
  insertReply: (reply: import("../lib/types").CommentReply) => void;
  setProposalPref: (versionId: string, choice: string) => void;
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

type Params = {
  guest: Guest | null;
  room: Room | null;
  activeBranchId?: string | null;
  isGuestSession: boolean;
  onSnapshot: (room: Room) => void;
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
function rememberCloudRoom(localRoomId: string, roomId: string, token: string): void {
  saveCloudMapping(localRoomId, { roomId, token });
  saveCloudMapping(roomId, { roomId, token });
}

/**
 * Binds the active room to the cloud when configured. Inert (returns
 * local-only) otherwise, so the local IndexedDB + PeerJS path is untouched.
 */
export function useCloudRoom({ guest, room, activeBranchId, isGuestSession, onSnapshot, showToast }: Params) {
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

  const boundRef = useRef<string | null>(null); // cloud room id
  const unsubRef = useRef<Unsubscribe | null>(null);
  const revisions = useRef<Map<string, number>>(new Map());
  const pending = useRef<Array<() => Promise<void>>>([]);
  const reloadTimer = useRef<number | null>(null);
  const roomRef = useRef<Room | null>(room);
  const activeBranchRef = useRef<string | null>(activeBranchId ?? null);
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
    for (const task of queue) {
      try {
        await task();
      } catch (err) {
        // The write already landed on a previous attempt: done, not an error.
        if (!isDuplicateKey(err)) pending.current.push(task);
      }
    }
    setStatus(pending.current.length ? "offline-pending" : "synced");
  }, []);

  /** Run a cloud write with optimistic UI already done; queue + degrade on failure. */
  const run = useCallback(
    (task: () => Promise<void>) => {
      if (!supabase || !boundRef.current) return;
      setStatus("syncing");
      task()
        .then(() => setStatus(pending.current.length ? "offline-pending" : "synced"))
        .catch((err) => {
          if (isDuplicateKey(err)) {
            setStatus(pending.current.length ? "offline-pending" : "synced");
            return;
          }
          pending.current.push(task);
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
    async (task: () => Promise<void>): Promise<void> => {
      if (!supabase || !boundRef.current) return;
      setStatus("syncing");
      try {
        await task();
        setStatus(pending.current.length ? "offline-pending" : "synced");
      } catch (err) {
        if (isDuplicateKey(err)) {
          setStatus(pending.current.length ? "offline-pending" : "synced");
          return;
        }
        pending.current.push(task);
        setStatus("offline-pending");
        throw err;
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
        setUserId(await ensureSession(supabase));
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
          run(async () => {
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
        unsubRef.current = subscribeRoom(supabase, targetRoomId, (await supabase.auth.getUser()).data.user?.id ?? "anon", {
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
          onPresence: setOnline,
          onStatus: (connected) => {
            if (connected) void flushPending();
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
      void flushPending();
      if (boundRef.current) void reload();
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
      void flushPending();
      void reload();
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
        run(async () => {
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
        boundRef.current = mapped.roomId;
        const url = buildInviteUrl(mapped.roomId, mapped.token);
        setInviteUrl(url);
        return { roomId: mapped.roomId, url };
      }
      setStatus("syncing");
      await ensureSession(supabase);
      const token = generateInviteToken();
      const { roomId } = await createRoom(supabase, { room: target, proposals: [] }, guest, token);
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
      onPhase: (phase: "preparing" | "uploading" | "processing", progress: number) => void,
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
    setTitle: (title) => run(() => setRoomTitle(supabase!, boundRef.current!, title)),
    insertComment: (pin) => run(() => insertComment(supabase!, boundRef.current!, pin)),
    setResolved: (id, resolved) => run(() => setCommentResolved(supabase!, id, resolved)),
    insertStroke: (stroke) => run(() => insertStroke(supabase!, boundRef.current!, stroke)),
    deleteStroke: (id) => run(() => repoDeleteStroke(supabase!, id)),
    insertMessage: (msg) => run(() => insertMessage(supabase!, boundRef.current!, msg)),
    addVersion: (label, sortOrder, imageDataUrl, branchId) =>
      run(async () => {
        const v: Version = await repoAddVersion(supabase!, boundRef.current!, label, sortOrder, imageDataUrl, branchId);
        void v;
        scheduleReload();
      }),
    createBranch: (branch) => runAndWait(() => insertBranch(supabase!, branch)),
    updateBranch: (branchId, patch) => run(() => updateBranch(supabase!, boundRef.current!, branchId, patch)),
    savePlan: (plan) => run(() => upsertPlan(supabase!, plan, boundRef.current!)),
    createRelation: (relation) => run(() => insertRelation(supabase!, relation)),
    deleteRelation: (relationId) => run(() => deleteRelation(supabase!, boundRef.current!, relationId)),
    createPoll: (poll) => run(() => insertPoll(supabase!, poll)),
    votePoll: (vote) => run(() => votePoll(supabase!, vote)),
    insertDiscussion: (message) => run(() => insertDiscussion(supabase!, message)),
    setDiscussionSupport: (messageId, add) => run(() => repoSetDiscussionSupport(supabase!, boundRef.current!, messageId, add)),
    createWhiteboard: (board) => run(() => insertWhiteboard(supabase!, board)),
    updateWhiteboard: (board) => run(() => repoUpdateWhiteboard(supabase!, board)),
    upsertNode: (node) => run(() => repoUpsertNode(supabase!, node)),
    deleteNode: (id) => run(() => repoDeleteNode(supabase!, boundRef.current!, id)),
    createEdge: (edge) => run(() => insertEdge(supabase!, edge)),
    createDecision: (decision) => run(() => insertDecision(supabase!, decision)),
    updateDecision: (decision) => run(() => repoUpdateDecision(supabase!, decision)),
    setAllowBoardEdit: (allow) => run(() => repoSetAllowBoardEdit(supabase!, boundRef.current!, allow)),
    toggleSupport: (commentId, add) => run(() => setSupport(supabase!, boundRef.current!, commentId, add)),
    insertReply: (reply) => run(() => repoInsertReply(supabase!, boundRef.current!, reply)),
    setProposalPref: (versionId, choice) => run(() => setPreference(supabase!, boundRef.current!, versionId, choice)),
  };

  return {
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
