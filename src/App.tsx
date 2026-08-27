import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLORS,
  VERSION_LABELS,
  VIDEO_VERSION_LABELS,
  roomMediaType,
  type AnnotationRegion,
  type BranchStatus,
  type BranchType,
  type ChatMessage,
  type CommentPin,
  type CommentReply,
  type Guest,
  type Point,
  type Room,
  type Stroke,
  type ReviewType,
  type VideoCategory,
  type MediaType,
  type PlanDocument,
  type ContentRelation,
  type PollVote,
  type RoomBranch,
  type RoomPoll,
  type Tool,
  type Version,
  type VideoAnchor,
  type ViewState,
} from "./lib/types";
import { regionCenter } from "./lib/region";
import { branchForId, branchSummaryFor, branchVersions, normalizeRoomBranches, roomForBranch } from "./lib/roomBranches";
import { roomCode, uid } from "./lib/id";
import { deleteRoom, listRooms, loadFlag, loadGuest, loadRoom, saveFlag, saveGuest, saveRoom } from "./lib/store";
import { Collab, type CollabStatus } from "./lib/peer";
import { isCloudConfigured } from "./cloud/config";
import { getSupabase } from "./cloud/client";
import { attachmentExt, attachmentPath, signedUrl, uploadAttachment } from "./cloud/assets";
import {
  askRoomContext,
  enqueueAssetAnalysis,
  listIntelligentAssets,
  retryAssetAnalysis,
  setAssetAiPolicy,
  setHumanAssetMetadata,
  subscribeAssetAnalysis,
  type AssetIntelligenceSnapshot,
} from "./cloud/assetIntelligence";
import { addRoomTarget, readRoomLink } from "./cloud/invite";
import { type SyncStatus } from "./cloud/types";
import { useCloudRoom } from "./cloud/useCloudRoom";
import { buildPreviewShareUrl, previewThumbnailUrl, type SharePreview } from "./cloud/sharePreview";
import { ToastStack, useToasts } from "./toast";
import { useIsMobile } from "./hooks/useIsMobile";
import { RoomWorkspace } from "./components/RoomWorkspace";
import { Home } from "./components/Home";
import { INTAKE_PROFILES, UniversalIntake } from "./components/UniversalIntake";
import { ShareSheet, type ShareCard, type ShareCustomization, type ShareState } from "./components/ShareSheet";
import { sharePresentation } from "./lib/sharePresentation";
import {
  nextPinNumber,
  pinNumber,
  type PinDraft,
  type PinForm,
  type SaveState,
  type VideoApi,
  type VideoUploadState,
  type WorkspaceApi,
} from "./components/api";
import { VIDEO_ACCEPT, acceptVideoFile } from "./features/video-review/media";
import { anchorLabel, anchorStart } from "./features/video-review/anchors";
import { isUploadCancelled } from "./cloud/videoRoom";
import { MultiBranchRoom, type MultiBranchRoomApi } from "./features/multi-room/MultiBranchRoom";
import { AssetAiFab, RoomAiSheet } from "./features/asset-intelligence/RoomAiSheet";
import type { ContextCitation, RoomContextFocus, RoomContextRequest, RoomContextResponse } from "./lib/assetIntelligence";
import type { DiscussionMessage, Whiteboard, WhiteboardEdge, WhiteboardNode } from "./features/collaboration/types";
import { discussionPayloadFromNode, stickyFromDiscussion } from "./features/collaboration/links";
import { useDiscussionOutbox } from "./hooks/useDiscussionOutbox";
import { DiscussionDrawer } from "./features/room-discussion/DiscussionDrawer";
import { adoptPersistedNode, stampPersistedNode } from "./features/collaboration/nodes";
import {
  applyGate,
  applyReasonMessage,
  commentBodyFromAction,
  nodeFromAddWhiteboardAction,
  planDraftTitle,
  pollFromAction,
  type AiProposal,
  type ApplyProposalResult,
} from "./ai/proposals";
import { collectBoardEditors, stampWriter } from "./features/collaboration/presence";
import {
  applyPendingCloudWrites,
  clearPendingEdit,
  clearPendingEditIf,
  decideNodeWriteRetry,
  isBrowserOnline,
  isCloudWriteAcknowledged,
  listPendingEdits,
  loadBoardSnapshot,
  queuePendingEdit,
  reconcileNodes,
  saveBoardSnapshot,
} from "./features/collaboration/offline";
import "./usability.css";
import "./features/whiteboard/whiteboard.css";
import "./features/room-discussion/discussion.css";

const EMPTY_FORM: PinForm = { body: "", suggestion: "", type: "文字", priority: "一般" };
const COACH_FLAG = "coach.firstPin";
const UNDO_LIMIT = 20;

function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

/** Distinguishes "the user cancelled" from a genuine upload failure. */
class CancelledUpload extends Error {}

/**
 * What to actually show someone when an upload fails.
 *
 * Backend text — PostgREST, Storage, Postgres constraint names, RLS wording —
 * is English, leaks schema details and never says what to do next, so it is not
 * copy. The messages this app authors are Traditional Chinese, and that is the
 * test: anything without a Han character came from a machine, not from us.
 */
function userFacingMessage(err: unknown): string {
  const fallback = "影片上傳失敗，請檢查網路後再試一次。";
  const raw = err instanceof Error ? err.message : "";
  if (!raw || raw === "cloud-room-failed") return fallback;
  if (!/[一-鿿]/.test(raw)) {
    // Keep the real reason where a developer can find it; show a sentence the
    // person can act on.
    console.warn("[video] upload failed:", raw);
    return fallback;
  }
  return raw;
}

/**
 * Building a card involves a signed read, a canvas render and an upload. Most of
 * the time that is a second or two — but sharing must not hang on it forever, so
 * a slow build converts into the honest "no thumbnail this time" path instead of
 * an endless 準備中. A late result still wins if it arrives: the sequence guard
 * is what decides, not this timer.
 */
const PREVIEW_BUILD_TIMEOUT_MS = 6000;

function emptyRoom(id: string, title: string, mediaType: MediaType = "image"): Room {
  return {
    id,
    title,
    mediaType,
    versions: [],
    comments: [],
    strokes: [],
    messages: [],
    updatedAt: Date.now(),
  };
}

function initialView(room: Room | null): ViewState {
  const first = room?.versions[0]?.id ?? "";
  const second = room?.versions[1]?.id ?? first;
  return { versionId: first, compareId: second, colorMode: "color", compareMode: "single", split: 0.5, wipe: 0.5 };
}

/** Map cloud sync state onto the small presence dot the mobile UI already shows. */
function syncToPresence(status: SyncStatus): CollabStatus | null {
  if (status === "synced") return "online";
  if (status === "connecting" || status === "syncing") return "connecting";
  if (status === "offline-pending" || status === "error") return "error";
  return null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function App() {
  const [guest, setGuest] = useState<Guest | null>(() => loadGuest());
  const [nameInput, setNameInput] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  /** Project rooms stay at the room shell until a poster/video branch opens. */
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [activeWhiteboardId, setActiveWhiteboardId] = useState<string | null>(null);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [openAtSeconds, setOpenAtSeconds] = useState<number | undefined>(undefined);
  const [loadingBranchId, setLoadingBranchId] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(() => initialView(null));
  const [tool, setTool] = useState<Tool>("pan");
  const [recent, setRecent] = useState<Room[]>([]);
  const [draftPin, setDraftPin] = useState<PinDraft | null>(null);
  const [form, setFormState] = useState<PinForm>(EMPTY_FORM);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [previewStrokeId, setPreviewStrokeId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [collabStatus, setCollabStatus] = useState<CollabStatus | null>(null);
  const [peerCount, setPeerCount] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [coachSeen, setCoachSeen] = useState<boolean>(() => loadFlag(COACH_FLAG));
  const [undoCount, setUndoCount] = useState(0);
  const [videoUpload, setVideoUpload] = useState<VideoUploadState>({ state: "idle" });
  const [assetIntelligence, setAssetIntelligence] = useState<AssetIntelligenceSnapshot | null>(null);
  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  const [aiSelectedAssetIds, setAiSelectedAssetIds] = useState<string[]>([]);
  const [aiResponse, setAiResponse] = useState<RoomContextResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiFocus, setAiFocus] = useState<RoomContextFocus | null>(null);
  /** Cancels an upload in flight. Held in a ref so leaving the room can call it. */
  const videoCancelRef = useRef<(() => void) | null>(null);

  const { toasts, showToast, dismiss } = useToasts();
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const collabRef = useRef<Collab | null>(null);
  const roomRef = useRef<Room | null>(null);
  const lastAckedNodeVersion = useRef(new Map<string, number>());
  const nodePersistChain = useRef(new Map<string, Promise<void>>());
  const appliedAiProposalIds = useRef(new Set<string>());
  const viewRef = useRef<ViewState>(view);
  const saveSeq = useRef(0);
  const busy = useRef<Set<string>>(new Set());
  const offlineNotified = useRef(false);
  const undoStack = useRef<Room[]>([]);
  roomRef.current = room;
  viewRef.current = view;

  /**
   * How this tab was opened. Read once: `main.tsx` has already upgraded a
   * legacy owner link to its cloud invite URL before the first render.
   */
  const roomLink = useMemo(() => readRoomLink(), []);
  const isGuestSession = roomLink.kind !== "none";
  /** An old `#room=<6碼>` link this device cannot upgrade (a partner's phone). */
  const isLegacyLink = roomLink.kind === "legacy";
  /** Cloud drives this session; a legacy link can only ride the peer channel. */
  const cloudSession = isCloudConfigured && !isLegacyLink;

  const markCoachSeen = useCallback(() => {
    setCoachSeen((seen) => {
      if (!seen) saveFlag(COACH_FLAG);
      return true;
    });
  }, []);

  const clearUndo = useCallback(() => {
    undoStack.current = [];
    setUndoCount(0);
  }, []);

  const pushUndo = useCallback((snapshot: Room) => {
    undoStack.current.push(snapshot);
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  }, []);

  /**
   * Guards against a double tap producing two entries. The key carries the
   * payload's identity, so a genuinely different pin or message right after is
   * never swallowed — only a repeat of the same one is.
   */
  const claim = useCallback((key: string, ms = 450) => {
    if (busy.current.has(key)) return false;
    busy.current.add(key);
    window.setTimeout(() => busy.current.delete(key), ms);
    return true;
  }, []);

  const trackSave = useCallback(
    (next: Room) => {
      const seq = ++saveSeq.current;
      setSaveState("saving");
      saveRoom(next)
        .then(() => {
          if (seq === saveSeq.current) setSaveState("saved");
        })
        .catch(() => {
          if (seq !== saveSeq.current) return;
          setSaveState("error");
          showToast("儲存失敗，請再試一次", {
            tone: "error",
            action: { label: "重試", onClick: () => trackSave(roomRef.current ?? next) },
          });
        });
    },
    [showToast],
  );

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = window.setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
    return () => clearTimeout(timer);
  }, [saveState]);

  useEffect(() => {
    listRooms().then(setRecent).catch(() => setRecent([]));
  }, [room]);

  const roomLinkAppliedRef = useRef(false);
  // outbox 對帳只能看「伺服器快照裡有哪些討論訊息」。room.discussion 混著
  // 樂觀 append 的列，拿它當 serverIds 會在送出瞬間把 entry 誤判為已落地。
  const [serverDiscussionIds, setServerDiscussionIds] = useState<ReadonlySet<string>>(() => new Set());
  const applyRemoteRoom = useCallback((next: Room) => {
    const normalized = normalizeRoomBranches(next);
    setServerDiscussionIds(new Set((normalized.discussion ?? []).map((message) => message.id)));
    setRoom((current) => {
      const incomingNodes = normalized.whiteboardNodes ?? [];
      const currentNodes = current?.whiteboardNodes ?? [];
      const incomingEdges = normalized.whiteboardEdges ?? [];
      const currentEdges = current?.whiteboardEdges ?? [];
      const whiteboardNodes = incomingNodes.length === 0 && currentNodes.length
        ? currentNodes
        : incomingNodes.length && currentNodes.length
          ? reconcileNodes(currentNodes, incomingNodes, [])
          : incomingNodes.length
            ? incomingNodes
            : currentNodes;
      const whiteboardEdges = incomingEdges.length === 0 && currentEdges.length
        ? currentEdges
        : incomingEdges.length
          ? incomingEdges
          : currentEdges;
      for (const node of whiteboardNodes) {
        const incoming = node.version ?? 1;
        const known = lastAckedNodeVersion.current.get(node.id) ?? 0;
        if (incoming > known) lastAckedNodeVersion.current.set(node.id, incoming);
      }
      // Summary 路徑的 plan_documents 刻意不帶 blocks（lazy）；那種「空殼
      // plan」不可以蓋掉本地已經有內容的版本，否則編輯中的段落會被
      // realtime 快照吃掉。只有帶著內容、或者確實比較新的完整版本才接受。
      const plans = (normalized.plans ?? []).map((incoming) => {
        const existing = current?.plans?.find((plan) => plan.branchId === incoming.branchId);
        if (!existing) return incoming;
        // summary lazy 列（blocksOmitted）永遠不覆蓋有內容的版本；
        // 完整列（含真的被清空的空陣列）走 updatedAt 比新。
        if (incoming.blocksOmitted && existing.blocks.length) return existing;
        return incoming.updatedAt >= existing.updatedAt ? incoming : existing;
      });
      return {
        ...normalized,
        plans,
        whiteboardNodes,
        whiteboardEdges,
        // 專案房不可被快照「降級」：loadRoomFull 的 projectMode 推斷在
        // room_mode PATCH 還沒落地、又只有一個分支時會誤判 single，
        // 那會讓房間殼整個掉出去換成單房對稿樹。
        projectMode: normalized.projectMode || current?.projectMode,
      };
    });
    // 深連結只套用一次 — 但只有「目標真的存在於這份快照」才算消耗：
    // cache-first 的舊快照可能還沒有那個 branch，不該把 one-shot 吃掉
    //（Grok pr01a F6）。套用後不再重套，返回的人不會被 reload 推回去。
    const applyLink = !roomLinkAppliedRef.current;
    if (applyLink && roomLink.kind === "cloud") {
      const wantsBranch = Boolean(roomLink.branchId);
      const branchReady = wantsBranch && Boolean(normalized.branches?.some((branch) => branch.id === roomLink.branchId));
      if (branchReady) setActiveBranchId(roomLink.branchId!);
      if (roomLink.whiteboardId) {
        setActiveWhiteboardId(roomLink.whiteboardId);
        setFocusNodeId(roomLink.nodeId ?? null);
      }
      // branch 目標還沒出現 → 不消耗，等下一份快照；其他情況消耗。
      if (!wantsBranch || branchReady) roomLinkAppliedRef.current = true;
    }
    setView((v) => {
      const ids = normalized.versions.map((x) => x.id);
      const requestedVersionId = applyLink && roomLink.kind === "cloud" ? roomLink.versionId : undefined;
      const versionId = requestedVersionId && ids.includes(requestedVersionId)
        ? requestedVersionId
        : ids.includes(v.versionId)
          ? v.versionId
          : ids[0] ?? "";
      const compareId = ids.includes(v.compareId) ? v.compareId : versionId;
      return { ...v, versionId, compareId };
    });
  }, [roomLink]);

  // Cloud persistence (only active when VITE_SUPABASE_* are set). Inert in
  // local-only mode, so the IndexedDB + PeerJS path below is unchanged.
  const cloud = useCloudRoom({ guest, room, activeBranchId, isGuestSession, onSnapshot: applyRemoteRoom, showToast });
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;

  // 討論送出狀態機：失敗可見可重試、快照替換後樂觀列不消失、綁定前先扣住。
  const discussionOutbox = useDiscussionOutbox({
    insert: cloud.writes.insertDiscussion,
    bound: Boolean(cloud.boundRoomId),
    boundRoomId: cloud.boundRoomId ?? null,
    localRoomId: room?.id ?? null,
    serverIds: serverDiscussionIds,
  });
  const discussionOutboxRef = useRef(discussionOutbox);
  discussionOutboxRef.current = discussionOutbox;

  // Intelligence is a separate, bounded slice. It never gates the existing
  // room/review load, and a branch workspace only asks for that branch's
  // metadata. Binary media continues to come from the existing review paths.
  useEffect(() => {
    const supabase = getSupabase();
    if (!room || !cloud.boundRoomId || !supabase) {
      setAssetIntelligence(null);
      return;
    }
    let cancelled = false;
    const branchId = activeBranchId ?? undefined;
    void listIntelligentAssets(supabase, room.id, {
      branchId,
      branches: room.branches,
      versions: room.versions,
      limit: branchId ? 80 : 160,
    })
      .then((snapshot) => {
        if (cancelled) return;
        setAssetIntelligence(snapshot);
        // The database trigger is the durable queue; this small kick starts
        // only a few bounded jobs when a room/branch is opened. It never
        // downloads media into the room page and repeated kicks are idempotent
        // because the edge function reuses the queued job.
        void Promise.allSettled(
          snapshot.jobs
            .filter((job) => job.status === "queued")
            .slice(0, 3)
            .map((job) => enqueueAssetAnalysis(supabase, job.assetId, job.tier)),
        );
      })
      .catch((error) => {
        // A mixed-version deployment may not have migration 0014 yet. The
        // review room remains fully usable; only the optional AI surface stays
        // empty until the migration/functions are deployed.
        if (!cancelled) {
          setAssetIntelligence({ assets: [], jobs: [], relations: [] });
          console.warn("[asset-intelligence] unavailable:", error instanceof Error ? error.message : error);
        }
      });
    const unsubscribe = subscribeAssetAnalysis(supabase, room.id, ({ assetId, status, progress }) => {
      setAssetIntelligence((current) => {
        if (!current) return current;
        return {
          ...current,
          assets: current.assets.map((asset) => asset.id === assetId ? { ...asset, status } : asset),
          jobs: current.jobs.map((job) => {
            if (job.assetId !== assetId) return job;
            const jobStatus = status === "processing" ? "processing" : status === "failed" ? "failed" : status === "ready" || status === "partial" ? "completed" : job.status;
            return { ...job, status: jobStatus, progress: progress ?? (jobStatus === "completed" ? 100 : job.progress) };
          }),
        };
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activeBranchId, cloud.boundRoomId, room?.branches, room?.id, room?.versions]);

  const openAi = useCallback((assetId?: string) => {
    setAiSelectedAssetIds(assetId ? [assetId] : []);
    setAiResponse(null);
    setAiError(null);
    setAiSheetOpen(true);
  }, []);

  const focusAi = useCallback((focus: RoomContextFocus) => {
    const current = roomRef.current;
    if (!current) return;
    setAiFocus(focus);
    setAiSheetOpen(false);
    const branch = focus.branchId ? branchForId(current, focus.branchId) : undefined;
    if (branch) setActiveBranchId(branch.id);
    const applyVersion = () => {
      if (!focus.versionId) return;
      setView((previous) => ({ ...previous, versionId: focus.versionId!, compareMode: "single" }));
    };
    if (branch && (branch.branchType === "poster" || branch.branchType === "video") && cloudRef.current.boundRoomId) {
      setLoadingBranchId(branch.id);
      void cloudRef.current.loadBranch(branch.id).finally(() => {
        setLoadingBranchId((value) => (value === branch.id ? null : value));
        applyVersion();
      });
    } else {
      applyVersion();
    }
  }, []);

  const askAi = useCallback(async (request: RoomContextRequest): Promise<RoomContextResponse> => {
    const current = roomRef.current;
    const supabase = getSupabase();
    if (!current || !supabase || !cloudRef.current.boundRoomId) {
      const error = new Error("房間 AI 尚未連線，請先完成雲端房間設定。");
      setAiError(error.message);
      throw error;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const response = await askRoomContext(
        supabase,
        current.id,
        request,
        // Policy and updatedAt are part of the cache identity too. A cached
        // answer must not survive an owner turning an asset's AI readability
        // off, even when the analysis model/version itself did not change.
        (assetIntelligence?.assets ?? []).map((asset) => `${asset.id}:${asset.analysisVersion}:${asset.updatedAt}:${asset.aiReadable}:${asset.externalAiAllowed}`),
      );
      setAiResponse(response);
      return response;
    } catch (error) {
      const message = error instanceof Error && /外部|permission|blocked/i.test(error.message)
        ? "這次提問包含禁止送到外部 AI 的素材。"
        : "房間 AI 暫時沒有回應，請稍後再試。";
      setAiError(message);
      throw error;
    } finally {
      setAiLoading(false);
    }
  }, [assetIntelligence?.assets]);

  const retryAi = useCallback((assetId: string) => {
    const supabase = getSupabase();
    if (!supabase || !cloudRef.current.canManageMedia) return;
    void retryAssetAnalysis(supabase, assetId).then(() => showToast("已重新排入素材理解", { tone: "success" })).catch(() => showToast("目前無法重新分析，請稍後再試", { tone: "error" }));
  }, [showToast]);

  const updateAiPolicy = useCallback(async (assetId: string, patch: { aiReadable: boolean; externalAiAllowed: boolean }) => {
    const supabase = getSupabase();
    if (!supabase || !cloudRef.current.canManageMedia) throw new Error("沒有修改素材 AI 權限的權限");
    await setAssetAiPolicy(supabase, { assetId, ...patch });
    const updatedAt = new Date().toISOString();
    setAssetIntelligence((current) => current ? {
      ...current,
      assets: current.assets.map((asset) => asset.id === assetId
        ? { ...asset, updatedAt, aiReadable: patch.aiReadable, externalAiAllowed: patch.aiReadable ? patch.externalAiAllowed : false }
        : asset),
    } : current);
    showToast(patch.aiReadable ? "已開啟素材 AI 理解" : "已關閉素材 AI 理解", { tone: "success" });
  }, [showToast]);

  const updateHumanMetadata = useCallback(async (assetId: string, input: { title?: string; summary?: string; tags?: string[] }) => {
    const supabase = getSupabase();
    const current = assetIntelligence?.assets.find((asset) => asset.id === assetId);
    if (!supabase || !cloudRef.current.canManageMedia || !current) throw new Error("沒有修改素材標記的權限");
    await setHumanAssetMetadata(supabase, { assetId, roomId: current.roomId, ...input });
    const updatedAt = new Date().toISOString();
    setAssetIntelligence((snapshot) => snapshot ? {
      ...snapshot,
      assets: snapshot.assets.map((asset) => asset.id === assetId ? {
        ...asset,
        human: {
          assetId,
          title: input.title?.trim() || undefined,
          summary: input.summary?.trim() || undefined,
          tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 30),
          structuredData: asset.human?.structuredData ?? {},
          updatedAt,
        },
      } : asset),
    } : snapshot);
    showToast("已保存人工素材標記", { tone: "success" });
  }, [assetIntelligence?.assets, showToast]);

  // A branch/version deep-link can select the branch while the first cloud
  // snapshot is still being reduced to a summary. Hydrate that target just as
  // a tap would, but only when the summary says there is detail to fetch.
  useEffect(() => {
    if (!room || !activeBranchId || !cloud.boundRoomId || loadingBranchId) return;
    const branch = branchForId(room, activeBranchId);
    if (!branch || (branch.branchType !== "poster" && branch.branchType !== "video")) return;
    if (branchVersions(room, activeBranchId).length || branchSummaryFor(room, activeBranchId)?.versionCount === 0) return;
    setLoadingBranchId(activeBranchId);
    void cloud.loadBranch(activeBranchId).finally(() => {
      setLoadingBranchId((current) => (current === activeBranchId ? null : current));
    });
  }, [activeBranchId, cloud.boundRoomId, cloud.loadBranch, loadingBranchId, room]);

  // Cache-first load for cloud guests: a room seen before renders instantly
  // from IndexedDB while auth + join + the fresh cloud snapshot catch up.
  useEffect(() => {
    if (!guest || !isCloudConfigured || roomLink.kind !== "cloud") return;
    loadRoom(roomLink.roomId).then((cached) => {
      if (cached && !roomRef.current) applyRemoteRoom(cached);
    });
  }, [guest, roomLink, applyRemoteRoom]);

  useEffect(() => {
    if (!guest) return;
    // Cloud is the source of truth when configured; PeerJS stays for local
    // mode and for legacy #room=<code> links that carry no invite token.
    if (isCloudConfigured && roomLink.kind === "cloud") return;
    const code = roomLink.kind === "none" ? null : roomLink.roomId;
    if (!code) return;

    loadRoom(code).then((existing) => {
      if (existing) applyRemoteRoom(existing);
    });

    const collab = new Collab("guest", code, {
      onStatus: (status) => {
        setCollabStatus(status);
        setPeerCount(collab.peerCount);
        if ((status === "error" || status === "closed") && !offlineNotified.current) {
          offlineNotified.current = true;
          showToast("目前離線，內容已保存在這台裝置。");
        }
        if (status === "online") offlineNotified.current = false;
      },
      onMessage: (msg) => {
        if (msg.t === "snapshot") {
          applyRemoteRoom(msg.room);
          setView(msg.view);
          saveRoom(msg.room).catch(() => undefined);
        } else if (msg.t === "room") {
          applyRemoteRoom(msg.room);
          saveRoom(msg.room).catch(() => undefined);
        } else if (msg.t === "view") {
          setView(msg.view);
        }
      },
      onOpenConn: (conn) => collab.sendTo(conn, { t: "hello", guest }),
    });
    collab.connect();
    collabRef.current = collab;
    return () => {
      collab.destroy();
      collabRef.current = null;
    };
  }, [guest, roomLink, applyRemoteRoom, showToast]);

  const persist = useCallback(
    (next: Room) => {
      trackSave(next);
      collabRef.current?.send({ t: "room", room: next });
    },
    [trackSave],
  );

  const updateRoom = useCallback(
    (mutate: (r: Room) => Room) => {
      setRoom((prev) => {
        if (!prev) return prev;
        const next = { ...mutate(prev), updatedAt: Date.now() };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const undoLast = useCallback(() => {
    const previous = undoStack.current.pop();
    setUndoCount(undoStack.current.length);
    if (!previous) {
      showToast("沒有可以復原的操作");
      return;
    }
    setRoom(previous);
    persist(previous);
    setSelectedPinId(null);
    setDraftPin(null);
    showToast("已復原", { tone: "success" });
  }, [persist, showToast]);

  /** Apply a change and offer a few-second Undo; history also remains in More. */
  const mutateWithUndo = useCallback(
    (mutate: (r: Room) => Room, toastMessage: string) => {
      const snapshot = roomRef.current;
      if (!snapshot) return;
      pushUndo(snapshot);
      const next = { ...mutate(snapshot), updatedAt: Date.now() };
      setRoom(next);
      persist(next);
      showToast(toastMessage, {
        action: { label: "復原", onClick: undoLast },
      });
    },
    [persist, pushUndo, showToast, undoLast],
  );

  const updateView = useCallback((next: ViewState) => {
    setView(next);
    collabRef.current?.send({ t: "view", view: next });
  }, []);

  const confirmName = () => {
    const name = nameInput.trim();
    if (!name) return;
    const g: Guest = { id: uid("g_"), name, color: pickColor() };
    saveGuest(g);
    setGuest(g);
  };

  const openRoom = useCallback(
    (r: Room) => {
      clearUndo();
      // An upload state belongs to the room it was started in; carrying it over
      // would show another room a red banner about something that never
      // happened there.
      setVideoUpload({ state: "idle" });
      const normalized = normalizeRoomBranches(r);
      setActiveBranchId(null);
      setLoadingBranchId(null);
      setRoom(normalized);
      setView(initialView(normalized));
    },
    [clearUndo],
  );

  const createProjectRoom = useCallback(() => {
    const next: Room = {
      ...emptyRoom(roomCode(), "未命名活動房"),
      projectMode: true,
      branches: [],
      plans: [],
      relations: [],
      polls: [],
      pollVotes: [],
    };
    clearUndo();
    setActiveBranchId(null);
    setLoadingBranchId(null);
    setRoom(next);
    setView(initialView(next));
    trackSave(next);
    // A project room is a cloud collaboration surface from the moment it is
    // created.  This also lets the Asset Intelligence slice start its bounded
    // metadata load before the first branch is added; binary media still stays
    // lazy in the existing review workspaces.
    if (isCloudConfigured) {
      void cloudRef.current.ensureCloudRoom(next).catch(() => {
        showToast("活動房雲端建立失敗，請確認連線後再試一次。", { tone: "error" });
      });
    }
  }, [clearUndo, showToast, trackSave]);

  const addImageFiles = useCallback(
    async (files: FileList | null, forcedBranchId?: string, roomOverride?: Room) => {
      if (!files || files.length === 0) return;
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者可以留言與投票，但不能建立文宣版本。", { tone: "error" });
        return;
      }
      if (busy.current.has("upload")) return;
      busy.current.add("upload");
      try {
        const current = roomOverride ?? roomRef.current ?? emptyRoom(roomCode(), "未命名文宣");
        const created = !roomOverride && !roomRef.current;
        const targetBranchId = forcedBranchId ?? activeBranchId ?? (current.branches?.length === 1 ? current.branches[0].id : undefined);
        const branchCount = targetBranchId ? branchVersions(current, targetBranchId).length : current.versions.length;
        const newVersions: Version[] = [];
        for (const file of Array.from(files)) {
          if (!file.type.startsWith("image/")) continue;
          const dataUrl = await fileToDataUrl(file);
          const idx = branchCount + newVersions.length;
          newVersions.push({ id: uid("v_"), label: VERSION_LABELS[idx] ?? `改${idx}`, imageDataUrl: dataUrl, ...(targetBranchId ? { branchId: targetBranchId } : {}) });
        }
        if (newVersions.length === 0) {
          showToast("這個檔案不是圖片，換一張文宣試試。", { tone: "error" });
          return;
        }
        if (!created) pushUndo(current);
        const next: Room = normalizeRoomBranches({ ...current, versions: [...current.versions, ...newVersions], updatedAt: Date.now() });
        setRoom(next);
        setView((v) => {
          const viewRoom = targetBranchId ? roomForBranch(next, targetBranchId) : next;
          if (created || !v.versionId) return initialView(viewRoom);
          if (v.compareId === v.versionId && viewRoom.versions.length >= 2) {
            const other = viewRoom.versions.find((x) => x.id !== v.versionId);
            if (other) return { ...v, compareId: other.id };
          }
          return v;
        });
        persist(next);
        newVersions.forEach((v, i) =>
          cloudRef.current.writes.addVersion(v.label, branchCount + i, v.imageDataUrl, targetBranchId),
        );
        const added = newVersions[newVersions.length - 1];
        if (!created) {
          showToast(newVersions.length > 1 ? `已新增 ${newVersions.length} 版` : `已新增${added.label}`, {
            tone: "success",
            action: { label: "復原", onClick: undoLast },
          });
        }
      } finally {
        busy.current.delete("upload");
      }
    },
    [activeBranchId, cloud.boundRoomId, cloud.canManageMedia, persist, pushUndo, showToast, undoLast],
  );

  /**
   * Add one cut to a video room, creating the room in the cloud first if this is
   * the first one.
   *
   * A poster room can live entirely on this device until someone taps 分享. A
   * video room cannot: Storage authorises an upload against `rooms/<room-id>/…`
   * and room membership, so the room has to exist in the cloud before the first
   * byte moves — which is also what makes the share link work after the host
   * closes the page, the whole point of the feature.
   */
  const addVideoFile = useCallback(
    async (files: FileList | null, forcedBranchId?: string, roomOverride?: Room) => {
      const file = files?.[0];
      if (!file) return;
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者可以留言與投票，但不能建立影片版本。", { tone: "error" });
        return;
      }
      if (busy.current.has("upload")) return;

      const check = acceptVideoFile(file);
      if (!check.ok) {
        showToast(check.reason, { tone: "error" });
        return;
      }
      if (!isCloudConfigured) {
        showToast("影片對稿需要雲端設定，這台裝置目前是本機模式。", { tone: "error" });
        return;
      }

      // A guest whose join is still in flight has no bound room yet. Uploading
      // would fall through to "create a room", which for a room that already
      // holds a cut is refused with a sentence about migration — true, and
      // completely beside the point for the person waiting three seconds.
      if (isGuestSession && !cloudRef.current.boundRoomId && (roomRef.current?.versions.length ?? 0) > 0) {
        showToast("還在連線，等一下再試一次。");
        return;
      }

      busy.current.add("upload");
      const existing = roomOverride ?? roomRef.current;
      const isNewRoom = !existing;
      const base = existing ?? emptyRoom(roomCode(), "未命名影片", "video");
      const targetBranchId = forcedBranchId ?? activeBranchId ?? (base.branches?.length === 1 ? base.branches[0].id : undefined);
      const branchCount = targetBranchId ? branchVersions(base, targetBranchId).length : base.versions.length;
      if (isNewRoom) {
        setRoom(base);
        setView(initialView(base));
      }

      const versionId = crypto.randomUUID();
      const index = branchCount;
      const label = VIDEO_VERSION_LABELS[index] ?? `改${index}`;
      // Cancelling has to work from the first frame, not only once the XHR
      // exists: the cloud room is created first, and that takes a moment on a
      // slow connection.
      let abandoned = false;
      // Both ids the room may answer to while this upload is in flight; the
      // cloud id joins once the room exists (binding re-keys the room to it).
      const belongsToThisUpload = new Set([base.id]);
      let handleCancel: (() => void) | null = null;
      const cancel = () => {
        abandoned = true;
        handleCancel?.();
      };
      videoCancelRef.current = cancel;
      setVideoUpload({ state: "preparing", progress: 0, cancel });

      try {
        const cloudRoom = await cloudRef.current.ensureCloudRoom(base);
        if (!cloudRoom) throw new Error("cloud-room-failed");
        if (abandoned) throw new CancelledUpload();
        // Binding to the cloud swaps the room's identity from the local code to
        // the cloud UUID (the snapshot that lands next IS the room). Both ids
        // therefore mean "still the room this upload belongs to".
        belongsToThisUpload.add(cloudRoom.roomId);

        const handle = cloudRef.current.uploadVideo(
          {
            roomId: cloudRoom.roomId,
            versionId,
            label,
            sortOrder: index,
            branchId: targetBranchId,
            file: check.file,
            mime: check.mime,
            roomTitle: base.title,
          },
          (phase, progress) => setVideoUpload({ state: phase, progress, cancel }),
        );
        if (!handle) throw new Error("cloud-room-failed");
        handleCancel = handle.cancel;

        const version = await handle.done;
        setVideoUpload({ state: "idle" });
        if (abandoned) {
          // Cancelled while the row was being written: the cut is in the cloud
          // and will be there next time, but the person is already somewhere
          // else and must not be dragged into a room they walked away from.
          showToast("已取消上傳");
          return;
        }

        // The user may have walked away while this was in flight. The cut is
        // safely in the cloud either way; what must NOT happen is yanking them
        // back into a room they left, or writing over the room they opened next.
        const stillHere = roomRef.current;
        if (!stillHere || !belongsToThisUpload.has(stillHere.id)) {
          showToast(`${label}已經上傳好了，之後打開這個影片就看得到。`, { tone: "success" });
          return;
        }

        // Adopt it locally right away so the player can start while the cloud
        // snapshot catches up; the snapshot then replaces this with the same
        // row, keyed by the same id.
        const next: Room = {
          ...stillHere,
          mediaType: stillHere.projectMode ? stillHere.mediaType : "video",
          versions: [...stillHere.versions, { ...version, ...(targetBranchId ? { branchId: targetBranchId } : {}) }],
          updatedAt: Date.now(),
        };
        setRoom(next);
        setView((v) => (isNewRoom || !v.versionId ? initialView(next) : v));
        trackSave(next);
        showToast(isNewRoom ? "影片好了，開始留意見吧" : `已新增${label}`, { tone: "success" });
      } catch (err) {
        if (isUploadCancelled(err) || err instanceof CancelledUpload || abandoned) {
          showToast("已取消上傳");
          // A room created for an upload nobody wants must not keep the local
          // id tied to an empty cloud room — the next attempt would make a
          // second one and orphan this.
          if (isNewRoom) {
            // The bind already cached an empty snapshot; leaving it behind puts
            // a room in 最近討論 that opens to nothing.
            //
            // Awaited, not fire-and-forget: the home screen reads 最近討論
            // straight from IndexedDB, so a delete still in flight when the
            // screen renders leaves exactly the empty room this is removing.
            // Locally the write usually wins the race; on a slower machine it
            // does not, which is what made this show up only in CI.
            const cloudId = cloudRef.current.forgetCloudRoom(base.id);
            await deleteRoom(base.id).catch(() => undefined);
            if (cloudId) await deleteRoom(cloudId).catch(() => undefined);
            if ((roomRef.current?.versions.length ?? 0) === 0) setRoom(null);
          }
          // Keep the first-upload screen mounted until the IndexedDB deletes
          // above finish. Switching to idle earlier renders Home immediately,
          // where 最近討論 can observe the empty cached room for one frame.
          setVideoUpload({ state: "idle" });
        } else if (!belongsToThisUpload.has(roomRef.current?.id ?? "")) {
          // The upload failed after the person had already moved on. Telling
          // whichever room they are in now that something failed there would be
          // a lie; the success path already knows this, and so must this one.
          showToast(userFacingMessage(err), { tone: "error" });
        } else {
          const message = userFacingMessage(err);
          setVideoUpload({ state: "error", message, progress: 0, cancel: () => setVideoUpload({ state: "idle" }) });
          showToast(message, { tone: "error" });
        }
        // The room stays: its cloud room and invite already exist, so keeping
        // it lets 再試一次 reuse them instead of creating a second empty room.
        // Leaving from the failure screen is what releases them.
      } finally {
        videoCancelRef.current = null;
        busy.current.delete("upload");
      }
    },
    [activeBranchId, cloud.boundRoomId, cloud.canManageMedia, showToast, trackSave],
  );

  /** Picks route by what the room IS, so neither workspace has to check. */
  const addFiles = useCallback(
    (files: FileList | null) => {
      const current = roomRef.current;
      const branch = current && activeBranchId ? branchForId(current, activeBranchId) : undefined;
      if (branch?.branchType === "video" || (!branch && current && roomMediaType(current) === "video")) {
        void addVideoFile(files);
        return;
      }
      void addImageFiles(files);
    },
    [activeBranchId, addImageFiles, addVideoFile],
  );

  const createProjectContent = useCallback(
    async (type: BranchType, name: string, files: FileList | null) => {
      const current = roomRef.current;
      if (!current || !guest) return;
      if (isCloudConfigured && !cloudRef.current.boundRoomId) {
        try {
          const cloudRoom = await cloudRef.current.ensureCloudRoom(current);
          if (!cloudRoom) throw new Error("cloud-room-failed");
        } catch {
          showToast("活動房尚未連線，內容暫時沒有送出。請稍後再試。", { tone: "error" });
          return;
        }
      }
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者可以查看、留言與投票，但不能新增內容。", { tone: "error" });
        return;
      }
      const normalized = normalizeRoomBranches(current);
      const now = Date.now();
      const branch: RoomBranch = {
        id: crypto.randomUUID(),
        roomId: current.id,
        name,
        branchType: type,
        sortOrder: normalized.branches?.length ?? 0,
        status: "in_progress",
        createdBy: cloud.userId ?? guest.id,
        createdAt: now,
        updatedAt: now,
      };
      const plan = type === "plan" || type === "copy"
        ? { branchId: branch.id, title: name, description: "", blocks: [], updatedBy: cloud.userId ?? guest.id, updatedAt: now } satisfies PlanDocument
        : null;
      const next: Room = {
        ...normalized,
        projectMode: true,
        branches: [...(normalized.branches ?? []), branch],
        plans: plan ? [...(normalized.plans ?? []), plan] : normalized.plans,
        updatedAt: now,
      };
      setRoom(next);
      persist(next);
      setActiveBranchId(branch.id);
      try {
        // Wait for the branch FK before writing its plan or first media version.
        // This matters on a slow phone: a fixed timeout cannot establish order.
        await cloudRef.current.writes.createBranch(branch);
      } catch {
        showToast("建立內容失敗，請確認連線後再試一次。", { tone: "error" });
        return;
      }
      if (plan) cloudRef.current.writes.savePlan(plan);
      if (files?.length) {
        if (type === "poster") void addImageFiles(files, branch.id, next);
        if (type === "video") void addVideoFile(files, branch.id, next);
      }
      showToast(`已建立${type === "copy" ? "文案" : type === "plan" ? "企劃" : type === "poster" ? "文宣" : "影片"}`, { tone: "success" });
    },
    [addImageFiles, addVideoFile, cloud.boundRoomId, cloud.canManageMedia, cloud.userId, guest, persist, showToast],
  );

  const addFilesToBranch = useCallback(
    (branchId: string, files: FileList | null) => {
      const branch = roomRef.current ? branchForId(roomRef.current, branchId) : undefined;
      if (!branch || !files?.length) return;
      if (branch.branchType === "poster") void addImageFiles(files, branchId);
      else if (branch.branchType === "video") void addVideoFile(files, branchId);
    },
    [addImageFiles, addVideoFile],
  );

  const updateProjectBranch = useCallback(
    (branchId: string, patch: Partial<Pick<RoomBranch, "name" | "sortOrder" | "status">>) => {
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者不能修改分支設定。", { tone: "error" });
        return;
      }
      updateRoom((r) => ({
        ...r,
        branches: (normalizeRoomBranches(r).branches ?? []).map((branch) =>
          branch.id === branchId ? { ...branch, ...patch, updatedAt: Date.now() } : branch,
        ),
      }));
      cloudRef.current.writes.updateBranch(branchId, patch);
    },
    [cloud.boundRoomId, cloud.canManageMedia, showToast, updateRoom],
  );

  const saveProjectPlan = useCallback(
    (plan: PlanDocument) => {
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者不能編輯企劃正文。", { tone: "error" });
        return;
      }
      const nextPlan = { ...plan, updatedBy: cloud.userId ?? guest?.id, updatedAt: Date.now() };
      updateRoom((r) => ({
        ...r,
        plans: [...(r.plans ?? []).filter((item) => item.branchId !== plan.branchId), nextPlan],
        branches: (normalizeRoomBranches(r).branches ?? []).map((branch) =>
          branch.id === plan.branchId ? { ...branch, updatedAt: Date.now() } : branch,
        ),
      }));
      cloudRef.current.writes.savePlan(nextPlan);
    },
    [cloud.boundRoomId, cloud.canManageMedia, cloud.userId, guest, showToast, updateRoom],
  );

  const createProjectRelation = useCallback(
    (relation: ContentRelation) => {
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者不能管理相關內容。", { tone: "error" });
        return;
      }
      const nextRelation = { ...relation, createdBy: cloud.userId ?? relation.createdBy };
      updateRoom((r) => ({ ...r, relations: [...(r.relations ?? []), nextRelation] }));
      cloudRef.current.writes.createRelation(nextRelation);
    },
    [cloud.boundRoomId, cloud.canManageMedia, cloud.userId, showToast, updateRoom],
  );

  const deleteProjectRelation = useCallback(
    (relationId: string) => {
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者不能管理相關內容。", { tone: "error" });
        return;
      }
      updateRoom((r) => ({ ...r, relations: (r.relations ?? []).filter((relation) => relation.id !== relationId) }));
      cloudRef.current.writes.deleteRelation(relationId);
    },
    [cloud.boundRoomId, cloud.canManageMedia, showToast, updateRoom],
  );

  const createProjectPoll = useCallback(
    (poll: RoomPoll) => {
      if (!cloud.canManageMedia && cloud.boundRoomId) {
        showToast("檢視者可以投票，但不能建立待決策。", { tone: "error" });
        return;
      }
      const nextPoll = { ...poll, createdBy: cloud.userId ?? poll.createdBy };
      updateRoom((r) => ({ ...r, polls: [...(r.polls ?? []), nextPoll] }));
      cloudRef.current.writes.createPoll(nextPoll);
    },
    [cloud.boundRoomId, cloud.canManageMedia, cloud.userId, showToast, updateRoom],
  );

  const voteProjectPoll = useCallback(
    (vote: PollVote) => {
      updateRoom((r) => ({
        ...r,
        pollVotes: [
          ...(r.pollVotes ?? []).filter((item) => !(item.pollId === vote.pollId && item.userId === vote.userId)),
          vote,
        ],
      }));
      cloudRef.current.writes.votePoll(vote);
    },
    [updateRoom],
  );

  const sendDiscussion = useCallback(
    (input?: { id?: string; body?: string; kind?: DiscussionMessage["kind"]; payload?: DiscussionMessage["payload"]; replyToId?: string }) => {
      if (!guest) return;
      const body = (input?.body ?? chatInput).trim();
      if (!body && !input?.kind) return;
      const message: DiscussionMessage = {
        // 附件卡的 storage 路徑以 messageId 為鍵，所以允許呼叫端先發 id。
        id: input?.id ?? crypto.randomUUID(),
        roomId: roomRef.current?.id ?? "",
        authorId: cloud.userId ?? guest.id,
        authorName: guest.name,
        authorColor: guest.color,
        kind: input?.kind ?? "text",
        body: body || (input?.payload?.title ?? ""),
        payload: input?.payload ?? {},
        replyToId: input?.replyToId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      // 純文字訊息加 300ms 去抖（比照 sendChat 的 claim）；帶 payload 的
      // 結構卡各有唯一內容，不需要。
      if ((input?.kind ?? "text") === "text" && !claim(`discussion:${body}`, 300)) return;
      updateRoom((r) => ({ ...r, discussion: [...(r.discussion ?? []), message] }));
      discussionOutboxRef.current.send(message);
      setChatInput("");
    },
    [chatInput, claim, cloud.userId, guest, updateRoom],
  );

  // ---- 討論附件（PR-01b Universal Intake） --------------------------------
  // 順序固定：驗證 → 上傳（upsert:false）→ insertDiscussion。上傳成功但
  // insert 失敗 → outbox 顯示未送出，重試只重發 insert（path 已在 payload，
  // 永不重新上傳）。上傳失敗 → 沒有任何列，重選檔會鑄新 assetId。
  const attachmentBusy = useRef(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const sendAttachment = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file || !guest) return;
      // 大小閘放在這裡：迴紋針（UniversalIntake maxBytes）與檔案貼上
      // 走同一道（Grok pr01b 建議 — 貼上不該繞過 25MB）。
      if (file.size > INTAKE_PROFILES.attachment.maxBytes) {
        showToast(`檔案太大了，附件單檔上限 ${Math.round(INTAKE_PROFILES.attachment.maxBytes / 1024 / 1024)}MB。`, { tone: "error" });
        return;
      }
      const roomId = cloudRef.current.boundRoomId;
      if (!roomId) {
        // 附件路徑在上傳當下就得綁 cloud room id（storage RLS 也照它驗），
        // 綁定完成前直接說清楚，不做會靜默失敗的事。
        showToast("還在連上雲端，稍等一下再附檔。", { tone: "error" });
        return;
      }
      if (attachmentBusy.current) return; // 上傳中不接受第二件（防雙擊）
      attachmentBusy.current = true;
      setAttachmentUploading(true);
      try {
        const messageId = crypto.randomUUID();
        const mime = file.type || "application/octet-stream";
        const path = attachmentPath(roomId, messageId, crypto.randomUUID(), attachmentExt(mime, file.name));
        await uploadAttachment(getSupabase()!, path, file, mime);
        sendDiscussion({
          id: messageId,
          kind: "attachment",
          body: file.name,
          payload: { path, mime, size: file.size, name: file.name, title: file.name },
        });
      } catch {
        showToast("附件沒有上傳成功，請再試一次。", { tone: "error" });
      } finally {
        attachmentBusy.current = false;
        setAttachmentUploading(false);
      }
    },
    [guest, sendDiscussion, showToast],
  );

  // 連結卡：無 storage 物件；渲染端只接受 http/https（貼上端也先驗一次）。
  const sendLink = useCallback(
    (url: string) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      sendDiscussion({ kind: "link", body: parsed.href, payload: { href: parsed.href, title: parsed.hostname } });
      return true;
    },
    [sendDiscussion],
  );

  // 附件卡的 signed URL 解析器：RoomDiscussion 保持純呈現層，簽名集中在
  // App，帶 50 分鐘快取（SIGNED_TTL 1 小時，留緩衝）。
  const assetUrlCache = useRef(new Map<string, { url: string; at: number }>());
  const resolveAssetUrl = useCallback(async (path: string) => {
    const cached = assetUrlCache.current.get(path);
    if (cached && Date.now() - cached.at < 50 * 60 * 1000) return cached.url;
    const url = await signedUrl(getSupabase()!, path);
    assetUrlCache.current.set(path, { url, at: Date.now() });
    return url;
  }, []);

  const supportDiscussion = useCallback(
    (messageId: string, add: boolean) => {
      const userId = cloud.userId ?? guest?.id;
      if (!userId) return;
      // legacy messages（0001 表）唯讀併入 drawer；它們的 id 不存在於
      // room_discussion_messages，寫支持會 FK 失敗（Grok pr01a F5）。
      if (!(roomRef.current?.discussion ?? []).some((message) => message.id === messageId)) return;
      updateRoom((r) => ({
        ...r,
        discussionSupports: add
          ? [...(r.discussionSupports ?? []).filter((item) => !(item.messageId === messageId && item.userId === userId)), { messageId, roomId: r.id, userId }]
          : (r.discussionSupports ?? []).filter((item) => !(item.messageId === messageId && item.userId === userId)),
      }));
      cloudRef.current.writes.setDiscussionSupport?.(messageId, add);
    },
    [cloud.userId, guest, updateRoom],
  );

  const createWhiteboard = useCallback(
    (title: string): Whiteboard | undefined => {
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者不能建立白板。", { tone: "error" });
        return;
      }
      const board: Whiteboard = {
        id: crypto.randomUUID(),
        roomId: roomRef.current?.id ?? "",
        title,
        description: "",
        allowEdit: false,
        createdBy: cloud.userId ?? guest?.id ?? "local",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };
      updateRoom((r) => ({ ...r, whiteboards: [board, ...(r.whiteboards ?? [])] }));
      cloudRef.current.writes.createWhiteboard?.(board);
      setActiveWhiteboardId(board.id);
      return board;
    },
    [cloud.boundRoomId, cloud.canManageMedia, cloud.userId, guest, showToast, updateRoom],
  );

  const archiveWhiteboard = useCallback(
    (id: string) => {
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者不能封存整塊白板。", { tone: "error" });
        return;
      }
      updateRoom((r) => ({
        ...r,
        whiteboards: (r.whiteboards ?? []).map((board) => board.id === id ? { ...board, archivedAt: Date.now(), updatedAt: Date.now() } : board),
      }));
      const board = roomRef.current?.whiteboards?.find((item) => item.id === id);
      if (board) cloudRef.current.writes.updateWhiteboard?.({ ...board, archivedAt: Date.now() });
      if (activeWhiteboardId === id) setActiveWhiteboardId(null);
    },
    [activeWhiteboardId, cloud.boundRoomId, cloud.canManageMedia, showToast, updateRoom],
  );

  const upsertNodes = useCallback(
    (nodes: WhiteboardNode[], persist: "now" | "end" = "now") => {
      const writer = { id: cloud.userId ?? guest?.id ?? "local", name: guest?.name ?? "我" };
      const existingById = new Map((roomRef.current?.whiteboardNodes ?? []).map((node) => [node.id, node]));
      const stamped = nodes.map((node) => {
        const lastAcked = lastAckedNodeVersion.current.get(node.id) ?? existingById.get(node.id)?.version;
        return stampPersistedNode(stampWriter(node, writer), lastAcked);
      });
      updateRoom((r) => {
        const byId = new Map((r.whiteboardNodes ?? []).map((node) => [node.id, node]));
        for (const node of stamped) byId.set(node.id, node);
        return { ...r, whiteboardNodes: [...byId.values()] };
      });
      void persist;
      const roomId = roomRef.current?.id ?? stamped[0]?.roomId ?? "";
      const persistCloud = async (node: WhiteboardNode) => {
        const prev = nodePersistChain.current.get(node.id) ?? Promise.resolve();
        const next = prev.catch(() => undefined).then(async () => {
          const latest = roomRef.current?.whiteboardNodes?.find((item) => item.id === node.id) ?? node;
          const acked = lastAckedNodeVersion.current.get(latest.id) ?? latest.version ?? 1;
          const toWrite = stampPersistedNode(latest, acked);
          const result = await cloudRef.current.writes.upsertNode?.(toWrite);
          if (isCloudWriteAcknowledged(result)) {
            if (result && typeof result === "object") {
              lastAckedNodeVersion.current.set(result.id, result.version ?? acked);
              updateRoom((r) => ({
                ...r,
                whiteboardNodes: (r.whiteboardNodes ?? []).map((item) => item.id === result.id ? adoptPersistedNode(item, result) : item),
              }));
            }
            await clearPendingEdit(`node:${node.id}`);
            return;
          }
          if (result === "conflict") {
            // stale-write：別人已存了較新版本。舊 payload 不進佇列（重放
            // 永遠 409）。取新必須是 loadWhiteboard(該板) — 整房 summary
            // 的 nodes 是空的、換不到節點（Grok pr02b F2）。toast 等圖真的
            // 換完才說，而且說實話。
            await clearPendingEdit(`node:${node.id}`);
            const refreshed = await cloudRef.current.loadWhiteboard?.(node.whiteboardId).catch(() => false);
            showToast(
              refreshed
                ? "這個節點被別人改過，白板已同步成最新版本。"
                : "這個節點被別人改過；重新打開白板可取得最新版本。",
              { tone: "error" },
            );
            return;
          }
          const retry = decideNodeWriteRetry(cloudRef.current.active ? "failed" : "unbound");
          if (retry.queueDurable && cloudRef.current.active) {
            await queuePendingEdit({
              id: `node:${node.id}`,
              roomId,
              kind: "node",
              op: "upsert",
              payload: toWrite,
              createdAt: Date.now(),
            });
          }
        });
        nodePersistChain.current.set(node.id, next);
        await next;
      };
      if (isBrowserOnline()) {
        stamped.forEach((node) => void persistCloud(node));
      } else {
        stamped.forEach((node) => {
          void queuePendingEdit({
            id: `node:${node.id}`,
            roomId,
            kind: "node",
            op: "upsert",
            payload: node,
            createdAt: Date.now(),
          });
        });
      }
      const current = roomRef.current;
      const board = current?.whiteboards?.find((item) => item.id === stamped[0]?.whiteboardId);
      if (current && board) {
        void saveBoardSnapshot({
          whiteboardId: board.id,
          roomId: current.id,
          whiteboard: board,
          nodes: [...(current.whiteboardNodes ?? []).filter((node) => node.whiteboardId !== board.id), ...stamped],
          edges: current.whiteboardEdges ?? [],
        });
      }
    },
    [cloud.userId, guest, updateRoom],
  );

  const upsertNode = useCallback(
    (node: WhiteboardNode) => upsertNodes([node]),
    [upsertNodes],
  );

  const deleteNode = useCallback(
    (id: string) => {
      updateRoom((r) => ({
        ...r,
        whiteboardNodes: (r.whiteboardNodes ?? []).filter((node) => node.id !== id),
        whiteboardEdges: (r.whiteboardEdges ?? []).filter((edge) => edge.sourceNodeId !== id && edge.targetNodeId !== id),
      }));
      const persistDelete = async () => {
        const result = await cloudRef.current.writes.deleteNode?.(id);
        if (isCloudWriteAcknowledged(result)) {
          await clearPendingEdit(`node-del:${id}`);
          return;
        }
        // delete 沒有版本檢查（touch trigger 只掛 BEFORE UPDATE），SQL 上
        // 到不了 stale-write — 不裝死碼假裝有 OCC；離線 delete 蓋掉線上
        // 編輯的語意缺口記在 ADR-011，tombstone 時一併處理。
        const retry = decideNodeWriteRetry(cloudRef.current.active ? "failed" : "unbound");
        if (retry.queueDurable && cloudRef.current.active) {
          await queuePendingEdit({
            id: `node-del:${id}`,
            roomId: roomRef.current?.id ?? "",
            kind: "node",
            op: "delete",
            payload: { id },
            createdAt: Date.now(),
          });
        }
      };
      if (isBrowserOnline()) {
        void persistDelete();
        return;
      }
      void queuePendingEdit({
        id: `node-del:${id}`,
        roomId: roomRef.current?.id ?? "",
        kind: "node",
        op: "delete",
        payload: { id },
        createdAt: Date.now(),
      });
    },
    [updateRoom],
  );

  const createEdge = useCallback(
    (edge: WhiteboardEdge) => {
      updateRoom((r) => ({ ...r, whiteboardEdges: [...(r.whiteboardEdges ?? []), edge] }));
      cloudRef.current.writes.createEdge?.(edge);
    },
    [updateRoom],
  );

  const shareNodeToDiscussion = useCallback(
    (node: WhiteboardNode) => {
      const board = roomRef.current?.whiteboards?.find((item) => item.id === node.whiteboardId);
      sendDiscussion({
        kind: "node",
        body: node.content.text || node.content.title || "看這個節點",
        payload: discussionPayloadFromNode(node, board?.title),
      });
    },
    [sendDiscussion],
  );

  const addMessageToBoard = useCallback(
    (message: DiscussionMessage, whiteboardId: string) => {
      const node = stickyFromDiscussion(message, whiteboardId, cloud.userId ?? guest?.id ?? "local", {
        x: 80 + ((roomRef.current?.whiteboardNodes ?? []).length % 4) * 24,
        y: 80 + ((roomRef.current?.whiteboardNodes ?? []).length % 5) * 24,
      });
      upsertNode(node);
      setActiveWhiteboardId(whiteboardId);
      setFocusNodeId(node.id);
    },
    [cloud.userId, guest, upsertNode],
  );

  const createDecision = useCallback(
    (title: string, source?: { type: "poll"; id: string }, status: "pending" | "decided" = "pending") => {
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者不能建立決策紀錄。", { tone: "error" });
        return;
      }
      const decision = {
        id: crypto.randomUUID(),
        roomId: roomRef.current?.id ?? "",
        title,
        body: "",
        status,
        sourceType: source ? "poll" as const : "manual" as const,
        sourceId: source?.id,
        createdBy: cloud.userId ?? guest?.id ?? "local",
        finalizedAt: status === "decided" ? Date.now() : undefined,
        finalizedBy: status === "decided" ? cloud.userId ?? guest?.id : undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };
      updateRoom((r) => ({ ...r, decisions: [decision, ...(r.decisions ?? [])] }));
      cloudRef.current.writes.createDecision?.(decision);
    },
    [cloud.boundRoomId, cloud.canManageMedia, cloud.userId, guest, showToast, updateRoom],
  );

  const finalizeDecision = useCallback(
    (id: string) => {
      if (cloud.boundRoomId && !cloud.canManageMedia) {
        showToast("檢視者不能標示決策。", { tone: "error" });
        return;
      }
      updateRoom((r) => ({
        ...r,
        decisions: (r.decisions ?? []).map((item) => item.id === id ? { ...item, status: "decided", finalizedAt: Date.now(), finalizedBy: cloud.userId ?? guest?.id, updatedAt: Date.now() } : item),
      }));
      const decision = roomRef.current?.decisions?.find((item) => item.id === id);
      if (decision) cloudRef.current.writes.updateDecision?.({ ...decision, status: "decided", finalizedAt: Date.now() });
    },
    [cloud.boundRoomId, cloud.canManageMedia, cloud.userId, guest, showToast, updateRoom],
  );

  const toggleAllowBoardEdit = useCallback(() => {
    if (cloud.role && cloud.role !== "owner") {
      showToast("只有房主能開放大家一起編輯。", { tone: "error" });
      return;
    }
    updateRoom((r) => ({ ...r, allowBoardEdit: !r.allowBoardEdit }));
    cloudRef.current.writes.setAllowBoardEdit?.(!(roomRef.current?.allowBoardEdit));
  }, [cloud.role, showToast, updateRoom]);

  const applyAiProposal = useCallback(
    async (proposal: AiProposal, extraConfirmed = false): Promise<ApplyProposalResult> => {
      const current = roomRef.current;
      const actor = cloud.userId ?? guest?.id ?? "local";
      const canTalk = Boolean(guest);
      const canManage = !cloud.boundRoomId || cloud.canManageMedia;
      const canEditBoard = canManage || Boolean(current?.allowBoardEdit);
      const gate = applyGate({
        proposal,
        alreadyApplied: appliedAiProposalIds.current.has(proposal.id),
        extraConfirmed,
        canTalk,
        canManage,
        canEditBoard,
      });
      if (!gate.ok) {
        return { ok: false, reason: gate.reason, message: applyReasonMessage(gate.reason) };
      }
      if (!current) return { ok: false, reason: "failed", message: "房間還沒準備好。" };

      const audit = (body: string) => sendDiscussion({ kind: "text", body, payload: { title: proposal.label } });

      try {
        if (proposal.type === "create_comment") {
          sendDiscussion({ kind: "text", body: commentBodyFromAction(proposal.payload, proposal.label) });
        } else if (proposal.type === "create_poll") {
          createProjectPoll(pollFromAction(proposal.payload, current.id, actor));
          audit(`已套用 AI 提案：${proposal.label}`);
        } else if (proposal.type === "create_plan_draft") {
          await createProjectContent("plan", planDraftTitle(proposal.payload, proposal.label), null);
          audit(`已套用 AI 提案：${proposal.label}`);
        } else if (proposal.type === "add_whiteboard_node") {
          const existing = (current.whiteboards ?? []).find((board) => !board.archivedAt);
          const board = existing ?? createWhiteboard("討論白板");
          if (!board) return { ok: false, reason: "forbidden", message: applyReasonMessage("forbidden") };
          const count = (roomRef.current?.whiteboardNodes ?? []).filter((node) => node.whiteboardId === board.id).length;
          const node = nodeFromAddWhiteboardAction({
            payload: proposal.payload,
            whiteboardId: board.id,
            roomId: current.id,
            createdBy: actor,
            x: 80 + (count % 4) * 24,
            y: 80 + (count % 5) * 24,
          });
          upsertNode(node);
          setActiveWhiteboardId(board.id);
          setFocusNodeId(node.id);
          audit(`已套用 AI 提案：${proposal.label}`);
        }
        appliedAiProposalIds.current.add(proposal.id);
        showToast("已套用 AI 提案", { tone: "success" });
        return { ok: true, message: "已套用。原稿沒有被改寫。" };
      } catch {
        return { ok: false, reason: "failed", message: "套用失敗，請稍後再試。" };
      }
    },
    [cloud.boundRoomId, cloud.canManageMedia, cloud.userId, createProjectContent, createProjectPoll, createWhiteboard, guest, sendDiscussion, showToast, upsertNode],
  );

  useEffect(() => {
    const flushPendingBoardEdits = () => {
      const current = roomRef.current;
      if (!current || !isBrowserOnline()) return;
      void listPendingEdits(current.id).then(async (pending) => {
        const listedAt = new Map(pending.map((edit) => [edit.id, edit.createdAt]));
        const { acknowledged, dropped } = await applyPendingCloudWrites(pending, {
          upsertNode: cloudRef.current.writes.upsertNode,
          deleteNode: cloudRef.current.writes.deleteNode,
        });
        // 清鍵一律以「列出當下那一份」為準：flush 期間使用者可能又打了字，
        // 同 key 的較新 payload 不能被盲刪（Grok pr02b F3）。
        for (const id of acknowledged) await clearPendingEditIf(id, listedAt.get(id) ?? -1);
        for (const id of dropped) await clearPendingEditIf(id, listedAt.get(id) ?? -1);
        if (dropped.length) showToast("離線期間的部分白板編輯已被較新版本取代。", { tone: "error" });
      });
    };
    window.addEventListener("online", flushPendingBoardEdits);
    flushPendingBoardEdits();
    return () => window.removeEventListener("online", flushPendingBoardEdits);
  }, [room?.id]);

  /**
   * File one piece of video feedback: same comment, same discussion, same cloud
   * write as a poster pin — only the coordinates are a time.
   */
  const commitVideoComment = useCallback(
    (anchor: VideoAnchor, category?: VideoCategory) => {
      const current = roomRef.current;
      if (!current || !guest || !form.body.trim()) return;
      const versionId = viewRef.current.versionId || current.versions[0]?.id;
      if (!versionId) return;
      const at = anchor.kind === "range" ? anchor.startTime : anchor.time;
      if (!claim(`video:${versionId}:${at.toFixed(2)}:${form.body.trim()}`)) return;

      const pin: CommentPin = {
        id: uid("c_"),
        versionId,
        authorId: guest.id,
        authorName: guest.name,
        authorColor: guest.color,
        // x/y are meaningless for time anchors; the columns keep their defaults
        // so a future on-screen position has somewhere to go.
        x: 0.5,
        y: 0.5,
        anchor,
        body: form.body.trim(),
        suggestion: form.suggestion.trim(),
        // A video room picks from 畫面／節奏／字幕／聲音／文案／其他 and is allowed
        // to pick nothing at all — classifying must never be the price of
        // speaking up. `problemType` is free text in the schema, so both lists
        // share the column without either having to know about the other.
        problemType: (category as ReviewType | undefined) ?? undefined,
        priority: form.priority,
        resolved: false,
        reviewStatus: "open",
        createdAt: Date.now(),
      };
      pushUndo(current);
      updateRoom((r) => ({ ...r, comments: [...r.comments, pin] }));
      cloudRef.current.writes.insertComment(pin);
      setFormState(EMPTY_FORM);
      showToast("已收到你的意見 ✓", { tone: "success", action: { label: "復原", onClick: undoLast } });
    },
    [guest, form, claim, pushUndo, updateRoom, showToast, undoLast],
  );

  /**
   * Give up on a video room that never got its first cut.
   *
   * Three things have to go, or the next attempt starts from a fresh local id
   * and quietly creates a SECOND empty cloud room: the mapping, the cached
   * snapshot the cloud bind already wrote, and the room in state.
   */
  const abandonEmptyVideoRoom = useCallback(() => {
    const current = roomRef.current;
    videoCancelRef.current?.();
    setVideoUpload({ state: "idle" });
    if (current) {
      const cloudId = cloudRef.current.forgetCloudRoom(current.id);
      deleteRoom(current.id).catch(() => undefined);
      if (cloudId && cloudId !== current.id) deleteRoom(cloudId).catch(() => undefined);
    }
    clearUndo();
    setRoom(null);
    location.hash = "";
  }, [clearUndo]);

  /** The playing version's signed URL expired; mint another for the same path. */
  const refreshVideoUrl = useCallback(async (): Promise<string | null> => {
    const current = roomRef.current;
    const version = current?.versions.find((v) => v.id === viewRef.current.versionId);
    if (!version?.videoPath) return null;
    const fresh = await cloudRef.current.refreshVideoUrl(version.videoPath);
    if (!fresh) return null;
    // Keep the room object honest too, so a later re-render does not hand the
    // player the stale URL again.
    setRoom((r) =>
      r
        ? { ...r, versions: r.versions.map((v) => (v.id === version.id ? { ...v, videoUrl: fresh } : v)) }
        : r,
    );
    return fresh;
  }, []);

  /**
   * Feedback tasks are one-shot on mobile: sent or cancelled, the app returns
   * to clean viewing. Desktop keeps its persistent pin tool; the region
   * gesture is one-shot everywhere.
   */
  const finishTask = useCallback(() => {
    setTool((t) => (t === "region" || (isMobileRef.current && t === "pin") ? "pan" : t));
  }, []);

  const cancelPin = useCallback(() => {
    setDraftPin(null);
    setFormState(EMPTY_FORM);
    finishTask();
  }, [finishTask]);

  const placePin = useCallback((versionId: string, x: number, y: number) => {
    setSelectedPinId(null);
    setPreviewStrokeId(null);
    setDraftPin({ versionId, x, y });
    setFormState(EMPTY_FORM);
  }, []);

  /** A finished 圈範圍 gesture: the freehand stroke is gone, only its region remains as a draft. */
  const placeRegion = useCallback((versionId: string, region: AnnotationRegion) => {
    const center = regionCenter(region);
    setSelectedPinId(null);
    setPreviewStrokeId(null);
    setDraftPin({ versionId, x: center.x, y: center.y, region });
    setFormState(EMPTY_FORM);
  }, []);

  const commitPin = useCallback(() => {
    if (!draftPin || !guest || !form.body.trim()) {
      cancelPin();
      return;
    }
    if (!claim(`pin:${draftPin.versionId}:${draftPin.x}:${draftPin.y}`)) return;
    const pin: CommentPin = {
      id: uid("c_"),
      versionId: draftPin.versionId,
      authorId: guest.id,
      authorName: guest.name,
      authorColor: guest.color,
      x: draftPin.x,
      y: draftPin.y,
      ...(draftPin.region ? { region: draftPin.region } : {}),
      body: form.body.trim(),
      suggestion: form.suggestion.trim(),
      problemType: form.type,
      priority: form.priority,
      resolved: false,
      createdAt: Date.now(),
    };
    const current = roomRef.current;
    const number = current ? nextPinNumber(current, draftPin.versionId) : 1;
    if (current) pushUndo(current);
    updateRoom((r) => ({ ...r, comments: [...r.comments, pin] }));
    cloudRef.current.writes.insertComment(pin);
    markCoachSeen();
    cancelPin();
    void number;
    const count = (current?.comments.length ?? 0) + 1;
    const people = new Set([...(current?.comments.map((c) => c.authorName) ?? []), guest.name]).size;
    showToast("已收到你的意見 ✓", {
      tone: "success",
      action: { label: "復原", onClick: undoLast },
    });
    showToast(`目前 ${people} 人提出 ${count} 個修改建議`);
  }, [draftPin, guest, form, claim, pushUndo, updateRoom, markCoachSeen, cancelPin, showToast, undoLast]);

  const toggleResolve = useCallback(
    (pinId: string) => {
      const current = roomRef.current;
      if (!current) return;
      const pin = current.comments.find((c) => c.id === pinId);
      if (!pin) return;
      const willResolve = !pin.resolved;
      const number = pinNumber(current, pinId);
      cloudRef.current.writes.setResolved(pinId, willResolve);
      mutateWithUndo(
        (r) => ({
          ...r,
          comments: r.comments.map((c) => (c.id === pinId ? { ...c, resolved: willResolve } : c)),
        }),
        `修改點 ${number} ${willResolve ? "已標記完成" : "已重新開啟"}`,
      );
    },
    [mutateWithUndo],
  );

  const addStroke = useCallback(
    (versionId: string, points: Point[]) => {
      if (!guest || points.length < 2) return;
      const current = roomRef.current;
      if (current) pushUndo(current);
      const stroke: Stroke = {
        id: uid("s_"),
        versionId,
        authorId: guest.id,
        color: guest.color,
        width: 4,
        points,
        createdAt: Date.now(),
      };
      updateRoom((r) => ({ ...r, strokes: [...r.strokes, stroke] }));
      cloudRef.current.writes.insertStroke(stroke);
    },
    [guest, pushUndo, updateRoom],
  );

  const eraseStroke = useCallback(
    (strokeId: string) => {
      const current = roomRef.current;
      if (!current || !current.strokes.some((s) => s.id === strokeId)) return;
      cloudRef.current.writes.deleteStroke(strokeId);
      mutateWithUndo((r) => ({ ...r, strokes: r.strokes.filter((s) => s.id !== strokeId) }), "已刪除圈畫");
    },
    [mutateWithUndo],
  );

  const sendChat = useCallback(() => {
    if (!guest || !chatInput.trim()) return;
    if (!claim(`chat:${chatInput.trim()}`, 300)) return;
    const msg: ChatMessage = {
      id: uid("m_"),
      authorId: guest.id,
      authorName: guest.name,
      authorColor: guest.color,
      body: chatInput.trim(),
      createdAt: Date.now(),
    };
    updateRoom((r) => ({ ...r, messages: [...r.messages, msg] }));
    cloudRef.current.writes.insertMessage(msg);
    setChatInput("");
  }, [guest, chatInput, claim, updateRoom]);

  // "我也覺得": one per user per comment; tapping again removes it.
  const toggleSupport = useCallback(
    (commentId: string) => {
      if (!guest) return;
      const current = roomRef.current;
      if (!current) return;
      const uidNow = guest.id;
      const existing = (current.supports ?? []).some((s) => s.commentId === commentId && s.userId === uidNow);
      updateRoom((r) => {
        const list = r.supports ?? [];
        return {
          ...r,
          supports: existing
            ? list.filter((s) => !(s.commentId === commentId && s.userId === uidNow))
            : [...list, { commentId, userId: uidNow }],
        };
      });
      cloudRef.current.writes.toggleSupport(commentId, !existing);
    },
    [guest, updateRoom],
  );

  const addReply = useCallback(
    (commentId: string, body: string) => {
      const text = body.trim();
      if (!guest || !text) return;
      if (!claim(`reply:${commentId}:${text}`, 300)) return;
      const reply: CommentReply = {
        id: uid("r_"),
        commentId,
        authorId: guest.id,
        authorName: guest.name,
        authorColor: guest.color,
        body: text,
        createdAt: Date.now(),
      };
      updateRoom((r) => ({ ...r, replies: [...(r.replies ?? []), reply] }));
      cloudRef.current.writes.insertReply(reply);
    },
    [guest, claim, updateRoom],
  );

  // One take per user per version; tapping the current choice clears it.
  const setProposalPref = useCallback(
    (versionId: string, choice: string) => {
      if (!guest) return;
      const uidNow = guest.id;
      const current = roomRef.current;
      const existing = (current?.proposalPrefs ?? []).find((p) => p.versionId === versionId && p.userId === uidNow);
      const clearing = existing?.choice === choice;
      updateRoom((r) => {
        const list = (r.proposalPrefs ?? []).filter((p) => !(p.versionId === versionId && p.userId === uidNow));
        return { ...r, proposalPrefs: clearing ? list : [...list, { versionId, userId: uidNow, choice }] };
      });
      cloudRef.current.writes.setProposalPref(versionId, clearing ? "" : choice);
    },
    [guest, updateRoom],
  );

  const startHosting = useCallback(() => {
    if (isCloudConfigured) return;
    const current = roomRef.current;
    if (!current || collabRef.current) return;
    const collab = new Collab("host", current.id, {
      onStatus: (status) => {
        setCollabStatus(status);
        setPeerCount(collab.peerCount);
      },
      onMessage: (msg, conn) => {
        if (msg.t === "hello") {
          collab.sendTo(conn, { t: "snapshot", room: roomRef.current!, view: viewRef.current });
          setPeerCount(collab.peerCount);
        } else if (msg.t === "room") {
          applyRemoteRoom(msg.room);
          saveRoom(msg.room).catch(() => undefined);
        }
      },
    });
    collab.connect();
    collabRef.current = collab;
  }, [applyRemoteRoom]);

  /**
   * Local mode serves the room straight from this device, so host whenever a
   * room is open — waiting for a 分享 tap left every reopened room unreachable
   * to partners. (With cloud configured, Supabase serves the room instead.)
   */
  useEffect(() => {
    if (isCloudConfigured || isGuestSession || !room?.id) return;
    startHosting();
    return () => {
      collabRef.current?.destroy();
      collabRef.current = null;
      setCollabStatus(null);
      setPeerCount(0);
    };
  }, [isGuestSession, room?.id, startHosting]);

  /**
   * Closing the tab mid-upload.
   *
   * The request would be killed by the browser anyway; aborting it ourselves is
   * what lets the cleanup path run, so a half-uploaded object does not sit in a
   * private bucket that nothing will ever reference.
   *
   * `pagehide` fires for two very different things, though, and only one of
   * them is a close. On a phone it also fires when the page goes into the
   * back/forward cache — switching apps to copy a link, taking a call — and the
   * page usually comes back. Cancelling there means every upload dies the first
   * time someone leaves the app, which on a 90MB video over mobile data is the
   * whole upload. `event.persisted` tells the two apart: true means the page is
   * frozen, not gone.
   */
  useEffect(() => {
    const stop = (e: PageTransitionEvent) => {
      if (e.persisted) return; // going into bfcache; the upload may survive
      videoCancelRef.current?.();
    };
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, []);

  // Phones freeze background tabs and drop sockets; re-dial the peer link the
  // moment we are visible or online again. Harmless when no peer is in use.
  useEffect(() => {
    const revive = () => {
      if (document.visibilityState === "visible") collabRef.current?.retryNow();
    };
    const onOnline = () => collabRef.current?.retryNow();
    document.addEventListener("visibilitychange", revive);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", revive);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const [shareState, setShareState] = useState<ShareState>({ kind: "creating" });
  const shareStateRef = useRef<ShareState>(shareState);
  shareStateRef.current = shareState;
  /**
   * Guards against a late preview result landing on a share sheet the user has
   * since closed and reopened (or on a different room).
   */
  const shareSeq = useRef(0);

  /**
   * Fold a preview result into the sheet. The permanent `#room=…&invite=…` URL
   * stays the fallback in every branch: an Open Graph card is an enhancement,
   * never a prerequisite for sharing (PR #21).
   */
  const applyPreview = useCallback((seq: number, appUrl: string, preview: SharePreview | null) => {
    if (seq !== shareSeq.current) return;
    if (!preview) {
      setShareState({ kind: "ready", url: appUrl, appUrl, preview: { status: "unavailable" }, card: null });
      return;
    }
    const card: ShareCard = {
      title: preview.title,
      description: preview.description,
      coverSource: preview.coverSource,
      titleCustomized: preview.titleCustomized,
      descriptionCustomized: preview.descriptionCustomized,
    };
    setShareState({
      kind: "ready",
      url: buildPreviewShareUrl(preview.id, appUrl),
      appUrl,
      card,
      preview:
        preview.showThumbnail && preview.thumbnailPath
          ? { status: "on", thumbnailUrl: previewThumbnailUrl(preview.thumbnailPath, preview.updatedAt) }
          : { status: "off" },
    });
  }, []);

  const failPreview = useCallback((seq: number, appUrl: string) => {
    if (seq !== shareSeq.current) return;
    // Keep whatever the sheet already knows about the card: a failed refresh
    // should not make an existing custom title look like it was never saved.
    const current = shareStateRef.current;
    const card = current.kind === "ready" ? current.card : null;
    setShareState({ kind: "ready", url: appUrl, appUrl, preview: { status: "unavailable" }, card });
  }, []);

  const withPreviewTimeout = useCallback(
    (work: Promise<SharePreview | null>): Promise<SharePreview | null> => {
      let timer = 0;
      const deadline = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("preview build timed out")), PREVIEW_BUILD_TIMEOUT_MS);
      });
      return Promise.race([work, deadline]).finally(() => window.clearTimeout(timer));
    },
    [],
  );

  /**
   * A share link is only worth handing out if it still opens after the host
   * closes the page — that means cloud `#room=<uuid>&invite=<token>` and
   * nothing else. When the cloud room cannot be created we say so and offer a
   * retry; we never quietly fall back to a legacy `#room=<6碼>` URL, which
   * dies the moment this device goes away (PR #16).
   */
  const openShare = useCallback(() => {
    const current = roomRef.current;
    if (!current) return;
    setShareOpen(true);

    if (isLegacyLink) {
      setShareState({ kind: "legacy-guest" });
      return;
    }
    if (isCloudConfigured) {
      const seq = ++shareSeq.current;
      setShareState({ kind: "creating" });
      cloudRef.current
        .ensureShared()
        .then((res) => {
          if (seq !== shareSeq.current) return;
          if (!res.ok) {
            setShareState({ kind: "failed" });
            return;
          }
          // The room is shareable, but nothing is handed out yet: `building`
          // holds every share action back until the card either exists or has
          // definitively failed. Sending `appUrl` in this window is exactly the
          // bug — LINE would get a fragment-only URL and show the generic cover
          // even though the poster frame was already sitting in Storage.
          const appUrl = addRoomTarget(
            res.url,
            activeBranchId
              ? { branchId: activeBranchId, versionId: viewRef.current.versionId || undefined }
              : activeWhiteboardId
                ? { whiteboardId: activeWhiteboardId, nodeId: focusNodeId || undefined }
                : undefined,
          );
          setShareState({ kind: "ready", url: appUrl, appUrl, preview: { status: "building" }, card: null });
          withPreviewTimeout(cloudRef.current.preview.ensure({ versionId: viewRef.current.versionId }))
            .then((preview) => applyPreview(seq, appUrl, preview))
            .catch(() => failPreview(seq, appUrl));
        })
        .catch(() => {
          if (seq === shareSeq.current) setShareState({ kind: "failed" });
        });
      return;
    }
    if (import.meta.env.DEV) {
      // Dev-only peer link for local testing, labelled as temporary. Written
      // against `import.meta.env.DEV` on purpose: the legacy URL is compiled
      // out of production bundles entirely, not merely branched around.
      startHosting();
      setShareState({
        kind: "local",
        url: addRoomTarget(
          `${location.origin}${location.pathname}#room=${current.id}`,
          activeBranchId
            ? { branchId: activeBranchId, versionId: viewRef.current.versionId || undefined }
            : activeWhiteboardId
              ? { whiteboardId: activeWhiteboardId, nodeId: focusNodeId || undefined }
              : undefined,
        ),
      });
      return;
    }
    // Deployed without VITE_SUPABASE_* — there is no permanent link to give.
    setShareState({ kind: "unavailable" });
  }, [activeBranchId, activeWhiteboardId, focusNodeId, isLegacyLink, startHosting, applyPreview, failPreview, withPreviewTimeout]);

  /** 顯示文宣縮圖 / 顯示影片封面 toggle in the share sheet's 連結預覽 block. */
  const setPreviewThumbnail = useCallback(
    (next: boolean) => {
      const current = shareStateRef.current;
      if (current.kind !== "ready") return;
      const { appUrl } = current;
      const seq = ++shareSeq.current;
      setShareState({ ...current, preview: { status: "building" } });
      withPreviewTimeout(
        cloudRef.current.preview.ensure({ versionId: viewRef.current.versionId, showThumbnail: next }),
      )
        .then((preview) => applyPreview(seq, appUrl, preview))
        .catch(() => failPreview(seq, appUrl));
    },
    [applyPreview, failPreview, withPreviewTimeout],
  );

  /**
   * 自訂分享內容 — title, description and cover for the CARD.
   *
   * Note what is NOT here: no `writes.setTitle`, no version write, no upload to
   * `room-assets`. A share is an outward-facing invitation; the room keeps its
   * own name and its own files. That separation is the feature.
   */
  const customizeShare = useCallback(
    (patch: ShareCustomization) => {
      const current = shareStateRef.current;
      if (current.kind !== "ready") return;
      const { appUrl } = current;
      const seq = ++shareSeq.current;
      setShareState({ ...current, preview: { status: "building" } });
      withPreviewTimeout(cloudRef.current.preview.ensure({ versionId: viewRef.current.versionId, patch }))
        .then((preview) => {
          applyPreview(seq, appUrl, preview);
          if (preview && seq === shareSeq.current) showToast("分享內容已更新", { tone: "success" });
        })
        .catch(() => {
          failPreview(seq, appUrl);
          showToast("這次沒能更新分享內容，請再試一次。", { tone: "error" });
        });
    },
    [applyPreview, failPreview, showToast, withPreviewTimeout],
  );

  /** Revoke the current preview id so links already in a chat stop showing the poster. */
  const rotatePreview = useCallback(() => {
    const current = shareStateRef.current;
    if (current.kind !== "ready") return;
    const { appUrl } = current;
    const seq = ++shareSeq.current;
    setShareState({ ...current, preview: { status: "building" } });
    withPreviewTimeout(cloudRef.current.preview.rotate({ versionId: viewRef.current.versionId }))
      .then((preview) => {
        applyPreview(seq, appUrl, preview);
        // A null result means nothing was rotated (no readable version yet), so
        // saying "use the new link" would be a lie — applyPreview already put
        // the sheet back on the plain permanent URL.
        if (preview && seq === shareSeq.current) {
          showToast("已重新產生預覽連結，請改用新的分享連結。", { tone: "success" });
        }
      })
      .catch(() => failPreview(seq, appUrl));
  }, [applyPreview, failPreview, showToast, withPreviewTimeout]);

  const copySummary = useCallback(async () => {
    const current = roomRef.current;
    if (!current) return;
    if (current.comments.length === 0) {
      showToast("還沒有修改點可以複製。", { tone: "error" });
      return;
    }
    const openCount = current.comments.filter((c) => !c.resolved).length;
    const ordered =
      roomMediaType(current) === "video"
        ? [...current.comments].sort((a, b) => anchorStart(a) - anchorStart(b) || a.createdAt - b.createdAt)
        : current.comments;
    const lines = ordered.map((c) => {
      const status = c.resolved ? "已完成" : "待修改";
      const type = c.problemType ?? "修改";
      const priority = c.priority ?? "一般";
      const versionLabel = current.versions.find((v) => v.id === c.versionId)?.label ?? "";
      const suggestion = c.suggestion ? `\n   建議：${c.suggestion}` : "";
      const number = pinNumber(current, c.id);
      // A video note without its timecode cannot be found again; the whole list
      // is only useful if each line points back at a moment.
      const at = anchorLabel(c);
      const where = [versionLabel, at].filter(Boolean).join(" ");
      return `#${String(number).padStart(2, "0")} [${status}] [${priority}] [${type}] ${where}\n   問題：${c.body}${suggestion}`;
    });
    const summary = `${current.title}\n共 ${current.comments.length} 個修改點｜待修改 ${openCount}｜已完成 ${current.comments.length - openCount}\n\n${lines.join("\n\n")}`;
    try {
      await navigator.clipboard.writeText(summary);
      showToast("修改清單已複製", { tone: "success" });
    } catch {
      showToast("複製失敗，請再試一次。", { tone: "error" });
    }
  }, [showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Video rooms have their own Escape ladder (draft → range pick →
      // selection). Running both would cancel two things per press.
      if (roomRef.current && roomMediaType(roomRef.current) === "video") return;
      // 消費掉的 Escape 要標記 defaultPrevented：外層（對稿 overlay／推進
      // 面板）以此判斷這一下已被內層 ladder 用掉，一次只關一件事。
      if (draftPin) { e.preventDefault(); cancelPin(); }
      else if (tool === "region") { e.preventDefault(); setTool("pan"); }
      else if (selectedPinId) { e.preventDefault(); setSelectedPinId(null); }
      else if (previewStrokeId) { e.preventDefault(); setPreviewStrokeId(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draftPin, selectedPinId, previewStrokeId, tool, cancelPin]);

  /** Switching tools always drops a legacy-stroke preview, keeping view mode clean. */
  const setToolAndClear = useCallback((t: Tool) => {
    setTool(t);
    setPreviewStrokeId(null);
  }, []);

  const selectPinAndClear = useCallback((id: string | null) => {
    setSelectedPinId(id);
    setPreviewStrokeId(null);
  }, []);

  /**
   * 影片對稿 2.0 (#32).
   *
   * Every write is fire-and-forget with a user-facing error on failure: a
   * reaction that does not reach the server must not freeze the video, and a
   * verdict that is refused must say so rather than silently look saved.
   */
  const reviewFail = useCallback(
    (what: string) => (err: unknown) => {
      void err;
      showToast(`${what}沒有成功，請再試一次。`, { tone: "error" });
    },
    [showToast],
  );

  const normalizedRoom = room ? normalizeRoomBranches(room) : null;
  const activeBranch = normalizedRoom && activeBranchId ? branchForId(normalizedRoom, activeBranchId) : undefined;
  const reviewRoom = normalizedRoom && activeBranch && (activeBranch.branchType === "poster" || activeBranch.branchType === "video")
    ? roomForBranch(normalizedRoom, activeBranch.id)
    : normalizedRoom;

  const video: VideoApi | null =
    reviewRoom && roomMediaType(reviewRoom) === "video"
      ? {
          upload: videoUpload,
          commitVideoComment,
          refreshVideoUrl,
          review: cloud.review,
          // A local-only room has no membership row and no server to ask, so it
          // behaves like a room you own — same rule the media controls use.
          canManageReview: cloud.canManageMedia,
          // The cloud id, not the local `g_…` guest id: every per-user review
          // row is keyed by auth.uid(), so anything else never matches and
          // "you already said what you think" silently stops being true.
          myUserId: cloud.userId ?? "",
          reviewOnline: cloudSession && Boolean(cloud.boundRoomId),
          saveBrief: (versionId, input) => {
            cloud.reviewApi.saveBrief(versionId, input).catch(reviewFail("作者說明"));
          },
          react: (versionId, time, type) => {
            cloud.reviewApi.react(versionId, time, type).catch(reviewFail("這個反應"));
          },
          setVerdict: (versionId, verdict, note) => {
            cloud.reviewApi.setVerdict(versionId, verdict, note).catch(reviewFail("表態"));
          },
          reportProgress: (versionId, maxWatched, completed) => {
            // Deliberately silent: nobody asked for this, and a failed progress
            // ping is not worth a toast over a playing video.
            cloud.reviewApi.reportProgress(versionId, maxWatched, completed).catch(() => undefined);
          },
          setStatus: (commentId, status) => {
            cloud.reviewApi.setStatus(commentId, status).catch(reviewFail("更新狀態"));
          },
        }
      : null;

  // single 雲端房的房級討論面：掛進工作區自己的聊天位（sheet 的聊天 tab／
  // 桌機側欄／影片討論的第二段），不是 tab 殼。本機/PeerJS 房維持 legacy 聊天。
  const discussionDrawer = room && !room.projectMode && cloud.boundRoomId && guest
    ? (
        <DiscussionDrawer
          room={normalizedRoom ?? room}
          guest={guest}
          userId={cloud.userId ?? guest.id}
          canManage={cloud.canManageMedia}
          messages={room.discussion ?? []}
          legacyMessages={room.messages}
          ghosts={discussionOutbox.ghosts}
          supports={room.discussionSupports ?? []}
          sendStates={discussionOutbox.sendStates}
          onRetry={discussionOutbox.retry}
          onSend={sendDiscussion}
          onSupport={supportDiscussion}
          onAttach={(files) => void sendAttachment(files)}
          attachBusy={attachmentUploading}
          onReject={(reason) => showToast(reason, { tone: "error" })}
          onSendLink={sendLink}
          resolveAssetUrl={resolveAssetUrl}
        />
      )
    : undefined;

  const api: WorkspaceApi | null = reviewRoom
    ? {
        room: reviewRoom,
        view,
        guest: guest!,
        tool,
        draftPin,
        form,
        selectedPinId,
        previewStrokeId,
        chatInput,
        discussionDrawer,
        saveState,
        coachSeen,
        canUndo: undoCount > 0,
        setTool: setToolAndClear,
        setView: updateView,
        setForm: (patch) => setFormState((f) => ({ ...f, ...patch })),
        placePin,
        placeRegion,
        commitPin,
        cancelPin,
        setPreviewStroke: setPreviewStrokeId,
        selectPin: selectPinAndClear,
        toggleResolve,
        addStroke,
        eraseStroke,
        toggleSupport,
        addReply,
        setProposalPref,
        undo: undoLast,
        setChatInput,
        sendChat,
        addFiles,
        setTitle: (title) => {
          if (activeBranchId) {
            updateProjectBranch(activeBranchId, { name: title });
          } else {
            updateRoom((r) => ({ ...r, title }));
            cloudRef.current.writes.setTitle(title);
          }
        },
        copySummary,
        markCoachSeen,
        showToast,
        openShare,
        ai: {
          assets: assetIntelligence?.assets ?? [],
          open: openAi,
          focusTarget: aiFocus,
        },
        openAtSeconds,
        ...(video ? { video } : {}),
        goHome: () => {
          videoCancelRef.current?.();
          setVideoUpload({ state: "idle" });
          setSelectedPinId(null);
          setPreviewStrokeId(null);
          if (activeBranchId && roomRef.current) {
            setActiveBranchId(null);
            setLoadingBranchId(null);
            setOpenAtSeconds(undefined);
            setView(initialView(roomRef.current));
          } else if (roomRef.current?.projectMode) {
            // 專案房裡 goHome 只能是「收合對稿 overlay」；離開房間唯一的
            // 出口是殼 header 的 onGoHome，避免同一顆按鈕雙重語意。
          } else {
            clearUndo();
            setRoom(null);
            location.hash = "";
          }
        },
      }
    : null;

  if (!guest) {
    return (
      <div className="onboard">
        <div className="onboard-card">
          <h1 className="onboard-title">文宣討論區</h1>
          <p className="onboard-hint">
            {isGuestSession
              ? "夥伴邀你一起看文宣。點畫面上要調整的位置，留下你的意見就好。"
              : "把文宣傳給夥伴，直接在畫面上指出哪裡需要調整。"}
          </p>
          <input
            className="text-input"
            placeholder="你的名字"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && confirmName()}
            autoFocus
            enterKeyHint="go"
          />
          <button className="btn btn-primary btn-block" onClick={confirmName} disabled={!nameInput.trim()}>
            {isGuestSession ? "進入討論" : "開始"}
          </button>
        </div>
      </div>
    );
  }

  const boardEditors = collectBoardEditors(
    room?.whiteboardNodes ?? [],
    { id: cloud.userId ?? guest?.id ?? "local", name: guest?.name ?? "我" },
    { whiteboardId: activeWhiteboardId ?? undefined },
  ).map((editor) => ({
    ...editor,
    whiteboardTitle: room?.whiteboards?.find((board) => board.id === (editor.whiteboardId ?? activeWhiteboardId))?.title,
  }));

  const projectApi: MultiBranchRoomApi | null = room?.projectMode
    ? {
        room: normalizedRoom ?? room,
        guest,
        role: cloud.role,
        userId: cloud.userId,
        canManage: cloud.boundRoomId ? cloud.canManageMedia : true,
        activeBranchId,
        loadingBranchId,
        onOpenBranch: (branchId, opts) => {
          const target = roomRef.current ? branchForId(roomRef.current, branchId) : undefined;
          if (!target) return;
          setActiveBranchId(branchId);
          setOpenAtSeconds(opts?.startTime);
          if (target.branchType === "poster" || target.branchType === "video") {
            setView(initialView(roomForBranch(roomRef.current!, branchId)));
          }
          if (cloudRef.current.boundRoomId) {
            setLoadingBranchId(branchId);
            void cloudRef.current.loadBranch(branchId).finally(() => {
              setLoadingBranchId((current) => (current === branchId ? null : current));
            });
          }
        },
        onBackToRoom: () => {
          setActiveBranchId(null);
          setLoadingBranchId(null);
          setOpenAtSeconds(undefined);
          if (roomRef.current) setView(initialView(roomRef.current));
        },
        onCreateContent: createProjectContent,
        onAddFiles: addFilesToBranch,
        onUpdateBranch: updateProjectBranch,
        onSavePlan: saveProjectPlan,
        onCreateRelation: createProjectRelation,
        onDeleteRelation: deleteProjectRelation,
        onCreatePoll: createProjectPoll,
        onVotePoll: voteProjectPoll,
        chatInput,
        setChatInput,
        sendChat: () => sendDiscussion(),
        onSendDiscussion: sendDiscussion,
        onSupportDiscussion: supportDiscussion,
        onCreateWhiteboard: createWhiteboard,
        onArchiveWhiteboard: archiveWhiteboard,
        onOpenWhiteboard: (id) => {
          setActiveWhiteboardId(id);
          if (!id) setFocusNodeId(null);
          if (!id) return;
          void cloudRef.current.loadWhiteboard?.(id);
          void loadBoardSnapshot(id).then((snap) => {
            if (!snap) return;
            setRoom((current) => {
              if (!current) return current;
              const existing = (current.whiteboardNodes ?? []).filter((node) => node.whiteboardId === id);
              if (existing.length) {
                return {
                  ...current,
                  whiteboardNodes: reconcileNodes(existing, snap.nodes, []),
                };
              }
              return {
                ...current,
                whiteboardNodes: [...(current.whiteboardNodes ?? []), ...snap.nodes],
                whiteboardEdges: [
                  ...(current.whiteboardEdges ?? []).filter((edge) => edge.whiteboardId !== id),
                  ...snap.edges,
                ],
              };
            });
          });
        },
        onFocusNode: setFocusNodeId,
        onUpsertNode: upsertNode,
        onUpsertNodes: upsertNodes,
        onDeleteNode: deleteNode,
        onCreateEdge: createEdge,
        onShareNodeToDiscussion: shareNodeToDiscussion,
        onAddMessageToBoard: addMessageToBoard,
        onCreateDecision: createDecision,
        onFinalizeDecision: finalizeDecision,
        onToggleAllowBoardEdit: toggleAllowBoardEdit,
        activeWhiteboardId,
        focusNodeId,
        online: cloud.online || peerCount,
        editors: boardEditors,
        onShare: openShare,
        onOpenAi: openAi,
        onGoHome: () => {
          clearUndo();
          setActiveBranchId(null);
          setLoadingBranchId(null);
          setRoom(null);
          location.hash = "";
        },
      }
    : null;

  const activeProjectBranch = normalizedRoom && activeBranchId ? branchForId(normalizedRoom, activeBranchId) : undefined;
  if (projectApi) {
    // poster/video 且已有版本 → 對稿工作區以 overlay 疊在討論殼上；
    // 殼永遠掛著（不再整棵樹替換），返回時殼內狀態原封不動。
    const overlayBranch =
      activeProjectBranch &&
      activeProjectBranch.branchType !== "plan" &&
      activeProjectBranch.branchType !== "copy" &&
      branchVersions(normalizedRoom!, activeProjectBranch.id).length > 0 &&
      api
        ? activeProjectBranch
        : undefined;
    const branchWorkspace = overlayBranch
      ? {
          branchId: overlayBranch.id,
          node: (
            <RoomWorkspace
              api={api!}
              presence={{
                status: cloudSession ? syncToPresence(cloud.status) : collabStatus,
                peers: cloudSession ? cloud.online : peerCount,
              }}
              cloud={cloudSession ? { status: cloud.status, online: cloud.online } : null}
            />
          ),
        }
      : null;
    return (
      <>
        <MultiBranchRoom api={{
          ...projectApi,
          workspace: branchWorkspace,
          discussionGhosts: discussionOutbox.ghosts,
          discussionSendStates: discussionOutbox.sendStates,
          onRetryDiscussion: discussionOutbox.retry,
          onAttachDiscussion: (files) => void sendAttachment(files),
          attachBusy: attachmentUploading,
          onIntakeReject: (reason) => showToast(reason, { tone: "error" }),
          onSendDiscussionLink: sendLink,
          resolveAssetUrl,
        }} />
        {isCloudConfigured && !branchWorkspace && <AssetAiFab project onClick={() => openAi()} />}
        {aiSheetOpen && room && <RoomAiSheet
          roomTitle={room.title}
          assets={assetIntelligence?.assets ?? []}
          jobs={assetIntelligence?.jobs ?? []}
          selectedAssetIds={aiSelectedAssetIds}
          response={aiResponse}
          loading={aiLoading}
          error={aiError}
          onAsk={askAi}
          onClose={() => setAiSheetOpen(false)}
          onFocus={(citation) => citation.assetId && focusAi({ assetId: citation.assetId, branchId: citation.branchId, versionId: citation.versionId, locator: citation.locator })}
          onRetryAnalysis={retryAi}
          onUpdatePolicy={updateAiPolicy}
          onUpdateHumanMetadata={updateHumanMetadata}
          onApplyProposal={applyAiProposal}
          canManage={cloud.canManageMedia}
        />}
        {/* 分享單以前只掛在對稿樹上；殼的「分享」按鈕 setShareOpen 之後
            沒人渲染。抬到兩條路徑共用（Grok pr00 review 的 ShareSheet lift）。 */}
        {shareOpen && room && (
          <ShareSheet
            presentation={sharePresentation(roomMediaType(reviewRoom ?? room), (reviewRoom ?? room).title)}
            state={shareState}
            onRetry={openShare}
            onClose={() => setShareOpen(false)}
            onToast={showToast}
            onPreviewThumbnail={setPreviewThumbnail}
            onRotatePreview={rotatePreview}
            onCustomize={customizeShare}
          />
        )}
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  const hasVersions = (room?.versions.length ?? 0) > 0;
  const uploadingFirstVideo = Boolean(room) && roomMediaType(room!) === "video" && videoUpload.state !== "idle";

  if (!hasVersions && uploadingFirstVideo) {
    const pct = Math.round((videoUpload.state === "error" ? 0 : videoUpload.progress) * 100);
    const failed = videoUpload.state === "error";
    return (
      <div className="onboard">
        <div className="onboard-card">
          <h1 className="onboard-title">影片對稿</h1>
          <p className="onboard-hint">
            {videoUpload.state === "uploading"
              ? `正在上傳影片 ${pct}%`
              : videoUpload.state === "processing"
                ? "正在處理影片…"
                : videoUpload.state === "error"
                  ? videoUpload.message
                  : "正在準備影片…"}
          </p>
          {videoUpload.state === "uploading" && (
            <span className="v-upload-bar" aria-hidden>
              <span className="v-upload-fill" style={{ width: `${pct}%` }} />
            </span>
          )}
          <p className="onboard-note">
            {failed
              ? "影片沒有上傳成功。可以再選一次檔案，房間和分享連結會沿用這一間。"
              : "影片會直接存進雲端，夥伴用連結就能打開，你不用一直開著頁面。"}
          </p>
          {failed ? (
            <>
              <UniversalIntake
                profile="video"
                mode="zone"
                onFiles={addVideoFile}
                className="btn btn-primary btn-block"
              >
                重新選一支影片
              </UniversalIntake>
              <button className="btn btn-block" onClick={abandonEmptyVideoRoom}>
                回首頁
              </button>
            </>
          ) : (
            <button className="btn btn-block" onClick={videoUpload.cancel}>
              取消
            </button>
          )}
        </div>
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  if (!hasVersions) {
    if (isGuestSession) {
      // Cloud serves invite links; legacy #room=<6碼> links ride the peer channel.
      const cloudGuest = cloudSession && roomLink.kind === "cloud";
      const stalled = cloudGuest
        ? cloud.status === "error"
        : collabStatus === "waiting" || collabStatus === "error";
      const badLink = cloudGuest && cloud.inviteInvalid;
      /**
       * A legacy link with the host offline can never load: there is no cloud
       * room behind it and no local mapping to upgrade it with. Say that once
       * instead of looping a generic retry the partner cannot win.
       */
      const legacyStalled = isLegacyLink && stalled;
      return (
        <div className="onboard">
          <div className="onboard-card">
            {/* The link does not say what is behind it, so the title stays the
                neutral one rather than promising a poster. */}
            <h1 className="onboard-title">對稿討論區</h1>
            <p className="onboard-hint">
              {!stalled
                ? "正在載入…"
                : legacyStalled
                  ? "這是舊版分享連結"
                  : badLink
                    ? "分享連結無效或已失效"
                    : "目前暫時無法載入這個討論，請稍後再試。"}
            </p>
            {stalled && (
              <>
                <p className="onboard-note">
                  {legacyStalled
                    ? "舊版連結需要主辦方保持頁面開著才打得開。請向主辦方取得新版分享連結，新版連結在主辦方關掉頁面後也能打開。"
                    : badLink
                      ? "請向分享的人要一個新的連結。"
                      : "可能是網路不太穩，會自動重試；稍後再打開這個連結也可以。"}
                </p>
                {legacyStalled ? (
                  <button className="btn btn-block" onClick={() => collabRef.current?.retryNow()}>
                    主辦方在線的話，再試一次
                  </button>
                ) : (
                  !badLink && (
                    <button
                      className="btn btn-primary btn-block"
                      onClick={() => {
                        if (cloudGuest) cloudRef.current.retry();
                        else collabRef.current?.retryNow();
                      }}
                    >
                      再試一次
                    </button>
                  )
                )}
              </>
            )}
          </div>
          <ToastStack toasts={toasts} onDismiss={dismiss} />
        </div>
      );
    }
    return (
      <div className="app">
        <Home
          recent={recent}
          isGuestSession={isGuestSession}
          onFiles={addImageFiles}
          onVideoFiles={addVideoFile}
          videoAvailable={isCloudConfigured}
          onOpen={openRoom}
          onCreateProject={createProjectRoom}
        />
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  return (
    <>
      <RoomWorkspace
        api={api!}
        presence={{
          status: cloudSession ? syncToPresence(cloud.status) : collabStatus,
          peers: cloudSession ? cloud.online : peerCount,
        }}
        cloud={cloudSession ? { status: cloud.status, online: cloud.online } : null}
      />

      {isCloudConfigured && <AssetAiFab onClick={() => openAi()} />}
      {aiSheetOpen && room && <RoomAiSheet
        roomTitle={room.title}
        assets={assetIntelligence?.assets ?? []}
        jobs={assetIntelligence?.jobs ?? []}
        selectedAssetIds={aiSelectedAssetIds}
        response={aiResponse}
        loading={aiLoading}
        error={aiError}
        onAsk={askAi}
        onClose={() => setAiSheetOpen(false)}
        onFocus={(citation) => citation.assetId && focusAi({ assetId: citation.assetId, branchId: citation.branchId, versionId: citation.versionId, locator: citation.locator })}
        onRetryAnalysis={retryAi}
        onUpdatePolicy={updateAiPolicy}
        onUpdateHumanMetadata={updateHumanMetadata}
        onApplyProposal={applyAiProposal}
        canManage={cloud.canManageMedia}
      />}

      {shareOpen && room && (
        <ShareSheet
          presentation={sharePresentation(roomMediaType(reviewRoom ?? room), (reviewRoom ?? room).title)}
          state={shareState}
          onRetry={openShare}
          onClose={() => setShareOpen(false)}
          onToast={showToast}
          onPreviewThumbnail={setPreviewThumbnail}
          onRotatePreview={rotatePreview}
          onCustomize={customizeShare}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
