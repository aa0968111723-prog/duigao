import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { roomPresenceLabel } from "../../cloud/realtimeHonesty";
import { historyLayers } from "../../lib/historyLayers";
import { useIsTabletUp } from "../../hooks/useIsTabletUp";
import { emptyPlan, shouldAdoptRemotePlan } from "./planDraft";
import type {
  BranchStatus,
  BranchType,
  ContentRelation,
  Guest,
  PlanBlock,
  PlanDocument,
  PollVote,
  Room,
  RoomBranch,
  RoomPoll,
} from "../../lib/types";
import type {
  DiscussionMessage,
  PresenceEditor,
  WhiteboardEdge,
  WhiteboardNode,
} from "../collaboration/types";
import { RoomDiscussion } from "../room-discussion/RoomDiscussion";
import { WhiteboardWorkspace } from "../whiteboard/WhiteboardWorkspace";
import { ScheduleAgenda } from "../schedule/ScheduleAgenda";
import { sourceOpenTarget } from "../schedule/links";
import { uuid } from "../../lib/id";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useViewport } from "../../hooks/useViewport";
import {
  BRANCH_STATUSES,
  BRANCH_TYPES,
  branchOpenCommentCount,
  branchSummary,
  branchStatusLabel,
  branchTypeLabel,
  branchVersions,
  latestBranchVersion,
  normalizeRoomBranches,
  sortBranchesByRecent,
} from "../../lib/roomBranches";
import type { RoomRole } from "../../cloud/roomRepository";
import type { VideoUploadState } from "../../components/api";
import { UniversalIntake } from "../../components/UniversalIntake";
import { BrandMark } from "../../components/BrandMark";
import { firstLayerChrome } from "./roomChrome";

export type MultiBranchRoomApi = {
  room: Room;
  guest: Guest;
  role: RoomRole | null;
  userId?: string | null;
  canManage: boolean;
  activeBranchId: string | null;
  onOpenBranch: (branchId: string, opts?: { startTime?: number; endTime?: number; region?: import("../../lib/types").AnnotationRegion; versionId?: string; planSectionId?: string }) => void;
  loadingBranchId?: string | null;
  onBackToRoom: () => void;
  onCreateContent: (type: BranchType, name: string, files: FileList | null) => void;
  /** 語音房（PR-03）。undefined/available=false → 討論殼顯示誠實文案。 */
  voice?: import("../../hooks/useVoiceRoom").VoiceDockApi;
  /**
   * CUTOS 成品匯入（PR-07 第一階段）。undefined＝不可用（未設定/健檢
   * 失敗），整個入口不渲染 — 誠實不可用，不是灰掉的按鈕。
   */
  cutosImport?: (cutosProjectId: string, name: string, retryBranchId?: string) => Promise<{ ok: boolean; message: string; branchId?: string }>;
  /**
   * Canva 文宣匯入（PR-05 第一階段）。undefined＝不可用（未設定/健檢
   * 失敗），入口不渲染。連結狀態與清單都問 bridge，token 不進瀏覽器。
   */
  canva?: {
    status: () => Promise<boolean>;
    connectUrl: () => Promise<string | null>;
    listDesigns: () => Promise<import("../../lib/canvaContract").CanvaBridgeDesignList>;
    importDesign: (designId: string, name: string, retryBranchId?: string) => Promise<{ ok: boolean; message: string; branchId?: string }>;
  };
  onAddFiles: (branchId: string, files: FileList | null) => void;
  /**
   * 影片上傳狀態。活動房以前拿不到它 — App 的上傳進度畫面排在這個殼的
   * return 之後，專案房永遠走不到，所以選完檔案畫面完全沒反應（上傳其實
   * 正在跑）。殼自己負責把它畫出來。
   */
  upload?: VideoUploadState;
  onUpdateBranch: (branchId: string, patch: Partial<Pick<RoomBranch, "name" | "sortOrder" | "status">>) => void;
  onSavePlan: (plan: PlanDocument) => void;
  onCreateRelation: (relation: ContentRelation) => void;
  onDeleteRelation: (relationId: string) => void;
  onCreatePoll: (poll: RoomPoll) => void;
  onVotePoll: (vote: PollVote) => void;
  chatInput: string;
  setChatInput: (value: string) => void;
  sendChat: () => void;
  onSendDiscussion: (input?: { body?: string; kind?: DiscussionMessage["kind"]; payload?: DiscussionMessage["payload"]; replyToId?: string }) => void;
  onSupportDiscussion: (messageId: string, add: boolean) => void;
  onEditDiscussion?: (messageId: string, body: string) => void;
  onTombstoneDiscussion?: (messageId: string) => void;
  discussionRead?: { lastReadMessageId?: string; lastReadAt?: number } | null;
  onMarkDiscussionRead?: (messageId: string) => void;
  onCreateWhiteboard: (title: string) => void;
  onArchiveWhiteboard: (id: string) => void;
  onOpenWhiteboard: (id: string | null) => void;
  /** WB02：frames／op 入帳／focus 通知（App 據此抑制 AssetAiFab）。 */
  whiteboardFrames?: import("../collaboration/types").WhiteboardFrame[];
  onCreateFrame?: (frame: import("../collaboration/types").WhiteboardFrame) => void;
  onUpdateFrame?: (frame: import("../collaboration/types").WhiteboardFrame) => void;
  onDeleteFrame?: (id: string) => void;
  onEmitOperation?: (draft: import("../collaboration/operations").OperationDraft) => void;
  onBoardFocusChange?: (focused: boolean) => void;
  onRenameWhiteboard?: (id: string, title: string) => void;
  onUpsertNode: (node: WhiteboardNode, persist?: "now" | "end") => void;
  onUpsertNodes: (nodes: WhiteboardNode[]) => void;
  onDeleteNode: (id: string) => void;
  onCreateEdge: (edge: WhiteboardEdge) => void;
  onShareNodeToDiscussion: (node: WhiteboardNode) => void;
  onAddMessageToBoard: (message: DiscussionMessage, whiteboardId: string) => void;
  onAddMessageToSchedule?: (message: DiscussionMessage) => void;
  onUpsertScheduleEvent?: (event: import("../schedule/types").ScheduleEvent) => void;
  onDeleteScheduleEvent?: (id: string) => void;
  onNodeDeadline?: (node: WhiteboardNode, startAt: number) => void;
  onOpenScheduleSource?: (event: import("../schedule/types").ScheduleEvent) => void;
  onCreateDecision: (title: string, source?: { type: "poll"; id: string }, status?: "pending" | "decided") => void;
  onFocusNode?: (nodeId: string | null) => void;
  onFinalizeDecision: (id: string) => void;
  onToggleAllowBoardEdit: () => void;
  activeWhiteboardId: string | null;
  focusNodeId: string | null;
  online: number;
  /** Room channel joined. Presence chrome must not claim 在線 before this. */
  realtimeJoined?: boolean;
  editors: PresenceEditor[];
  /** WB04：開著同一塊板的其他人（具名在場，無游標）。 */
  boardPeople?: { userId: string; name: string }[];
  onFrameDragState?: (id: string | null) => void;
  onSnapshotBoard?: (label: string) => Promise<void>;
  onListVersions?: () => Promise<import("../whiteboard/versions").BoardVersionSummary[]>;
  onLoadVersion?: (versionId: string) => Promise<{ snapshot: import("../whiteboard/versions").BoardSnapshot; dropped: number }>;
  onRestoreVersion?: (snapshot: import("../whiteboard/versions").BoardSnapshot) => Promise<{ applied: number; queued: boolean }>;
  onAskBoardAi?: (
    question: string,
    context: {
      nodes: import("../collaboration/types").WhiteboardNode[];
      selectedIds: string[];
      centerWorld: { x: number; y: number };
    },
  ) => Promise<import("../whiteboard/aiPreview").BoardAiPreview>;
  stagedAiPreview?: import("../whiteboard/aiPreview").BoardAiPreview | null;
  onConsumeStagedAiPreview?: () => void;
  onApplyBoardAi?: (
    plan: { nodes: import("../collaboration/types").WhiteboardNode[]; edges: import("../collaboration/types").WhiteboardEdge[] },
    preview: import("../whiteboard/aiPreview").BoardAiPreview,
  ) => Promise<{ applied: number; snapshotTaken: boolean }>;
  onShare: () => void;
  /** 改房間名字。刻意與 setTitle 分開：setTitle 在有 activeBranchId 時改的是分支名。 */
  onRenameRoom: (title: string) => void;
  onOpenAi: (assetId?: string) => void;
  onGoHome: () => void;
  /**
   * 疊在討論殼上的對稿工作區（poster/video 有版本時由 App 建好傳入）。
   * 殼在 overlay 底下持續掛著，返回時所有殼內狀態都還在。
   */
  workspace?: { node: ReactNode; branchId: string } | null;
  /** 樂觀送出但尚未落到快照的討論訊息（outbox ghosts）。 */
  discussionGhosts?: DiscussionMessage[];
  /** 各訊息送出狀態；配合 onRetryDiscussion 呈現「未送出 · 重試」。 */
  discussionSendStates?: Record<string, "sending" | "failed">;
  onRetryDiscussion?: (messageId: string) => void;
  /** 白板拖曳護盾（PR-02c）：拖曳中節點的遠端增量讓路。 */
  onBoardDragState?: (ids: string[] | null) => void;
  /** 討論附件（PR-01b）；App 持有上傳與簽名。 */
  onAttachDiscussion?: (files: File[]) => void;
  attachBusy?: boolean;
  attachUpload?: import("../../cloud/discussionWrite").DiscussionAttachUpload | null;
  onIntakeReject?: (reason: string) => void;
  onSendDiscussionLink?: (url: string, reply?: { replyToId: string; quotedBody: string }) => boolean;
  resolveAssetUrl?: (path: string) => Promise<string>;
};

/**
 * 上傳狀態列。
 *
 * 存在的理由很單純：在活動房裡按「＋ 加入影片」選完檔案之後，畫面必須有
 * 東西動。上傳本身早就在跑（XHR 有真的 byte 進度），只是沒有人把它畫出來 —
 * 對使用者而言那和「按鈕壞了」完全無法區分，而一支手機拍的影片在行動網路
 * 上要跑好幾十秒。
 *
 * 進度是真的 byte 數，不是假的動畫；瀏覽器算不出總量時就只留一句「正在上傳
 * 影片」，不畫一條會說謊的進度條。
 */
function UploadStatus({ upload }: { upload?: VideoUploadState }) {
  if (!upload || upload.state === "idle") return null;
  const failed = upload.state === "error";
  const pct = Math.round((failed ? 0 : upload.progress) * 100);
  return (
    <div
      className={`project-upload-status${failed ? " is-error" : ""}`}
      role="status"
      aria-live="polite"
      data-testid="project-upload-status"
    >
      <span className="project-upload-status-text">
        {upload.state === "uploading"
          ? `正在上傳影片 ${pct}%`
          : upload.state === "processing"
            ? "正在處理影片…"
            : upload.state === "error"
              ? upload.message
              : "正在準備影片…"}
      </span>
      {upload.state === "uploading" && (
        <span className="project-upload-track" aria-hidden>
          <span className="project-upload-fill" style={{ width: `${pct}%` }} />
        </span>
      )}
      <button type="button" className="project-upload-cancel" onClick={upload.cancel}>
        {failed ? "知道了" : "取消"}
      </button>
    </div>
  );
}

/** 從討論殼「推進去」的次要面板；討論本身是房間的根畫面，不再是並列分頁。 */
type PushedPane = "overview" | "content" | "plan";

const PANE_META: { id: PushedPane; label: string; icon: string }[] = [
  { id: "overview", label: "總覽", icon: "⌂" },
  { id: "content", label: "內容", icon: "▧" },
  { id: "plan", label: "企劃", icon: "☷" },
];

function branchHasType(branch: RoomBranch, type: BranchType): boolean {
  return branch.branchType === type || (type === "plan" && branch.branchType === "copy");
}

function relativeTime(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function countVotes(room: Room, pollId: string): number {
  return (room.pollVotes ?? []).filter((vote) => vote.pollId === pollId).length;
}

function selectedVote(room: Room, pollId: string, userId: string): string | undefined {
  return (room.pollVotes ?? []).find((vote) => vote.pollId === pollId && vote.userId === userId)?.option;
}

function BranchCard({
  room,
  branch,
  onOpen,
  draggable,
  onDrop,
}: {
  room: Room;
  branch: RoomBranch;
  onOpen: () => void;
  draggable?: boolean;
  onDrop?: () => void;
}) {
  const version = latestBranchVersion(room, branch.id);
  const loadedVersions = branchVersions(room, branch.id);
  const summary = branchSummary(room, branch.id);
  const versionCount = loadedVersions.length ? loadedVersions.filter((item) => !item.archivedAt).length : summary.versionCount;
  const openComments = loadedVersions.length ? branchOpenCommentCount(room, branch.id) : summary.openCommentCount;
  const relatedCount = (room.relations ?? []).filter(
    (relation) => relation.fromBranchId === branch.id || relation.toBranchId === branch.id,
  ).length;
  const plan = room.plans?.find((item) => item.branchId === branch.id);
  return (
    <button
      type="button"
      className="project-branch-card"
      data-testid={`branch-card-${branch.id}`}
      draggable={draggable}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onClick={onOpen}
    >
      <span className={`project-branch-icon project-branch-${branch.branchType}`} aria-hidden>
        {branch.branchType === "poster" ? "▧" : branch.branchType === "video" ? "▶" : "☷"}
      </span>
      <span className="project-branch-copy">
        <span className="project-branch-title">{branch.name}</span>
        <span className="project-branch-meta">
          {branch.branchType === "plan" || branch.branchType === "copy"
            ? plan?.title || "尚未開始編輯"
            : version
              ? `${version.label}${versionCount > 1 ? ` · ${versionCount} 版` : ""}`
              : summary.latestLabel
                ? `${summary.latestLabel}${versionCount > 1 ? ` · ${versionCount} 版` : ""}`
              : "尚未加入內容"}
          {openComments > 0 && ` · ${openComments} 則待處理`}
          {relatedCount > 0 && ` · ${relatedCount} 項相關`}
        </span>
      </span>
      <span className={`project-status project-status-${branch.status}`}>{branchStatusLabel(branch.status)}</span>
      <span className="project-branch-chevron" aria-hidden>›</span>
    </button>
  );
}

function EmptyType({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <div className="project-empty-type">
      <p>這裡還沒有{label}</p>
      <button type="button" className="project-text-button" onClick={onAdd}>＋ 加入第一份{label}</button>
    </div>
  );
}

function PollCard({ poll, room, userId, onVote }: { poll: RoomPoll; room: Room; userId: string; onVote: (poll: RoomPoll, option: string) => void }) {
  // Cloud poll votes are keyed by auth.uid(), while a local-only room uses the
  // device guest id. Keep the visual selection in step with the exact key sent
  // by votePoll so a mobile voter sees their choice immediately after a reload.
  const chosen = selectedVote(room, poll.id, userId);
  return (
    <article className="project-poll-card" data-testid={`poll-${poll.id}`}>
      <div className="project-poll-head">
        <strong>{poll.question}</strong>
        <span>{countVotes(room, poll.id)} 人已投</span>
      </div>
      <div className="project-poll-options">
        {poll.options.map((option) => (
          <button
            type="button"
            key={option}
            className={`project-poll-option ${chosen === option ? "is-chosen" : ""}`}
            onClick={() => onVote(poll, option)}
          >
            {option}
            {chosen === option && <span aria-hidden>✓</span>}
          </button>
        ))}
      </div>
    </article>
  );
}

function PlanEditor({
  room,
  branch,
  canManage,
  onSave,
  onCreateRelation,
  onDeleteRelation,
}: {
  room: Room;
  branch: RoomBranch;
  canManage: boolean;
  onSave: (plan: PlanDocument) => void;
  onCreateRelation: (relation: ContentRelation) => void;
  onDeleteRelation: (relationId: string) => void;
}) {
  const saved = useMemo(
    () => room.plans?.find((item) => item.branchId === branch.id) ?? emptyPlan(branch),
    [branch.id, branch.name, room.plans],
  );
  const [draft, setDraftState] = useState<PlanDocument>(saved);
  const [relationTarget, setRelationTarget] = useState("");
  // 「有未存編輯」旗標：所有使用者操作都經 setDraft 立旗，存檔後落旗。
  const dirtyRef = useRef(false);
  const setDraft: typeof setDraftState = (value) => {
    dirtyRef.current = true;
    setDraftState(value);
  };

  // room.plans 的陣列身分每次快照都會變；無條件 reset 會把「打字中、還沒按
  // 完成」的 blocks 洗掉（realtime nudge → branch reload → echo 快照）。
  // 規則：有未存編輯就不接受任何遠端；乾淨時遠端較新才接受。
  useEffect(() => {
    setDraftState((current) => (shouldAdoptRemotePlan(saved, current, dirtyRef.current) ? saved : current));
  }, [saved]);

  const relations = (room.relations ?? []).filter(
    (relation) => relation.fromBranchId === branch.id || relation.toBranchId === branch.id,
  );
  const relatedIds = new Set(
    relations.map((relation) => (relation.fromBranchId === branch.id ? relation.toBranchId : relation.fromBranchId)),
  );
  const relatedBranches = (room.branches ?? []).filter((item) => relatedIds.has(item.id));

  const updateBlock = (id: string, patch: Partial<PlanBlock>) => {
    setDraft((current) => ({
      ...current,
      blocks: current.blocks.map((block) => (block.id === id ? ({ ...block, ...patch } as PlanBlock) : block)),
    }));
  };

  const addBlock = (kind: PlanBlock["kind"]) => {
    const id = uuid();
    const next: PlanBlock = kind === "checklist"
      ? { id, kind, text: "待辦事項", checked: false }
      : kind === "link"
        ? { id, kind, text: "相關連結", url: "https://" }
        : { id, kind, text: kind === "list" ? "條列內容" : "新增段落" };
    setDraft((current) => ({ ...current, blocks: [...current.blocks, next] }));
  };

  return (
    <div className="project-plan-editor" data-testid="plan-editor">
      <label className="project-field">
        <span>標題</span>
        <input value={draft.title} disabled={!canManage} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
      </label>
      <label className="project-field">
        <span>說明</span>
        <textarea
          value={draft.description}
          disabled={!canManage}
          placeholder="這份企劃想完成什麼？"
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <div className="project-blocks">
        {draft.blocks.length === 0 && <p className="project-muted">從底下新增一段內容，手機上保持簡單好改。</p>}
        {draft.blocks.map((block) => (
          <div className={`project-block project-block-${block.kind}`} key={block.id}>
            {block.kind === "checklist" && (
              <input
                type="checkbox"
                checked={block.checked}
                disabled={!canManage}
                onChange={(event) => updateBlock(block.id, { checked: event.target.checked })}
                aria-label="完成項目"
              />
            )}
            <input
              value={block.text}
              disabled={!canManage}
              onChange={(event) => updateBlock(block.id, { text: event.target.value })}
              aria-label={block.kind === "list" ? "條列內容" : block.kind === "link" ? "連結文字" : "段落內容"}
            />
            {block.kind === "link" && (
              <input
                className="project-link-url"
                value={block.url}
                disabled={!canManage}
                onChange={(event) => updateBlock(block.id, { url: event.target.value })}
                aria-label="連結網址"
              />
            )}
            {canManage && (
              <button
                type="button"
                className="project-block-remove"
                aria-label="刪除段落"
                onClick={() => setDraft({ ...draft, blocks: draft.blocks.filter((item) => item.id !== block.id) })}
              >×</button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="project-plan-actions">
          <button type="button" onClick={() => addBlock("paragraph")}>＋段落</button>
          <button type="button" onClick={() => addBlock("list")}>＋清單</button>
          <button type="button" onClick={() => addBlock("checklist")}>＋待辦</button>
          <button type="button" onClick={() => addBlock("link")}>＋連結</button>
          <button type="button" className="project-save-button" onClick={() => {
            const stamped = { ...draft, updatedAt: Date.now() };
            dirtyRef.current = false; // 存了就不再是未存編輯 — 之後可接受別人的新版
            setDraftState(stamped);
            onSave(stamped);
          }}>完成</button>
        </div>
      )}
      <section className="project-related">
        <div className="project-section-title-row"><h3>相關內容</h3><span>{relatedBranches.length} 項</span></div>
        <div className="project-related-list">
          {relatedBranches.map((related) => {
            const relation = relations.find((item) => item.fromBranchId === related.id || item.toBranchId === related.id);
            return (
              <span className="project-related-chip" key={related.id}>
                {branchTypeLabel(related.branchType)} · {related.name}
                {canManage && relation && <button type="button" onClick={() => onDeleteRelation(relation.id)} aria-label={`移除${related.name}`}>×</button>}
              </span>
            );
          })}
        </div>
        {canManage && (room.branches ?? []).some((item) => item.id !== branch.id && !relatedIds.has(item.id)) && (
          <div className="project-related-add">
            <select value={relationTarget} onChange={(event) => setRelationTarget(event.target.value)} aria-label="選擇相關內容">
              <option value="">加入相關內容</option>
              {(room.branches ?? []).filter((item) => item.id !== branch.id && !relatedIds.has(item.id)).map((item) => (
                <option value={item.id} key={item.id}>{item.name}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!relationTarget}
              onClick={() => {
                if (!relationTarget) return;
                onCreateRelation({
                  id: uuid(),
                  roomId: room.id,
                  fromBranchId: branch.id,
                  toBranchId: relationTarget,
                  relationType: "related",
                  createdBy: "local",
                  createdAt: Date.now(),
                });
                setRelationTarget("");
              }}
            >加入</button>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Canva 匯入面板（PR-05）：未連結→官方授權頁開新分頁；已連結→挑設計匯入。
 * 失敗留在原地把話說清楚；重試沿用同一條分支（與 CUTOS 同紀律，Grok 07 F4）。
 */
function CanvaImportPane({ canva, onBack, onDone }: { canva: NonNullable<MultiBranchRoomApi["canva"]>; onBack: () => void; onDone: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [designs, setDesigns] = useState<import("../../lib/canvaContract").CanvaDesignSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [branchId, setBranchId] = useState<string | undefined>(undefined);
  /** 彈窗被擋時的後路：把授權連結直接顯示成可點的 <a>（Grok 05 F2）。 */
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const loadDesigns = useCallback(() => {
    setDesigns(null);
    setListError(null);
    void canva.listDesigns().then((result) => {
      if (result.ok) setDesigns(result.designs);
      else {
        setDesigns([]);
        setListError(
          result.code === "NOT_CONNECTED"
            ? "Canva 連結已失效，請重新連結。"
            : "拿不到設計清單，請稍後再試。",
        );
        if (result.code === "NOT_CONNECTED") setConnected(false);
      }
    });
  }, [canva]);

  const checkStatus = useCallback(() => {
    setConnected(null);
    void canva.status().then((ok) => {
      setConnected(ok);
      if (ok) loadDesigns();
    });
  }, [canva, loadDesigns]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  if (connected === null) {
    return (
      <div>
        <button type="button" className="project-sheet-back" onClick={onBack}>‹ 返回</button>
        <h2>從 Canva 匯入</h2>
        <p className="project-sheet-note">確認 Canva 連結狀態…</p>
      </div>
    );
  }

  if (!connected) {
    return (
      <div>
        <button type="button" className="project-sheet-back" onClick={onBack}>‹ 返回</button>
        <h2>從 Canva 匯入</h2>
        <p className="project-sheet-note">先把你的 Canva 帳號連結進來（會開 Canva 官方授權頁，這裡不會經手你的密碼）。授權完成回到這裡按「我連好了」。</p>
        <button
          type="button"
          className="project-save-button project-submit"
          data-testid="canva-connect"
          onClick={() => {
            // 彈窗要在 user gesture 的同步棧裡開（await 之後才 open 會被
            // Chrome/Safari 擋 — Grok 05 F2）：先開空白分頁，拿到 URL 再導。
            const popup = window.open("", "_blank");
            setMessage(null);
            setFallbackUrl(null);
            void canva.connectUrl().then((url) => {
              if (!url) {
                popup?.close();
                setMessage("拿不到授權連結，請稍後再試。");
                return;
              }
              if (popup && !popup.closed) {
                popup.location.href = url;
              } else {
                // 被彈窗攔截：退成可點的連結，一定開得起來。
                setFallbackUrl(url);
              }
            });
          }}
        >
          連結 Canva 帳號
        </button>
        {fallbackUrl && (
          <p className="project-sheet-note">
            瀏覽器擋了新視窗 —{" "}
            <a href={fallbackUrl} target="_blank" rel="noreferrer noopener" data-testid="canva-connect-fallback">點這裡開 Canva 授權頁</a>
          </p>
        )}
        <button type="button" className="project-text-button" data-testid="canva-recheck" onClick={checkStatus}>我連好了，重新檢查</button>
        {message && <p className="project-sheet-error" role="alert">{message}</p>}
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!selectedId || !name.trim() || busy) return;
        setBusy(true);
        setMessage(null);
        void canva.importDesign(selectedId, name.trim(), branchId).then((outcome) => {
          setBusy(false);
          if (outcome.ok) onDone();
          else {
            setMessage(outcome.message); // 失敗留在原地，話說清楚
            setBranchId(outcome.branchId); // 重試沿用，不增生分支
          }
        });
      }}
    >
      <button type="button" className="project-sheet-back" onClick={onBack}>‹ 返回</button>
      <h2>從 Canva 匯入</h2>
      <p className="project-sheet-note">挑一份設計，匯出成圖片放進這間房。Canva 上的原稿不會被改動。</p>
      {designs === null ? (
        <p className="project-sheet-note">載入設計清單…</p>
      ) : designs.length === 0 ? (
        <p className="project-sheet-note">{listError ?? "你的 Canva 帳號還沒有設計。"}</p>
      ) : (
        <div className="project-create-options canva-design-list" role="radiogroup" aria-label="選擇設計">
          {designs.map((design) => (
            <button
              type="button"
              key={design.id}
              data-testid="canva-design-item"
              aria-pressed={selectedId === design.id}
              className={selectedId === design.id ? "canva-design-selected" : undefined}
              onClick={() => {
                setSelectedId(design.id);
                if (!name.trim()) setName(design.title);
              }}
            >
              {design.thumbnailUrl ? <img src={design.thumbnailUrl} alt="" width={48} height={36} loading="lazy" /> : <span aria-hidden>▤</span>}
              {design.title}
            </button>
          ))}
        </div>
      )}
      <label className="project-field"><span>名稱</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：招生海報 9 月版" /></label>
      {message && <p className="project-sheet-error" role="alert">{message}</p>}
      <button type="submit" className="project-save-button project-submit" data-testid="canva-import-submit" disabled={!selectedId || !name.trim() || busy}>{busy ? "匯入中…" : "匯入"}</button>
    </form>
  );
}

function CreateSheet({ onClose, onCreate, onCutosImport, canva, initialType, onReject }: { onClose: () => void; onCreate: MultiBranchRoomApi["onCreateContent"]; onCutosImport?: MultiBranchRoomApi["cutosImport"]; canva?: MultiBranchRoomApi["canva"]; initialType?: BranchType; onReject?: (reason: string) => void }) {
  const [type, setType] = useState<BranchType | "cutos" | "canva" | null>(initialType ?? null);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [cutosProjectId, setCutosProjectId] = useState("");
  const [cutosBusy, setCutosBusy] = useState(false);
  const [cutosMessage, setCutosMessage] = useState<string | null>(null);
  // 失敗後重試沿用同一條分支（Grok 07 F4）
  const [cutosBranchId, setCutosBranchId] = useState<string | undefined>(undefined);
  const needsFile = type === "poster" || type === "video";
  return (
    <div className="project-scrim" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="project-sheet" role="dialog" aria-modal="true" aria-label="新增內容" data-testid="create-content-sheet">
        <div className="project-sheet-grip" aria-hidden />
        {!type ? (
          <>
            <h2>你要新增什麼？</h2>
            <div className="project-create-options">
              {(["poster", "video", "plan", "copy"] as BranchType[]).map((item) => (
                <button type="button" key={item} onClick={() => setType(item)}>
                  <span aria-hidden>{item === "poster" ? "▧" : item === "video" ? "▶" : "☷"}</span>
                  {item === "copy" ? "企劃 / 文案" : branchTypeLabel(item)}
                </button>
              ))}
              {onCutosImport && (
                <button type="button" data-testid="cutos-import-option" onClick={() => setType("cutos")}>
                  <span aria-hidden>⇩</span>
                  CUTOS 影片成品
                </button>
              )}
              {canva && (
                <button type="button" data-testid="canva-import-option" onClick={() => setType("canva")}>
                  <span aria-hidden>▤</span>
                  Canva 文宣
                </button>
              )}
            </div>
          </>
        ) : (
          type === "canva" ? (
            canva ? <CanvaImportPane canva={canva} onBack={() => setType(null)} onDone={onClose} /> : null
          ) : type === "cutos" ? (
          <form onSubmit={(event) => {
            event.preventDefault();
            if (!onCutosImport || !name.trim() || !cutosProjectId.trim() || cutosBusy) return;
            setCutosBusy(true);
            setCutosMessage(null);
            void onCutosImport(cutosProjectId.trim(), name.trim(), cutosBranchId).then((outcome) => {
              setCutosBusy(false);
              if (outcome.ok) onClose();
              else {
                setCutosMessage(outcome.message); // 失敗留在原地，話說清楚
                setCutosBranchId(outcome.branchId); // 重試沿用，不增生分支
              }
            });
          }}>
            <button type="button" className="project-sheet-back" onClick={() => setType(null)}>‹ 返回</button>
            <h2>匯入 CUTOS 成品</h2>
            <p className="project-sheet-note">把 CUTOS 已渲染的影片成品接進來，成為這裡的新影片內容。原始素材留在 CUTOS，不會被改動。</p>
            <label className="project-field"><span>名稱</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：招生影片 v2" /></label>
            <label className="project-field"><span>CUTOS 專案 ID</span><input value={cutosProjectId} onChange={(event) => setCutosProjectId(event.target.value)} placeholder="在 CUTOS 專案頁複製" data-testid="cutos-project-id" /></label>
            {cutosMessage && <p className="project-sheet-error" role="alert">{cutosMessage}</p>}
            <button type="submit" className="project-save-button project-submit" disabled={!name.trim() || !cutosProjectId.trim() || cutosBusy}>{cutosBusy ? "匯入中…" : "匯入"}</button>
          </form>
          ) : (
          <form onSubmit={(event) => { event.preventDefault(); if (name.trim() && (!needsFile || files?.length)) { onCreate(type, name.trim(), files); onClose(); } }}>
            <button type="button" className="project-sheet-back" onClick={() => setType(null)}>‹ 返回</button>
            <h2>新增{type === "copy" ? "文案" : branchTypeLabel(type)}</h2>
            <label className="project-field"><span>名稱</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={type === "poster" ? "例如：擺攤文宣" : type === "video" ? "例如：招生影片" : "例如：擺攤計畫"} /></label>
            {needsFile && (
              <UniversalIntake profile={type === "poster" ? "poster" : "video"} mode="zone" className="project-file-picker" onFiles={setFiles} onReject={onReject}>
                <span>{files?.[0]?.name ?? (type === "poster" ? "選一張圖片" : "選一支影片")}</span>
              </UniversalIntake>
            )}
            <button type="submit" className="project-save-button project-submit" disabled={!name.trim() || (needsFile && !files?.length)}>建立</button>
          </form>
          )
        )}
        <button type="button" className="project-sheet-close" onClick={onClose}>取消</button>
      </section>
    </div>
  );
}

function PollSheet({ onClose, onCreate }: { onClose: () => void; onCreate: (question: string, options: string[]) => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["選項 A", "選項 B"]);
  return (
    <div className="project-scrim" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <form className="project-sheet" role="dialog" aria-modal="true" aria-label="新增待決策" onSubmit={(event) => { event.preventDefault(); const clean = options.map((item) => item.trim()).filter(Boolean); if (question.trim() && clean.length >= 2) { onCreate(question.trim(), clean); onClose(); } }}>
        <div className="project-sheet-grip" aria-hidden />
        <h2>新增待決策</h2>
        <label className="project-field"><span>問題</span><input autoFocus value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：這週先主推茶會還是演講？" /></label>
        {options.map((option, index) => <label className="project-field" key={index}><span>選項 {String.fromCharCode(65 + index)}</span><input value={option} onChange={(event) => setOptions(options.map((item, i) => i === index ? event.target.value : item))} /></label>)}
        {options.length < 4 && <button type="button" className="project-text-button" onClick={() => setOptions([...options, "新選項"])}>＋增加選項</button>}
        <button type="submit" className="project-save-button project-submit" disabled={!question.trim() || options.filter((item) => item.trim()).length < 2}>建立</button>
        <button type="button" className="project-sheet-close" onClick={onClose}>取消</button>
      </form>
    </div>
  );
}

export function MultiBranchRoom({ api }: { api: MultiBranchRoomApi }) {
  const normalized = normalizeRoomBranches(api.room);
  const isMobile = useIsMobile();
  // 討論殼的 composer 是 fixed dock，靠 --kb 騎在鍵盤上；殼自己就是
  // publisher（ref-counted，與 overlay 裡的對稿工作區共存）。
  useViewport();
  // 討論是根畫面；總覽/內容/企劃是可返回的推進面板（Grok pr00 F1/F3）。
  const [pushedPane, setPushedPane] = useState<PushedPane | null>(null);
  // Focus Mode（WB02）：白板全螢幕時抑制 project-fab（條件不渲染，非蓋住）
  const [boardFocused, setBoardFocused] = useState(false);
  // 平板 Split View 的討論側欄是否收起（手機用不到 — CSS 斷點控制顯示）
  const [railCollapsed, setRailCollapsed] = useState(false);
  const tabletUp = useIsTabletUp();
  /** 側欄此刻是否真的要掛（與 CSS 斷點同源，避免中間影格與手機多掛一份）。 */
  const railVisible = tabletUp && !railCollapsed;
  const [discussPane, setDiscussPane] = useState<"chat" | "board" | "calendar">(api.activeWhiteboardId ? "board" : "chat");
  const [splitCompanion, setSplitCompanion] = useState<"chat" | "board">("chat");
  // WB03「打開來源訊息」：關板→切對話→捲動到訊息＋1.6s 高亮。訊息元素
  // 可能還沒 render（pane 剛切）— rAF 重試最多 ~1.2s，誠實放棄不假捲。
  const openDiscussionMessage = (messageId: string) => {
    // Split View（平板）：討論就在左邊側欄，關掉白板反而把使用者正在看的
    // 東西收走（自審 N13）。只有手機的「切 tab」語意才需要關板。
    if (!railVisible) {
      api.onOpenWhiteboard(null);
      setDiscussPane("chat");
    }
    const started = performance.now();
    const seek = () => {
      const el = document.querySelector(`[data-testid="discussion-${messageId}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("rd-msg-flash");
        window.setTimeout(() => el.classList.remove("rd-msg-flash"), 1600);
        return;
      }
      if (performance.now() - started < 1200) requestAnimationFrame(seek);
    };
    requestAnimationFrame(seek);
  };
  const [search, setSearch] = useState("");
  const [composerActive, setComposerActive] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreOpenRef = useRef(false);
  moreOpenRef.current = moreOpen;
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 390 : window.innerWidth));
  useEffect(() => {
    const sync = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, []);
  const hideRoomChrome = isMobile && composerActive && !search.trim();
  const chrome = firstLayerChrome({
    moreOpen: moreOpen && !hideRoomChrome,
    width: viewportWidth,
    composerActive: hideRoomChrome,
  });
  const tabletSplit = chrome.tabletSplit;
  const [createOpen, setCreateOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [sortRecent, setSortRecent] = useState(true);
  const [contentKind, setContentKind] = useState<"all" | "poster" | "video">("all");

  const activeBranch = normalized.branches?.find((branch) => branch.id === api.activeBranchId) ?? null;
  // poster/video 有版本時 App 會傳 workspace overlay；殼內的分支詳情頁只
  // 服務 plan/copy 與還沒有版本的分支。
  const inShellBranch = activeBranch && !api.workspace ? activeBranch : null;
  const branches = useMemo(() => {
    const base = normalized.branches ?? [];
    const searched = search.trim().toLowerCase()
      ? base.filter((branch) => branch.name.toLowerCase().includes(search.trim().toLowerCase()))
      : base;
    return sortRecent ? sortBranchesByRecent(searched) : [...searched].sort((a, b) => a.sortOrder - b.sortOrder);
  }, [normalized.branches, search, sortRecent]);

  useEffect(() => {
    // 深連結/白板卡把人帶到某塊白板時，根畫面切到白板 pane；推進面板收合。
    if (api.activeWhiteboardId) {
      setDiscussPane("board");
      setPushedPane(null);
    }
  }, [api.activeWhiteboardId]);

  // WB03 疊加規則 3：對稿 overlay 疊在（可能開著的）白板 Focus 上時，
  // back 先關 overlay — 透過 historyLayers 協調器與白板 focus 層排隊，
  // 不再兩個 popstate listener 互踩（舊 bug：back 退了板、overlay 還在）。
  const workspaceOpen = Boolean(api.workspace);
  const mbrApiRef = useRef(api);
  mbrApiRef.current = api;
  const overlayPoppingRef = useRef(false);
  useEffect(() => {
    if (!workspaceOpen) return;
    const remove = historyLayers().push("content-overlay", () => {
      overlayPoppingRef.current = true;
      mbrApiRef.current.onBackToRoom();
      return "closed";
    });
    return () => {
      remove(overlayPoppingRef.current);
      overlayPoppingRef.current = false;
    };
  }, [workspaceOpen]);

  // 桌機 Escape：對稿 overlay 是最外層的「可返回」，讓工作區自己的
  // ladder（modal/sheet）先吃；事件冒泡到 document 而沒被吃掉才關 overlay。
  // 推進面板同理。
  const moreHistoryOpen = () =>
    typeof history !== "undefined" && Boolean((history.state as { duigaoMore?: boolean } | null)?.duigaoMore);

  const clearMoreHistory = () => {
    if (moreHistoryOpen()) history.replaceState({}, "");
  };

  const closeMoreFromAction = () => {
    clearMoreHistory();
    setMoreOpen(false);
  };

  useEffect(() => {
    if (hideRoomChrome && moreOpen) closeMoreFromAction();
  }, [hideRoomChrome, moreOpen]);

  const toggleMore = () => {
    if (hideRoomChrome) return;
    if (moreOpenRef.current) {
      if (moreHistoryOpen()) {
        history.back();
        return;
      }
      setMoreOpen(false);
      return;
    }
    history.pushState({ duigaoMore: true }, "");
    setMoreOpen(true);
  };

  useEffect(() => {
    const onPop = () => {
      if (moreOpenRef.current) setMoreOpen(false);
      // 不可以在這裡收推進面板：對稿 overlay / 白板 Focus 的
      // historyLayers 程式性關層會 history.back() 吃掉自己那格，那次
      // popstate 不是「使用者要關內容面板」。面板必須跨 overlay 保留。
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!api.workspace && !pushedPane && !moreOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 內層 ladder（pin/draft/modal…）消費時會 preventDefault，但監聽器
      // 執行順序不可靠（document bubble 先於 window bubble）。把判定推遲到
      // 同步派發全部跑完之後，defaultPrevented 才是完整事實 — 一次 Escape
      // 只關一件事（Grok pr01a r2 N2）。
      setTimeout(() => {
        if (event.defaultPrevented) return;
        if (moreOpen) {
          if (moreHistoryOpen()) history.back();
          else setMoreOpen(false);
          return;
        }
        if (api.workspace) api.onBackToRoom();
        else setPushedPane(null);
      }, 0);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [api.workspace, pushedPane, moreOpen, api.onBackToRoom]);

  const openBranch = (branchId: string, opts?: { startTime?: number; endTime?: number; region?: import("../../lib/types").AnnotationRegion; versionId?: string; planSectionId?: string }) => {
    setPushedPane(null); // 分支詳情/對稿 overlay 蓋上來時，推進面板先收合
    api.onOpenBranch(branchId, opts);
  };

  // 討論面板（WB05）：手機是 tab、平板是左側常駐欄 — 同一份 api 兩個
  // 掛載點共用，不複製一份會漂走的設定。
  // 用函式而不是 const：JSX 只在渲染時求值，宣告順序就不受 createPoll /
  // openBranch 這些後面才宣告的相依限制（函式宣告會提升）。
  /**
   * pane 覆寫（WB05）：RoomDiscussion 在 `pane === "board"` 時自己 return
   * null（手機是 tab、同時只有一個）。平板的側欄是**同時**顯示，所以要
   * 明確傳 "chat" — 否則側欄是空的（e2e 抓到）。
   */
  function renderDiscussion(paneOverride?: "chat" | "board") {
    return (
                    <RoomDiscussion api={{
                      room: normalized,
                      guest: api.guest,
                      userId: api.userId ?? api.guest.id,
                      canManage: api.canManage,
                      canTalk: true,
                      messages: (() => {
                        const base = api.room.discussion ?? [];
                        const ids = new Set(base.map((m) => m.id));
                        return [...base, ...(api.discussionGhosts ?? []).filter((m) => !ids.has(m.id))];
                      })(),
                      supports: api.room.discussionSupports ?? [],
                      decisions: api.room.decisions ?? [],
                      boards: api.room.whiteboards ?? [],
                      hideTabs: true,
                      sendStates: api.discussionSendStates,
                      onRetry: api.onRetryDiscussion,
                      onAttach: api.onAttachDiscussion,
                      attachBusy: api.attachBusy,
                      attachUpload: api.attachUpload,
                      onComposerActive: setComposerActive,
                      onReject: api.onIntakeReject,
                      onSendLink: api.onSendDiscussionLink,
                      resolveAssetUrl: api.resolveAssetUrl,
                      voice: api.voice,
                      pane: paneOverride ?? (discussPane === "calendar" ? "chat" : discussPane),
                      draft: api.chatInput,
                      setDraft: api.setChatInput,
                      onSend: (input) => {
                        if (input) api.onSendDiscussion(input);
                        else api.sendChat();
                      },
                      onSupport: api.onSupportDiscussion,
                      onEditMessage: api.onEditDiscussion,
                      onTombstoneMessage: api.onTombstoneDiscussion,
                      readWatermark: api.discussionRead,
                      onMarkRead: api.onMarkDiscussionRead,
                      onCreatePoll: createPoll,
                      onAddToBoard: api.onAddMessageToBoard,
                      onAddToSchedule: api.onAddMessageToSchedule,
                      onOpenBoardNode: (whiteboardId, nodeId) => {
                        setDiscussPane("board");
                        api.onOpenWhiteboard(whiteboardId);
                        api.onFocusNode?.(nodeId ?? null);
                      },
                      onCreateDecision: api.onCreateDecision,
                      onFinalizeDecision: api.onFinalizeDecision,
                      onOpenContent: openBranch,
                    }} />
    );
  }

  const tabBranches = (type: BranchType) => branches.filter((branch) => branchHasType(branch, type) && branch.status !== "archived");
  const [createType, setCreateType] = useState<BranchType | undefined>();
  const openCreate = (type?: BranchType) => {
    setCreateType(type);
    setCreateOpen(true);
  };

  const createContent = (type: BranchType, name: string, files: FileList | null) => api.onCreateContent(type, name, files);

  const createPoll = (question: string, options: string[]) => api.onCreatePoll({
    id: uuid(), roomId: api.room.id, question, options, createdBy: api.guest.id, createdAt: Date.now(), updatedAt: Date.now(),
  });

  const votePoll = (poll: RoomPoll, option: string) => api.onVotePoll({
    pollId: poll.id, roomId: api.room.id, userId: api.userId ?? api.guest.id, option, createdAt: Date.now(),
  });

  // 「還在跑」與「跑完但失敗」要分開：失敗時上傳鎖已經放掉，那顆按鈕必須
  // 立刻能再按一次。
  const uploadState = api.upload?.state ?? "idle";
  const uploadBusy = uploadState !== "idle" && uploadState !== "error";
  const recentComments = [...api.room.comments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);
  const branchNameForVersion = (versionId: string) => {
    const comment = recentComments.find((item) => item.versionId === versionId);
    const version = api.room.versions.find((item) => item.id === versionId);
    const branch = normalized.branches?.find((item) => item.id === comment?.branchId || item.id === version?.branchId);
    return branch?.name ?? "內容";
  };

  return (
    <div
      className={`project-room${tabletSplit ? " is-tablet-split" : ""}`}
      data-testid="multi-branch-room"
      data-room-id={normalized.id}
      data-more-open={moreOpen && !hideRoomChrome ? "true" : "false"}
      data-tablet-split={tabletSplit ? "true" : "false"}
      data-first-layer={!inShellBranch && !pushedPane ? "true" : "false"}
      data-composer-active={hideRoomChrome ? "true" : "false"}
    >
      <header className="project-room-header" data-testid="room-first-layer-top">
        {inShellBranch ? (
          <button type="button" className="project-back-button" onClick={api.onBackToRoom} aria-label="返回">‹</button>
        ) : (
          <button type="button" className="project-home-button" onClick={api.onGoHome} aria-label="返回"><BrandMark compact /></button>
        )}
        <div className="project-room-heading"><span className="project-kicker">對稿・活動房</span>{api.canManage ? <input className="project-room-title-input" value={api.room.title} onChange={(event) => api.onRenameRoom(event.target.value)} placeholder="未命名活動房" aria-label="活動房標題" /> : <h1>{api.room.title}</h1>}</div>
        {!hideRoomChrome && (
          <>
            <span className="project-presence" data-testid="room-presence">{roomPresenceLabel(api.online, Boolean(api.realtimeJoined))}</span>
            <button
              type="button"
              className="project-voice-chip"
              data-testid="room-voice-chip"
              onClick={() => { setDiscussPane("chat"); closeMoreFromAction(); }}
            >
              語音
            </button>
            <button
              type="button"
              className="project-room-more-btn"
              data-testid="room-more"
              aria-label="更多"
              aria-expanded={moreOpen}
              onClick={toggleMore}
            >
              更多
            </button>
          </>
        )}
      </header>

      {/* 掛在殼上而不是分支詳情裡：上傳期間人常常按「‹」回房間看別的東西，
          進度不能因此消失。 */}
      <UploadStatus upload={api.upload} />

      {inShellBranch ? (
          <main className="project-branch-detail">
            <div className="project-detail-head">
            <div><span className="project-kicker">{branchTypeLabel(inShellBranch.branchType)}</span><h2>{inShellBranch.name}</h2></div>
            {api.canManage ? (
              <select value={inShellBranch.status} onChange={(event) => api.onUpdateBranch(inShellBranch.id, { status: event.target.value as BranchStatus })} aria-label="分支狀態">
                {BRANCH_STATUSES.map((status) => <option value={status} key={status}>{branchStatusLabel(status)}</option>)}
              </select>
            ) : <span className={`project-status project-status-${inShellBranch.status}`}>{branchStatusLabel(inShellBranch.status)}</span>}
          </div>
          {api.loadingBranchId === inShellBranch.id ? (
            <div className="project-branch-empty-detail project-loading-detail"><span className="project-spinner" aria-hidden />正在載入這份內容…</div>
          ) : (inShellBranch.branchType === "plan" || inShellBranch.branchType === "copy") ? (
            <PlanEditor room={normalized} branch={inShellBranch} canManage={api.canManage} onSave={api.onSavePlan} onCreateRelation={api.onCreateRelation} onDeleteRelation={api.onDeleteRelation} />
          ) : (
            <div className="project-branch-empty-detail">
              <p>{branchVersions(normalized, inShellBranch.id).length ? "準備好進入檢視器。" : `這份${branchTypeLabel(inShellBranch.branchType)}還沒有版本。`}</p>
              {/* 上傳進行中就不要再擺一顆看起來能按、按了卻被上傳鎖擋掉的
                  按鈕；狀態列在上面，這裡說完成後會發生什麼事。 */}
              {api.canManage && (uploadBusy ? (
                <p className="project-muted" data-testid="branch-upload-inflight">影片正在上傳，完成後會出現在這裡。</p>
              ) : (
                <UniversalIntake profile={inShellBranch.branchType === "poster" ? "poster" : "video"} mode="zone" className="project-upload-button" onFiles={(picked) => api.onAddFiles(inShellBranch.id, picked)} onReject={api.onIntakeReject}>
                  <span>＋ {branchVersions(normalized, inShellBranch.id).length ? "新增版本" : `加入${branchTypeLabel(inShellBranch.branchType)}`}</span>
                </UniversalIntake>
              ))}
            </div>
          )}
        </main>
      ) : (
        <>
          <main className="project-room-main is-discussion-root">
            {search.trim() ? (
              <section className="project-section" data-testid="search-results">
                <div className="project-section-title-row"><h2>搜尋結果</h2><span>{branches.length} 項</span></div>
                {branches.length ? branches.map((branch) => <BranchCard key={branch.id} room={normalized} branch={branch} onOpen={() => openBranch(branch.id)} />) : <p className="project-muted">找不到相關內容</p>}
              </section>
            ) : (
              <section className="project-section" data-testid="discuss-workspace">
                <div className="rd-tabs" role="tablist" aria-label="討論">
                  <button type="button" className={discussPane === "chat" ? "is-active" : ""} onClick={() => { setDiscussPane("chat"); api.onOpenWhiteboard(null); }}>對話</button>
                  <button type="button" className={discussPane === "board" ? "is-active" : ""} onClick={() => setDiscussPane("board")}>白板</button>
                  <button type="button" className={discussPane === "calendar" ? "is-active" : ""} data-testid="schedule-tab" onClick={() => setDiscussPane("calendar")}>時程</button>
                </div>
                {discussPane === "calendar" ? (
                  <div className={tabletUp ? "sched-split-host" : undefined} data-testid={tabletUp ? "schedule-split" : undefined}>
                  <ScheduleAgenda api={{
                    roomId: normalized.id,
                    userId: api.userId ?? api.guest.id,
                    canWrite: api.canManage,
                    events: api.room.scheduleEvents ?? [],
                    splitWith: tabletUp ? splitCompanion : null,
                    onSplitWith: tabletUp ? setSplitCompanion : undefined,
                    onUpsert: (event) => api.onUpsertScheduleEvent?.(event),
                    onDelete: (id) => api.onDeleteScheduleEvent?.(id),
                    onOpenSource: (event) => {
                      const target = sourceOpenTarget(event);
                      if (target.surface === "discussion") {
                        if (tabletUp) setSplitCompanion("chat");
                        else setDiscussPane("chat");
                        openDiscussionMessage(target.messageId);
                      } else if (target.surface === "board") {
                        const node = (api.room.whiteboardNodes ?? []).find((item) => item.id === target.nodeId);
                        if (node) api.onOpenWhiteboard(node.whiteboardId);
                        if (tabletUp) setSplitCompanion("board");
                        else setDiscussPane("board");
                        api.onFocusNode?.(target.nodeId);
                      }
                      api.onOpenScheduleSource?.(event);
                    },
                  }} />
                  {tabletUp && splitCompanion === "chat" ? renderDiscussion("chat") : null}
                  {tabletUp && splitCompanion === "board" ? (
                    <WhiteboardWorkspace api={{
                      room: normalized,
                      boards: api.room.whiteboards ?? [],
                      nodes: api.room.whiteboardNodes ?? [],
                      edges: api.room.whiteboardEdges ?? [],
                      canManageBoards: api.canManage,
                      canEdit: api.canManage || Boolean(api.room.allowBoardEdit),
                      roleAllowsEdit: api.canManage,
                      online: api.online,
                      editors: api.editors,
                      isMobile: false,
                      focusNodeId: api.focusNodeId,
                      activeBoardId: api.activeWhiteboardId,
                      onOpenBoard: api.onOpenWhiteboard,
                      onCreateBoard: api.onCreateWhiteboard,
                      onArchiveBoard: api.onArchiveWhiteboard,
                      onRenameBoard: api.onRenameWhiteboard ?? (() => undefined),
                      onUpsertNode: api.onUpsertNode,
                      onDeleteNode: api.onDeleteNode,
                      onUpsertNodes: api.onUpsertNodes,
                      onCreateEdge: api.onCreateEdge,
                      onShareNode: api.onShareNodeToDiscussion,
                      onNodeDeadline: api.onNodeDeadline,
                      onOpenContent: (branchId, opts) => openBranch(branchId, opts),
                      onCreatePoll: (question, options) => {
                        const id = uuid();
                        api.onCreatePoll({
                          id,
                          roomId: api.room.id,
                          question,
                          options,
                          createdBy: api.guest.id,
                          createdAt: Date.now(),
                          updatedAt: Date.now(),
                        });
                        return id;
                      },
                      onCreateDecision: (title, source, status) => api.onCreateDecision(title, source, status),
                      onToggleAllowEdit: api.onToggleAllowBoardEdit,
                      allowBoardEdit: Boolean(api.room.allowBoardEdit),
                      canToggleOpenEdit: api.canManage,
                    }} />
                  ) : null}
                  </div>
                ) : discussPane === "board" ? (
                  <WhiteboardWorkspace api={{
                    room: normalized,
                    boards: api.room.whiteboards ?? [],
                    nodes: api.room.whiteboardNodes ?? [],
                    edges: api.room.whiteboardEdges ?? [],
                    canManageBoards: api.canManage,
                    canEdit: api.canManage || Boolean(api.room.allowBoardEdit),
                    roleAllowsEdit: api.canManage,
                    online: api.online,
                    editors: api.editors,
                    boardPeople: api.boardPeople,
                    railVisible,
                    onToggleRail: tabletUp ? () => setRailCollapsed((current) => !current) : undefined,
                    onFrameDragState: api.onFrameDragState,
                    onSnapshotBoard: api.onSnapshotBoard,
                    onListVersions: api.onListVersions,
                    onLoadVersion: api.onLoadVersion,
                    onRestoreVersion: api.onRestoreVersion,
                    onAskBoardAi: api.onAskBoardAi,
                    stagedAiPreview: api.stagedAiPreview,
                    onConsumeStagedAiPreview: api.onConsumeStagedAiPreview,
                    onApplyBoardAi: api.onApplyBoardAi,
                    isMobile,
                    focusNodeId: api.focusNodeId,
                    activeBoardId: api.activeWhiteboardId,
                    onOpenBoard: api.onOpenWhiteboard,
                    onDragState: api.onBoardDragState,
                    onCreateBoard: api.onCreateWhiteboard,
                    onArchiveBoard: api.onArchiveWhiteboard,
                    onRenameBoard: api.onRenameWhiteboard ?? (() => undefined),
                    onUpsertNode: api.onUpsertNode,
                    onDeleteNode: api.onDeleteNode,
                    onUpsertNodes: api.onUpsertNodes,
                    onCreateEdge: api.onCreateEdge,
                    onShareNode: api.onShareNodeToDiscussion,
                    onNodeDeadline: api.onNodeDeadline,
                    onOpenContent: (branchId, opts) => {
                      openBranch(branchId, opts);
                    },
                    onCreatePoll: (question, options) => {
                      const id = uuid();
                      api.onCreatePoll({
                        id,
                        roomId: api.room.id,
                        question,
                        options,
                        createdBy: api.guest.id,
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                      });
                      return id;
                    },
                    onCreateDecision: api.onCreateDecision,
                    onToggleAllowEdit: api.onToggleAllowBoardEdit,
                    allowBoardEdit: Boolean(api.room.allowBoardEdit),
                    canToggleOpenEdit: api.role === "owner" || (!api.role && api.canManage),
                    frames: api.whiteboardFrames,
                    onCreateFrame: api.onCreateFrame,
                    onUpdateFrame: api.onUpdateFrame,
                    onDeleteFrame: api.onDeleteFrame,
                    onOpenDiscussionMessage: openDiscussionMessage,
                    onEmitOperation: api.onEmitOperation,
                    onFocusChange: (focused) => {
                      setBoardFocused(focused);
                      api.onBoardFocusChange?.(focused);
                    },
                  }} />
                ) : (
                  renderDiscussion()
                )}
              </section>
            )}
          </main>
          {moreOpen && !hideRoomChrome && (
            <aside className="project-more-sheet" data-testid="room-more-sheet" aria-label="更多">
              <div className="project-search-wrap">
                <span aria-hidden>⌕</span>
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋茶會、擺攤、招生…" aria-label="搜尋房間內容" />
                {search && <button type="button" onClick={() => setSearch("")} aria-label="清除搜尋">×</button>}
              </div>
              <nav className="project-entry-chips" aria-label="房間內容">
                {PANE_META.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    data-testid={`open-${item.id}-pane`}
                    onClick={() => {
                      closeMoreFromAction();
                      setPushedPane(item.id);
                    }}
                  >
                    <span aria-hidden>{item.icon}</span>{item.label}
                    {item.id === "content" && tabBranches("poster").length + tabBranches("video").length > 0 ? <small>{tabBranches("poster").length + tabBranches("video").length}</small> : null}
                    {item.id === "plan" && tabBranches("plan").length > 0 ? <small>{tabBranches("plan").length}</small> : null}
                  </button>
                ))}
              </nav>
              <div className="project-more-actions">
                <button type="button" className="project-ai-button" data-testid="room-ai-launcher" onClick={() => { closeMoreFromAction(); api.onOpenAi(); }}>✦ AI</button>
                <button type="button" className="project-share-button" onClick={() => { closeMoreFromAction(); api.onShare(); }}>分享</button>
                {api.canManage && !api.activeWhiteboardId && (
                  <button type="button" className="project-fab" data-testid="room-add-content" onClick={() => { closeMoreFromAction(); setCreateOpen(true); }} aria-label="新增內容">＋</button>
                )}
              </div>
            </aside>
          )}
          {pushedPane && (
            <div className="project-push-pane" data-testid={`${pushedPane}-pane`}>
              <header className="project-push-head">
                <button type="button" className="project-back-button" onClick={() => setPushedPane(null)} aria-label="返回討論">‹</button>
                <h2>{PANE_META.find((item) => item.id === pushedPane)?.label}</h2>
              </header>
              <div className="project-push-body">
                {pushedPane === "overview" ? (
                  <>
                <section className="project-section project-welcome">
                  <p className="project-section-eyebrow">{normalized.branches?.length ? "這個活動房正在進行" : "從一份內容開始"}</p>
                  <h2>{normalized.branches?.length ? "最近發生了什麼" : "這間房還沒有內容"}</h2>
                  {!normalized.branches?.length && <p className="project-muted">把文宣、影片和企劃放在一起，之後再慢慢補齊。</p>}
                </section>
                <section className="project-section" data-testid="recent-updates"><div className="project-section-title-row"><h2>最近更新</h2><span>查看全部內容</span></div>
                  {branches.slice(0, 4).map((branch) => <div className="project-update-row" key={branch.id} onClick={() => openBranch(branch.id)}><span>{branchTypeLabel(branch.branchType)}</span><strong>{branch.name}</strong><small>{relativeTime(branch.updatedAt)}</small></div>)}
                  {!branches.length && <p className="project-muted">還沒有最近更新</p>}
                </section>
                <section className="project-section" data-testid="decisions"><div className="project-section-title-row"><h2>待決策</h2>{api.canManage && <button type="button" className="project-text-button" onClick={() => setPollOpen(true)}>＋ 新增</button>}</div>
                  {(api.room.polls ?? []).filter((poll) => !poll.closedAt).slice(0, 3).map((poll) => <PollCard key={poll.id} poll={poll} room={api.room} userId={api.userId ?? api.guest.id} onVote={votePoll} />)}
                  {!(api.room.polls ?? []).some((poll) => !poll.closedAt) && <p className="project-muted">目前沒有待決策</p>}
                </section>
                <section className="project-section"><div className="project-section-title-row"><h2>進行中的分支</h2><button type="button" className="project-sort-button" onClick={() => setSortRecent((value) => !value)}>{sortRecent ? "依最近更新" : "依順序"}</button></div>
                  {branches.filter((branch) => branch.status === "in_progress" || branch.status === "pending").slice(0, 5).map((branch) => <BranchCard key={branch.id} room={normalized} branch={branch} onOpen={() => openBranch(branch.id)} />)}
                </section>
                <section className="project-section" data-testid="recent-feedback"><div className="project-section-title-row"><h2>最近回饋</h2><span>{api.room.comments.length} 則</span></div>
                  {recentComments.map((comment) => <button type="button" className="project-feedback-row" key={comment.id} onClick={() => { const branch = normalized.branches?.find((item) => item.id === comment.branchId || branchVersions(normalized, item.id).some((version) => version.id === comment.versionId)); if (branch) openBranch(branch.id); }}><span className="project-feedback-dot" style={{ background: comment.authorColor }} /> <span><strong>{branchNameForVersion(comment.versionId)}</strong><small>{comment.body}</small></span></button>)}
                  {!recentComments.length && <p className="project-muted">還沒有回饋</p>}
                </section>
                <section className="project-section project-room-chat"><div className="project-section-title-row"><h2>房間討論</h2><button type="button" className="project-text-button" onClick={() => setPushedPane(null)}>回到討論</button></div><div className="project-chat-list">{(api.room.discussion ?? api.room.messages).slice(-3).map((message) => <p key={message.id}><b>{message.authorName}</b>{message.body}</p>)}{!(api.room.discussion ?? api.room.messages).length && <p className="project-muted">先留一句房間層級的討論吧</p>}</div><div className="project-chat-input"><input value={api.chatInput} onChange={(event) => api.setChatInput(event.target.value)} placeholder="這週先主推哪一份？" onKeyDown={(event) => event.key === "Enter" && api.sendChat()} /><button type="button" onClick={api.sendChat} disabled={!api.chatInput.trim()}>送出</button></div></section>
                  </>
                ) : (
              <section className="project-section project-list-section" data-testid={`${pushedPane}-branches`}>
                {pushedPane === "content" ? (
                  <>
                    <div className="project-section-title-row"><div><span className="project-section-eyebrow">文宣與影片</span><h2>內容</h2></div>{api.canManage && <button type="button" className="project-text-button" onClick={() => openCreate(contentKind === "video" ? "video" : "poster")}>＋ 新增</button>}</div>
                    <div className="rd-tabs" style={{ marginTop: 0 }}>
                      {(["all", "poster", "video"] as const).map((item) => (
                        <button type="button" key={item} className={contentKind === item ? "is-active" : ""} onClick={() => setContentKind(item)}>
                          {item === "all" ? "全部" : item === "poster" ? "文宣" : "影片"}
                        </button>
                      ))}
                    </div>
                    {(contentKind === "all" || contentKind === "poster") && (
                      <div data-testid="poster-branches">
                        <div className="project-section-title-row"><h3>文宣</h3>{api.canManage && <button type="button" className="project-text-button" onClick={() => openCreate("poster")}>＋ 新增文宣</button>}</div>
                        <div className="project-branch-list">{tabBranches("poster").map((branch) => <BranchCard key={branch.id} room={normalized} branch={branch} onOpen={() => openBranch(branch.id)} draggable onDrop={() => undefined} />)}</div>
                        {!tabBranches("poster").length && api.canManage && <EmptyType label="文宣" onAdd={() => openCreate("poster")} />}
                      </div>
                    )}
                    {(contentKind === "all" || contentKind === "video") && (
                      <div data-testid="video-branches">
                        <div className="project-section-title-row"><h3>影片</h3>{api.canManage && <button type="button" className="project-text-button" onClick={() => openCreate("video")}>＋ 新增影片</button>}</div>
                        <div className="project-branch-list">{tabBranches("video").map((branch) => <BranchCard key={branch.id} room={normalized} branch={branch} onOpen={() => openBranch(branch.id)} draggable onDrop={() => undefined} />)}</div>
                        {!tabBranches("video").length && api.canManage && <EmptyType label="影片" onAdd={() => openCreate("video")} />}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="project-section-title-row"><div><span className="project-section-eyebrow">企劃、文案與清單</span><h2>企劃</h2></div>{api.canManage && <button type="button" className="project-text-button" onClick={() => openCreate("plan")}>＋ 新增企劃</button>}</div>
                    <div className="project-branch-list">{tabBranches("plan").map((branch) => <BranchCard key={branch.id} room={normalized} branch={branch} onOpen={() => openBranch(branch.id)} draggable onDrop={() => undefined} />)}</div>
                    {!tabBranches("plan").length && api.canManage && <EmptyType label="企劃" onAdd={() => openCreate("plan")} />}
                  </>
                )}
              </section>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {createOpen && <CreateSheet initialType={createType} onClose={() => { setCreateOpen(false); setCreateType(undefined); }} onCreate={createContent} onCutosImport={api.cutosImport} canva={api.canva} onReject={api.onIntakeReject} />}
      {pollOpen && <PollSheet onClose={() => setPollOpen(false)} onCreate={createPoll} />}
      {/* WB05 平板 Split View：白板全螢幕時，左側常駐討論欄。手機由 CSS
          斷點隱藏（display:none），行為與之前完全一樣。 */}
      {boardFocused && railVisible && (
        <aside className="wb-side-rail" data-testid="wb-side-rail" aria-label="討論">
          <div className="wb-side-rail-head">
            <strong>討論</strong>
            <button type="button" onClick={() => setRailCollapsed(true)} aria-label="收起討論">✕</button>
          </div>
          <div className="wb-side-rail-body">{renderDiscussion("chat")}</div>
        </aside>
      )}
      {api.workspace && (
        // 對稿工作區疊在討論殼上；殼不卸載，返回時狀態全在。此容器（與其
        // 祖先）不可有 transform/filter/contain，工作區自己的 fixed 底欄
        // 才能繼續對 viewport 定位。
        <div className="project-workspace-overlay" data-testid="branch-workspace-overlay">
          {api.workspace.node}
        </div>
      )}
    </div>
  );
}
