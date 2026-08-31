import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { PlanDocument, Room, RoomBranch, RoomPoll } from "../../lib/types";
import { anchorFromNode, openTarget } from "../../lib/contextAnchor";
import { branchSummary, latestBranchVersion } from "../../lib/roomBranches";
import { useViewport } from "../../hooks/useViewport";
import {
  addFlowNextStep,
  addMindmapChild,
  applyNodePatch,
  createRelationEdges,
  createSticky,
  findNodes,
  formatVideoRange,
  groupSelected,
  moveNodes,
  nodeSearchText,
  parseTimestamp,
} from "../collaboration/nodes";
import { arrangeBoard } from "../collaboration/layout";
import { canEditBoard } from "../collaboration/permissions";
import { formatEditorLine } from "../collaboration/presence";
import { lastColleagueForFocus } from "../collaboration/agentColleague";
import type { NodeType, PresenceEditor, Whiteboard, WhiteboardEdge, WhiteboardFrame, WhiteboardNode } from "../collaboration/types";
import { nodeCreateDraft, nodeDeleteDraft, nodeUpdateDraft, applyMasked, applyFrameMasked, frameCreateDraft, frameDeleteDraft, frameUpdateDraft, type OperationDraft } from "../collaboration/operations";
import { fitCamera, focusCamera, marqueeHits, screenToWorld, visibleNodes, zoomAt, clampZoom, type Camera } from "./canvas";
import { paintOrder, hitTest } from "./order";
import {
  gestureReducer,
  initialGestureState,
  lassoHits,
  LONG_PRESS_MS,
  type GestureEffect,
  type GestureState,
} from "./gestures";
import { emptyHistory, pushHistory, redoStep, undoStep, type HistoryStack } from "./history";
import { historyLayers } from "../../lib/historyLayers";
import { normalizeStroke, thinStroke, type StrokePoint } from "./freehand";
import { initialPenState, penDown, penUp, segmentWidths, shouldRejectPointer, type PointerKind } from "./pen";
import { describeRestore, planRestore, type BoardSnapshot, type BoardVersionSummary } from "./versions";
import { describePreview, planApply, type BoardAiPreview } from "./aiPreview";
import {
  cameraAfterRemount,
  discussionIdFromNode,
  emptyBoardVerbs,
  emptyRoomTitle,
  focusCardFromNode,
  focusNodeIdFromSelection,
  isEmptyBoard,
  readBoardSession,
  shouldMountFocusSheet,
  writeBoardSession,
} from "./boardFocus";
import { DragSheet, type SheetSnap } from "../../components/BottomSheet";
import { rendererFor } from "./registry";
import {
  contentOpenFromNode,
  nodeFromImageRegion,
  nodeFromPlanSection,
  planParagraphs,
  posterRegionMarks,
} from "../collaboration/boardAnchors";
import { boardDecisionWrite, boardPollWrite } from "../collaboration/discussionHonesty";
import type { AnnotationRegion, PlanBlock } from "../../lib/types";
import "./whiteboard.css";

export type WhiteboardApi = {
  room: Room;
  boards: Whiteboard[];
  nodes: WhiteboardNode[];
  edges: WhiteboardEdge[];
  canManageBoards: boolean;
  canEdit: boolean;
  roleAllowsEdit: boolean;
  online: number;
  editors: PresenceEditor[];
  isMobile: boolean;
  focusNodeId?: string | null;
  activeBoardId?: string | null;
  onOpenBoard: (id: string | null) => void;
  /** 拖曳中的節點 ids（null=沒在拖）：遠端 row-patch 對這些節點讓路。 */
  onDragState?: (ids: string[] | null) => void;
  onCreateBoard: (title: string) => void;
  onArchiveBoard: (id: string) => void;
  onRenameBoard: (id: string, title: string) => void;
  onUpsertNode: (node: WhiteboardNode, persist?: "now" | "end") => void;
  onDeleteNode: (id: string) => void;
  onUpsertNodes: (nodes: WhiteboardNode[], persist?: "now" | "end") => void;
  onCreateEdge: (edge: WhiteboardEdge) => void;
  onShareNode: (node: WhiteboardNode) => void;
  onOpenContent: (branchId: string, opts?: { startTime?: number; endTime?: number; region?: AnnotationRegion; versionId?: string; planSectionId?: string }) => void;
  onCreatePoll: (question: string, options: string[]) => string | void;
  onCreateDecision: (title: string, source?: { type: "poll"; id: string }, status?: "pending" | "decided") => void;
  onToggleAllowEdit: () => void;
  allowBoardEdit: boolean;
  canToggleOpenEdit: boolean;
  // ---- WB02 新增（皆 optional：舊掛載點不破） ----
  /** 空間容器（0022）。未提供＝不渲染 frames 層。 */
  frames?: WhiteboardFrame[];
  onCreateFrame?: (frame: WhiteboardFrame) => void;
  /** Focus Mode 進出（App 據此抑制 AssetAiFab — wireflow 疊加規則）。 */
  onFocusChange?: (focused: boolean) => void;
  /** 操作事件入帳（0023，best-effort — 失敗只損 undo 粒度不擋操作）。 */
  onEmitOperation?: (draft: OperationDraft) => void;
  // ---- WB03 ----
  onUpdateFrame?: (frame: WhiteboardFrame) => void;
  onDeleteFrame?: (id: string) => void;
  /** 板節點「打開來源訊息」→ 切討論並捲動高亮。 */
  onOpenDiscussionMessage?: (messageId: string) => void;
  onNodeDeadline?: (node: WhiteboardNode, startAt: number) => void;
  /** WB04：開著這塊板的其他人（具名在場）。 */
  boardPeople?: { userId: string; name: string }[];
  /** WB05 平板 Split View：側欄此刻是否真的掛著（掛載由上層以 JS 判定，
   *  與 CSS 斷點同源 — 只靠 CSS 隱藏會讓手機也掛一份討論面板）。 */
  railVisible?: boolean;
  onToggleRail?: () => void;
  /** WB04 版本歷史：未提供＝不顯示入口（本機房沒有快照表）。 */
  /** 本機正在拖/縮的 frame id（遠端事件對它讓路）。 */
  onFrameDragState?: (id: string | null) => void;
  onSnapshotBoard?: (label: string) => Promise<void>;
  onListVersions?: () => Promise<BoardVersionSummary[]>;
  /** 點下某個版本才取它的快照（清單不帶快照 — 可能是好幾 MB）。 */
  onLoadVersion?: (versionId: string) => Promise<{ snapshot: BoardSnapshot; dropped: number }>;
  /** 回傳實際結果：寫出去幾筆、是否離線排隊中 — UI 只能說真話。 */
  onRestoreVersion?: (snapshot: BoardSnapshot) => Promise<{ applied: number; queued: boolean }>;
  // ---- WB06：板內 AI（提案→預覽→套用→稽核） ----
  /**
   * 問 AI（帶白板上下文）。回傳**預覽**，不寫任何東西 —— 未提供＝不顯示
   * AI 入口（本機房沒有 AI）。
   */
  onAskBoardAi?: (
    question: string,
    context: { nodes: WhiteboardNode[]; selectedIds: string[]; centerWorld: { x: number; y: number } },
  ) => Promise<BoardAiPreview>;
  /** 使用者按下套用：呼叫端負責快照、寫入、稽核。回傳實際結果。 */
  onApplyBoardAi?: (
    plan: { nodes: WhiteboardNode[]; edges: WhiteboardEdge[] },
    preview: BoardAiPreview,
  ) => Promise<{ applied: number; snapshotTaken: boolean; queued?: boolean; auditRecorded?: boolean }>;
  /**
   * 上層（房間層 AI 面板）暫存進來的預覽（F1）：房間 AI 的
   * add_whiteboard_node 不再直接落板，改成開板 ＋ 交給這裡預覽。
   */
  stagedAiPreview?: BoardAiPreview | null;
  onConsumeStagedAiPreview?: () => void;
  /** 切 pane 後還在：房間焦點（「讓大家看這個」）。 */
  roomFocusId?: string | null;
  onSetRoomFocus?: (nodeId: string | null) => void;
  onSelectionFocus?: (nodeId: string | null) => void;
  /** 手機 Focus sheet 掛討論（平板走 rail，不要雙掛）。 */
  discussionSlot?: import("react").ReactNode;
  onAskColleague?: (input: { prompt: string; nodeId?: string }) => void;
  onPinFromDiscussion?: () => void;
  onRenameRoom?: (title: string) => void;
};

type Sheet = "add" | "search" | "content" | "more" | "poll" | "poll-create" | "video-range" | "poster-region" | "plan-section" | "versions" | "ai" | "decision" | "deadline" | null;

const ADD_OPTIONS: { type: NodeType | "content"; label: string }[] = [
  { type: "text", label: "便利貼" },
  { type: "flow", label: "流程" },
  { type: "mindmap", label: "心智圖" },
  { type: "task", label: "任務" },
  { type: "calendar_event", label: "日曆事件" },
  { type: "content", label: "放入房間內容" },
  { type: "image", label: "圖片" },
];

function relative(ts: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

const NodeView = memo(function NodeView({
  node,
  selected,
  editing,
  canEdit,
  connectSource,
  onChangeText,
}: {
  node: WhiteboardNode;
  selected: boolean;
  editing: boolean;
  canEdit: boolean;
  connectSource: boolean;
  onChangeText: (text: string) => void;
}) {
  const Renderer = rendererFor(node.nodeType);
  const className = [
    "wb-node",
    `wb-node-${node.nodeType}`,
    node.nodeType === "room_content" || node.nodeType === "image" ? "wb-node-content" : "",
    selected ? "is-selected" : "",
    editing ? "is-editing" : "",
    node.locked ? "is-locked" : "",
    connectSource ? "is-connect-source" : "",
  ].filter(Boolean).join(" ");
  const style = {
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    ...(node.rotation ? { transform: `rotate(${node.rotation}deg)` } : {}),
  };
  return (
    <div className={className} style={style} data-testid={`wb-node-${node.id}`} data-node-type={node.nodeType}>
      {node.locked ? <span className="wb-lock-badge" aria-label="已鎖定">🔒</span> : null}
      <Renderer node={node} editing={editing} canEdit={canEdit} onChangeText={onChangeText} />
    </div>
  );
});

function RoomContentPicker({
  room,
  onPick,
  onPickAsset,
  initialKind = "all",
}: {
  room: Room;
  onPick: (branch: RoomBranch) => void;
  onPickAsset?: (version: import("../../lib/types").Version) => void;
  initialKind?: "all" | "poster" | "video" | "plan" | "asset";
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "poster" | "video" | "plan" | "asset">(initialKind);
  const branches = (room.branches ?? []).filter((branch) => branch.status !== "archived");
  const filtered = branches.filter((branch) => {
    if (kind === "asset") return false;
    if (kind !== "all" && branch.branchType !== kind && !(kind === "plan" && branch.branchType === "copy")) return false;
    return !query.trim() || branch.name.toLowerCase().includes(query.trim().toLowerCase());
  });
  const assets = (room.versions ?? []).filter((version) => {
    if (kind !== "asset" && kind !== "all") return false;
    if (kind === "all") return false;
    const hay = `${version.label} ${version.mimeType ?? ""} ${version.kind ?? ""}`.toLowerCase();
    return !query.trim() || hay.includes(query.trim().toLowerCase());
  });
  return (
    <div className="wb-sheet" data-testid="wb-content-picker">
      <h3>放入房間內容</h3>
      <input className="text-input wb-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋檔名、標籤、類型…" aria-label="搜尋房間內容" />
      <div className="rd-tabs" style={{ marginTop: 0 }}>
        {(["all", "poster", "video", "plan", "asset"] as const).map((item) => (
          <button type="button" key={item} className={kind === item ? "is-active" : ""} onClick={() => setKind(item)}>
            {item === "all" ? "全部" : item === "poster" ? "文宣" : item === "video" ? "影片" : item === "plan" ? "企劃" : "素材"}
          </button>
        ))}
      </div>
      <div className="wb-options">
        {filtered.map((branch) => {
          const version = latestBranchVersion(room, branch.id);
          const summary = branchSummary(room, branch.id);
          const plan = room.plans?.find((item) => item.branchId === branch.id);
          return (
            <button type="button" className="wb-content-item" key={branch.id} onClick={() => onPick(branch)}>
              <span aria-hidden>{branch.branchType === "video" ? "▶" : branch.branchType === "poster" ? "▧" : "☷"}</span>
              <span>
                <strong>{branch.name}</strong>
                <small>
                  {branch.branchType === "video"
                    ? `${version?.label ?? summary.latestLabel ?? "影片"}${version?.duration ? ` · ${Math.round(version.duration)}s` : ""}`
                    : branch.branchType === "plan" || branch.branchType === "copy"
                      ? plan?.title || "企劃"
                      : `${version?.label ?? summary.latestLabel ?? "文宣"}${summary.openCommentCount ? ` · ${summary.openCommentCount} 則待處理` : ""}`}
                </small>
              </span>
            </button>
          );
        })}
        {assets.map((version) => (
          <button type="button" className="wb-content-item" key={version.id} onClick={() => onPickAsset?.(version)}>
            <span aria-hidden>{version.kind === "video" ? "▶" : "▧"}</span>
            <span>
              <strong>{version.label}</strong>
              <small>{version.mimeType || version.kind || "素材"}{version.fileSize ? ` · ${Math.round(version.fileSize / 1024)} KB` : ""}</small>
            </span>
          </button>
        ))}
        {!filtered.length && !assets.length && <p className="project-muted">這個房間還沒有符合的內容</p>}
      </div>
    </div>
  );
}

function BoardList({ api }: { api: WhiteboardApi }) {
  const [title, setTitle] = useState("");
  const active = api.boards.filter((board) => !board.archivedAt);
  return (
    <div className="wb-list" data-testid="whiteboard-list">
      {api.canManageBoards && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim()) return;
            api.onCreateBoard(title.trim());
            setTitle("");
          }}
        >
          <label className="project-field">
            <span>新白板</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：招生規劃" aria-label="白板名稱" />
          </label>
          <button type="submit" className="project-save-button project-submit" disabled={!title.trim()}>建立白板</button>
        </form>
      )}
      {active.map((board) => (
        <button type="button" className="wb-card" key={board.id} data-testid={`wb-card-${board.id}`} onClick={() => api.onOpenBoard(board.id)}>
          <span>
            <strong>{board.title}</strong>
            <small>{board.description || `更新於 ${relative(board.updatedAt)}`}</small>
          </span>
        </button>
      ))}
      {!active.length && <div className="wb-empty">還沒有白板。先開一塊「招生規劃」，再把文宣和流程放上去。</div>}
    </div>
  );
}

let opSeq = 0;
function nextOpId(): string {
  // op_id 需要 uuid（DB 欄位）：crypto.randomUUID 到處都有（secure context）
  try {
    return crypto.randomUUID();
  } catch {
    opSeq += 1;
    return `00000000-0000-4000-8000-${String(opSeq).padStart(12, "0")}`;
  }
}

// Camera memory（WB03，WB02-F9 承諾的 keep-mounted 使用者可見目標）：
// 切走再回來視角不歸零。模組級、粗 LRU 上限 24 板。
const CAMERA_MEMORY = new Map<string, Camera>();

export function WhiteboardWorkspace({ api }: { api: WhiteboardApi }) {
  const board = api.boards.find((item) => item.id === api.activeBoardId && !item.archivedAt) ?? null;
  const canEdit = board ? canEditBoard(api.roleAllowsEdit ? "editor" : "reviewer", api.allowBoardEdit, board) && api.canEdit : false;
  const nodes = useMemo(() => api.nodes.filter((node) => node.whiteboardId === board?.id), [api.nodes, board?.id]);
  const edges = useMemo(() => api.edges.filter((edge) => edge.whiteboardId === board?.id), [api.edges, board?.id]);
  const frames = useMemo(() => (api.frames ?? []).filter((frame) => frame.whiteboardId === board?.id), [api.frames, board?.id]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 24, y: 24, zoom: 1 });
  const [selected, setSelected] = useState<string[]>([]);
  const selectedRef = useRef<string[]>([]);
  selectedRef.current = selected;
  const [focusSheetSnap, setFocusSheetSnap] = useState<SheetSnap>("half");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sheet, setSheetState] = useState<Sheet>(null);
  // F5：popstate handler 要同步讀 sheet — ref 隨 setter 同步更新
  const sheetRef = useRef<Sheet>(null);
  const setSheet = useCallback((next: Sheet) => { sheetRef.current = next; setSheetState(next); }, []);
  const [search, setSearch] = useState("");
  const [viewport, setViewport] = useState({ width: 360, height: 520 });
  // Compact toolbar follows the window, not the canvas wrap. Split View
  // shrinks wrap below 768 even on a 1024 tablet — labels must still show.
  const [chromeWidth, setChromeWidth] = useState(() => (typeof window === "undefined" ? 390 : window.innerWidth));
  const [marquee, setMarquee] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const [lassoPath, setLassoPath] = useState<{ x: number; y: number }[] | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectTool, setSelectTool] = useState<"off" | "marquee" | "lasso">("off");
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  // ---- WB03：繪圖模式（筆畫收集繞過手勢 reducer） ----
  const [drawMode, setDrawMode] = useState(false);
  const [strokePreview, setStrokePreview] = useState<StrokePoint[] | null>(null);
  const strokeRef = useRef<StrokePoint[] | null>(null);
  const strokePointerRef = useRef<number | null>(null);
  const strokeDownRef = useRef<{ pointerId: number; point: { x: number; y: number }; time: number } | null>(null);
  // S1：第一指的**當前**螢幕座標 — 轉 pinch 回放要用它，不是起筆點
  const strokeScreenRef = useRef<{ x: number; y: number } | null>(null);
  /** 觸控筆狀態（掌拒）— 純函式在 pen.ts，這裡只存。 */
  const penRef = useRef(initialPenState());
  // ---- WB03：frame 選取/拖曳/縮放 ----
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null);
  const [framePreview, setFramePreview] = useState<WhiteboardFrame | null>(null);
  const framePreviewRef = useRef<WhiteboardFrame | null>(null);
  const setFramePreviewSync = (frame: WhiteboardFrame | null) => {
    framePreviewRef.current = frame;
    setFramePreview(frame);
  };
  const frameDragRef = useRef<{
    mode: "move" | "resize";
    pointerId: number;
    frame: WhiteboardFrame;
    startClient: { x: number; y: number };
    memberIds: string[];
    startNodes: Map<string, WhiteboardNode>;
    moved: boolean;
  } | null>(null);
  const [versions, setVersions] = useState<BoardVersionSummary[] | null>(null);
  const [versionBusy, setVersionBusy] = useState(false);
  /** 點開的那一版：快照取回後才算得出「還原會發生什麼」。 */
  const [versionPreview, setVersionPreview] = useState<
    { version: BoardVersionSummary; snapshot: BoardSnapshot; dropped: number } | null
  >(null);
  // ---- WB06：AI 預覽（只活在這裡，不進房態、不寫 DB） ----
  const [aiQuestion, setAiQuestion] = useState("");
  const [decisionTitle, setDecisionTitle] = useState("");
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPreview, setAiPreview] = useState<BoardAiPreview | null>(null);
  const aiPreviewRef = useRef<BoardAiPreview | null>(null);
  aiPreviewRef.current = aiPreview;
  /** 套用進行中（F4）：setState 是非同步的，連點兩次會寫兩批。 */
  const aiApplyingRef = useRef(false);
  /** 提問序號：關掉 sheet 或再問一次都會讓在途的回應作廢。 */
  const aiAskSeqRef = useRef(0);
  const [frameRenaming, setFrameRenaming] = useState(false);
  const [frameTitleDraft, setFrameTitleDraft] = useState("");
  const [pendingVideo, setPendingVideo] = useState<RoomBranch | null>(null);
  const [pendingPoster, setPendingPoster] = useState<RoomBranch | null>(null);
  const [pendingPlan, setPendingPlan] = useState<RoomBranch | null>(null);
  const [videoStart, setVideoStart] = useState("00:40");
  const [videoEnd, setVideoEnd] = useState("");
  const [contentKind, setContentKind] = useState<"all" | "poster" | "video" | "plan" | "asset">("all");
  const [previewNodes, setPreviewNodes] = useState<WhiteboardNode[] | null>(null);
  // F4：拖曳 preview 的同步事實來源 — render 閉包的 previewNodes 在
  // 同批 pointermove 之間是舊值，增量會疊在過期基準上（節點抖動/丟步）
  const previewRef = useRef<WhiteboardNode[] | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [history, setHistory] = useState<HistoryStack>(emptyHistory());

  const gesture = useRef<GestureState>(initialGestureState());
  const longPressTimer = useRef<number | null>(null);
  const dragStartNodes = useRef<Map<string, WhiteboardNode> | null>(null);
  const editStartNode = useRef<WhiteboardNode | null>(null);
  const historyRef = useRef(history);
  historyRef.current = history;

  const usableHeight = useViewport();
  const keyboardInset = Math.max(0, (typeof window !== "undefined" ? window.innerHeight : 0) - usableHeight);

  // ---- op 入帳＋undo 疊（同一入口，best-effort） ----
  const record = useCallback((draft: OperationDraft | null) => {
    if (!draft) return;
    setHistory((current) => pushHistory(current, draft));
    api.onEmitOperation?.(draft);
  }, [api]);

  // ---- Focus 進出通知＋history 層（wireflow 疊加規則 1/2/5） ----
  // 只鍵在 focused（Grok wb02 F5）：若鍵 board?.id，切板時 cleanup 的
  // history.back() 是非同步的，會打進「新 effect 已掛上的 listener」，
  // 誤觸 onOpenBoard(null) 把剛開的板關掉。切板期間 focused 不變，
  // 這一層 history 就原地保留。
  const focused = Boolean(board);
  const poppingRef = useRef(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    apiRef.current.onFocusChange?.(focused);
    if (!focused) return;
    // 進 Focus：改走 historyLayers 協調器（WB03）— 對稿 overlay 疊在
    // Focus 上時 back 先關棧頂的 overlay，不再兩個 popstate listener
    // 互踩（舊 bug：板被退、overlay 還在）。語意不變：back 先關 sheet
    // （repush，層自留），再退出白板（closed）。
    const remove = historyLayers().push("board-focus", () => {
      if (sheetRef.current) {
        setSheet(null);
        return "repush";
      }
      poppingRef.current = true;
      apiRef.current.onOpenBoard(null);
      return "closed";
    });
    // Escape 不自己監聽（S12）：協調器的單一 handler 會派給棧頂層 —
    // 這層的 onBack 已經處理「先關 sheet、再退板」的階梯。
    return () => {
      // 離開 Focus 時清掉筆狀態（N2）：元件不卸載，殘留的 penPointerId 會
      // 讓重開板後所有手指被永久掌拒。
      penRef.current = initialPenState();
      strokePointerRef.current = null;
      strokeRef.current = null;
      strokeDownRef.current = null;
      strokeScreenRef.current = null;
      apiRef.current.onFocusChange?.(false);
      remove(poppingRef.current);
      poppingRef.current = false;
    };
  }, [focused, setSheet]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      measuredWidthRef.current = el.clientWidth;
      setViewport({ width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [board?.id]);

  useEffect(() => {
    const onResize = () => setChromeWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /**
   * 側欄開合的 camera 補償（F5）：畫布寬度變了，把**畫面中心**的內容留在
   * 原地 —— 不補償的話收起討論欄時整個畫布往左跳一個側欄的寬度。
   *
   * 刻意只在「使用者切換側欄」時做，不掛在 ResizeObserver 上：掛載期間
   * 的量測序列（0 → 全寬 → 讓出側欄後的寬）也會被當成變化，開板的初始
   * 視角就變成競態的產物（視覺基準會抖）。
   */
  const measuredWidthRef = useRef(0);
  const railRef = useRef(api.railVisible);
  useEffect(() => {
    if (railRef.current === api.railVisible) return;
    railRef.current = api.railVisible;
    const el = wrapRef.current;
    if (!el) return;
    const before = measuredWidthRef.current;
    const raf = requestAnimationFrame(() => {
      const after = el.clientWidth;
      measuredWidthRef.current = after;
      if (before > 0 && after > 0 && after !== before) {
        setCamera((current) => ({ ...current, x: current.x + (after - before) / 2 }));
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [api.railVisible]);

  // 房間層 AI 暫存進來的預覽（F1）：接手後立刻通知上層清掉，避免重複掛。
  useEffect(() => {
    if (!api.stagedAiPreview) return;
    setAiPreview(api.stagedAiPreview);
    api.onConsumeStagedAiPreview?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.stagedAiPreview]);

  // F4：切板時清掉**不屬於這塊板**的預覽 —— 預覽節點帶的是產生當時那塊板
  // 的 whiteboardId，換板後按套用會把節點寫進舊板、快照卻存的是新板。
  //
  // 不能無條件清空：房間層 AI 是「開板 ＋ 暫存預覽」同一次 commit 完成的，
  // 無條件清會把剛送進來的預覽當場抹掉（e2e 抓到）。
  useEffect(() => {
    // 切板同樣要重置筆與筆畫狀態：元件不卸載（!board 只是改渲染 BoardList），
    // 只在「離開 Focus」重置的話，切板時殘留的 penPointerId 會讓新板上的
    // 所有手指被永久掌拒（自審實抓；筆在玻璃上時別人封存這塊板就會遇到）。
    penRef.current = initialPenState();
    strokePointerRef.current = null;
    strokeRef.current = null;
    strokeDownRef.current = null;
    strokeScreenRef.current = null;
    setStrokePreview(null);
    aiApplyingRef.current = false;
    setAiPreview((current) => {
      if (!current) return current;
      const belongs = current.nodes.every((node) => node.whiteboardId === board?.id);
      return belongs ? current : null;
    });
  }, [board?.id]);

  // camera / selection / preview session：開板還原、關板/切板時存。
  // 切對話會卸載本元件，模組層 session 讓工作記憶還在。
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  useEffect(() => {
    const id = board?.id;
    if (!id) return;
    const session = readBoardSession(id);
    const saved = session?.camera ?? CAMERA_MEMORY.get(id);
    const roomFocusNode = (session?.roomFocusId || apiRef.current.roomFocusId)
      ? nodes.find((item) => item.id === (session?.roomFocusId || apiRef.current.roomFocusId))
      : undefined;
    const restored = cameraAfterRemount({
      saved: saved ?? null,
      roomFocus: roomFocusNode ?? null,
      focusCamera: (node) => focusCamera(node as WhiteboardNode, viewport),
    });
    if (restored) {
      cameraRef.current = restored;
      setCamera(restored);
    }
    if (session?.selection?.length) setSelected(session.selection);
    if (session?.pendingPreview) setAiPreview(session.pendingPreview);
    return () => {
      writeBoardSession(id, {
        camera: cameraRef.current,
        selection: selectedRef.current,
        roomFocusId: apiRef.current.roomFocusId ?? session?.roomFocusId ?? null,
        pendingPreview: aiPreviewRef.current,
      });
      CAMERA_MEMORY.delete(id);
      CAMERA_MEMORY.set(id, cameraRef.current);
      if (CAMERA_MEMORY.size > 24) {
        const oldest = CAMERA_MEMORY.keys().next().value;
        if (oldest !== undefined) CAMERA_MEMORY.delete(oldest);
      }
    };
  }, [board?.id]);

  // 聚焦（深連結／討論卡／WB03 反向鏈）：每個 focusNodeId **只套一次**。
  // 舊寫法 deps 含 nodes/viewport 且無記帳 — 編輯時每個 keystroke 都
  // onUpsertNode("now") 換掉 nodes identity，相機就被拉回舊焦點、選取被
  // 搶走（與 camera memory、鍵盤避讓直接打架）。節點還沒載入時不記帳，
  // 下次 nodes 變動再試。
  const appliedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const focusId = api.focusNodeId;
    if (!focusId) {
      appliedFocusRef.current = null;
      return;
    }
    if (appliedFocusRef.current === focusId) return;
    const node = nodes.find((item) => item.id === focusId);
    if (!node) return;
    appliedFocusRef.current = focusId;
    setSelected([focusId]);
    setCamera(focusCamera(node, viewport));
  }, [api.focusNodeId, nodes, viewport]);

  const liveNodes = previewNodes ?? nodes;
  const rendered = useMemo(
    () => paintOrder(visibleNodes(liveNodes.filter((node) => !node.deletedAt), camera, viewport)),
    [liveNodes, camera, viewport],
  );
  const orderedFrames = useMemo(() => paintOrder(frames), [frames]);
  const hits = search.trim() ? findNodes(liveNodes, search) : [];

  // ---- 鍵盤避讓（audit §2 [major]）：編輯節點必須在鍵盤上緣之上 ----
  // deps 含 camera/viewport/liveNodes（Grok wb02 F6）：Android 是 resize
  // 模式 — inset≈0 但 canvas 高度（viewport.height）本身縮了，靠
  // ResizeObserver 餵進來的新 viewport 觸發重算；iOS 是 overlay 模式 —
  // inset>0 由 visualViewport 算出。位移後條件收斂（screenBottom==limit）
  // 不迴圈。
  useEffect(() => {
    if (!editingId || viewport.height <= 0) return;
    const node = liveNodes.find((item) => item.id === editingId);
    if (!node) return;
    const screenBottom = (node.y + node.height) * camera.zoom + camera.y;
    const limit = viewport.height - keyboardInset - 72; // 72 = 情境列餘裕
    if (screenBottom > limit) {
      setCamera((current) => ({ ...current, y: current.y - (screenBottom - limit) }));
    }
  }, [editingId, keyboardInset, camera, viewport, liveNodes]);

  // ---- 編輯 session：進出各記一次，session 結束才入 op/undo ----
  // record 不進 setState updater（Grok wb02 F3）：React 在 StrictMode 會
  // 雙呼 updater 驗證純度，副作用放裡面＝一次編輯入兩筆 undo、發兩個 op。
  const editingIdRef = useRef<string | null>(null);
  const beginEdit = useCallback((node: WhiteboardNode) => {
    editStartNode.current = node;
    editingIdRef.current = node.id;
    setEditingId(node.id);
  }, []);
  const endEdit = useCallback(() => {
    const start = editStartNode.current;
    const current = editingIdRef.current;
    editStartNode.current = null;
    editingIdRef.current = null;
    setEditingId(null);
    if (start && current === start.id) {
      const now = (previewRef.current ?? nodes).find((item) => item.id === start.id);
      if (now) record(nodeUpdateDraft(nextOpId(), start, now));
    }
  }, [nodes, record]);

  // ---- 手勢效果執行 ----
  const runEffects = (effects: GestureEffect[], event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    for (const effect of effects) {
      switch (effect.kind) {
        case "hit-test": {
          const world = screenToWorld(camera, effect.screen.x - rect.left, effect.screen.y - rect.top);
          const hit = hitTest(liveNodes.filter((node) => !node.deletedAt), world.x, world.y);
          if (hit) {
            if (connectMode) {
              if (!connectFrom) setConnectFrom(hit.id);
              else if (connectFrom !== hit.id) {
                const edge: WhiteboardEdge = {
                  id: nextOpId(),
                  whiteboardId: board!.id,
                  roomId: board!.roomId,
                  sourceNodeId: connectFrom,
                  targetNodeId: hit.id,
                  edgeType: "default",
                  label: "",
                  createdAt: Date.now(),
                  sourceHandle: "auto",
                  targetHandle: "auto",
                };
                api.onCreateEdge(edge);
                setConnectFrom(null);
                setConnectMode(false);
              }
              gesture.current = { ...gesture.current, mode: "idle" };
              break;
            }
            if (multiSelect || event.shiftKey) {
              setSelected((current) => current.includes(hit.id) ? current.filter((id) => id !== hit.id) : [...current, hit.id]);
              endEdit();
              gesture.current = gestureReducer(gesture.current, { type: "begin-pan", point: effect.screen }).state;
              gesture.current = { ...gesture.current, mode: "idle" };
              break;
            }
            const nextSelected = selected.includes(hit.id) ? selected : [hit.id];
            setSelected(nextSelected);
            setSelectedFrameId(null);
            if (editingId !== hit.id) endEdit();
            if (canEdit && !hit.locked) {
              const world2 = screenToWorld(camera, effect.screen.x - rect.left, effect.screen.y - rect.top);
              dragStartNodes.current = new Map(
                liveNodes.filter((node) => nextSelected.includes(node.id)).map((node) => [node.id, node]),
              );
              gesture.current = gestureReducer(gesture.current, { type: "begin-drag", ids: nextSelected, world: world2 }).state;
            } else {
              gesture.current = { ...gesture.current, mode: "idle" };
            }
            break;
          }
          // 空白處：工具態決定 框選/套索/平移
          endEdit();
          setSelected([]);
          setSelectedFrameId(null);
          const world3 = screenToWorld(camera, effect.screen.x - rect.left, effect.screen.y - rect.top);
          if (selectTool === "marquee") {
            gesture.current = gestureReducer(gesture.current, { type: "begin-marquee", world: world3 }).state;
            setMarquee({ a: world3, b: world3 });
          } else if (selectTool === "lasso") {
            gesture.current = gestureReducer(gesture.current, { type: "begin-lasso", world: world3 }).state;
            setLassoPath([world3]);
          } else {
            gesture.current = gestureReducer(gesture.current, { type: "begin-pan", point: effect.screen }).state;
          }
          break;
        }
        case "cancel-drag":
          previewRef.current = null;
          setPreviewNodes(null);
          dragStartNodes.current = null;
          api.onDragState?.(null);
          break;
        case "move-nodes": {
          if (!canEdit || !gesture.current.dragIds.length) break;
          const base = previewRef.current ?? liveNodes;
          const moved = moveNodes(base, gesture.current.dragIds, effect.dxWorld, effect.dyWorld);
          previewRef.current = moved;
          setPreviewNodes(moved);
          api.onDragState?.(gesture.current.dragIds);
          break;
        }
        case "pan":
          setCamera((current) => ({ ...current, x: current.x + effect.dx, y: current.y + effect.dy }));
          break;
        case "pinch-zoom": {
          // 縮放（中點錨定）＋雙指平移（中點位移）— gestures 缺陷 3 的修補
          setCamera((current) => {
            const zoomed = zoomAt(
              current,
              effect.mid.x - rect.left,
              effect.mid.y - rect.top,
              clampZoom(current.zoom * effect.scale),
            );
            return { ...zoomed, x: zoomed.x + effect.midDelta.x, y: zoomed.y + effect.midDelta.y };
          });
          break;
        }
        case "marquee-update": {
          const world = screenToWorld(camera, effect.b.x - rect.left, effect.b.y - rect.top);
          setMarquee((current) => (current ? { ...current, b: world } : current));
          break;
        }
        case "marquee-commit":
          setMarquee((current) => {
            if (current) setSelected(marqueeHits(liveNodes, current.a, current.b));
            return null;
          });
          break;
        case "lasso-update": {
          const world = screenToWorld(camera, event.clientX - rect.left, event.clientY - rect.top);
          setLassoPath((current) => (current ? [...current, world] : current));
          break;
        }
        case "lasso-commit":
          setLassoPath((current) => {
            if (current) setSelected(lassoHits(liveNodes, current));
            return null;
          });
          break;
        case "commit-drag": {
          // 放手即入房態（Grok wb02 F4）：原本走 120ms debounce，preview 先
          // 清、房態還沒更新 → 每次放手節點跳回起點再彈回。onUpsertNodes
          // 的樂觀更新是同步的，同一個 handler 內清 preview 不會閃。
          const source = previewRef.current ?? liveNodes;
          const ids = gesture.current.dragIds.length ? gesture.current.dragIds : [...(dragStartNodes.current?.keys() ?? [])];
          const movedNodes = source.filter((node) => {
            if (!ids.includes(node.id)) return false;
            const before = dragStartNodes.current?.get(node.id);
            return !before || before.x !== node.x || before.y !== node.y;
          });
          if (movedNodes.length) {
            api.onUpsertNodes(movedNodes);
            // undo/op：每個實際移動的節點一筆 move draft
            for (const node of movedNodes) {
              const before = dragStartNodes.current?.get(node.id);
              if (before) record(nodeUpdateDraft(nextOpId(), before, node));
            }
          }
          previewRef.current = null;
          setPreviewNodes(null);
          dragStartNodes.current = null;
          api.onDragState?.(null);
          break;
        }
        case "long-press-armed":
          if (longPressTimer.current) window.clearTimeout(longPressTimer.current);
          longPressTimer.current = window.setTimeout(() => {
            const world = screenToWorld(camera, event.clientX - rect.left, event.clientY - rect.top);
            const hit = hitTest(liveNodes.filter((node) => !node.deletedAt), world.x, world.y);
            if (hit) {
              setMultiSelect(true);
              setSelected((current) => Array.from(new Set([...current, hit.id])));
            } else {
              // 長按空白 = 新增選單（wireflow；原實作是死碼）
              setSheet("add");
            }
          }, LONG_PRESS_MS);
          break;
        case "long-press-cancelled":
          if (longPressTimer.current) {
            window.clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
          break;
        case "double-tap": {
          const world = screenToWorld(camera, effect.screen.x - rect.left, effect.screen.y - rect.top);
          const hit = hitTest(liveNodes.filter((node) => !node.deletedAt), world.x, world.y);
          if (hit) {
            if (canEdit && !hit.locked) beginEdit(hit);
            setCamera(focusCamera(hit, viewport, camera.zoom * 1.12));
          } else if (canEdit) {
            // 點兩下空白 = 快速便利貼（wireflow）
            addAt(world, "text");
          }
          break;
        }
        case "tap":
          break;
      }
    }
  };

  const feed = (input: Parameters<typeof gestureReducer>[1], event: ReactPointerEvent<HTMLDivElement>) => {
    const out = gestureReducer(gesture.current, input);
    gesture.current = out.state;
    runEffects(out.effects, event);
  };

  // ---- 繪圖（WB03）：單指直接收筆畫、繞過 reducer；第二指落下＝取消
  // 筆畫並把兩個 down 補進 reducer（轉 pinch 縮放）。 ----
  /** pointerType 正規化（N7）：未知/缺值當滑鼠處理，不硬轉型別。 */
  const pointerKind = (event: { pointerType?: string }): PointerKind =>
    event.pointerType === "pen" ? "pen" : event.pointerType === "touch" ? "touch" : "mouse";

  const finalizeStroke = (discard: boolean) => {
    const points = strokeRef.current;
    strokeRef.current = null;
    strokePointerRef.current = null;
    strokeDownRef.current = null;
    strokeScreenRef.current = null;
    setStrokePreview(null);
    if (discard || !points || !board) return;
    const normalized = normalizeStroke(thinStroke(points, 2.5 / camera.zoom));
    if (!normalized) return; // 誤觸（單點）不成節點
    const pressureContent = normalized.pressures.length ? { pressures: normalized.pressures } : {};
    const node: WhiteboardNode = {
      id: nextOpId(),
      whiteboardId: board.id,
      roomId: board.roomId,
      nodeType: "freehand",
      x: normalized.x,
      y: normalized.y,
      width: normalized.width,
      height: normalized.height,
      content: { points: normalized.points, color: "#e8c27a", strokeWidth: 3, ...pressureContent },
      createdBy: "local",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    };
    api.onUpsertNode(node, "now");
    record(nodeCreateDraft(nextOpId(), node));
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("textarea, input, button, a")) return;
    const kind = pointerKind(event);
    // 掌拒（WB05）：筆在畫的時候，手掌落在畫布上不得中斷筆畫。
    // 只擋**新**的 touch — 已經在手勢狀態機裡的 pointer 一律放行，
    // 否則它的 up 被吞掉、永遠留在 pointers map，下一次單指按下就被
    // 當成第二指直接進 pinch（Grok wb05 F1 實抓：先用手指按著再拿筆寫）。
    if (!gesture.current.pointers.has(event.pointerId) && shouldRejectPointer(penRef.current, kind, performance.now())) return;
    // 第二支筆：整個事件丟掉（兩人共用一台平板時，B 的筆不得打斷 A 正在
    // 寫的字）。**這個判斷必須在 penDown 之前** —— penDown 會把
    // penPointerId 覆寫成第二支筆的 id，之後再比就永遠相等、守衛失效。
    if (
      kind === "pen" &&
      penRef.current.penPointerId !== null &&
      penRef.current.penPointerId !== event.pointerId &&
      strokePointerRef.current !== null
    ) {
      return;
    }
    if (kind === "pen") penRef.current = penDown(penRef.current, event.pointerId);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* programmatic pointer events cannot capture */
    }
    // 筆優先（N1 修正）：筆預設就是畫，**但工具列選了別的工具時筆要聽話**。
    // 原本無條件短路，等於觸控筆再也選不到節點、拖不動、雙擊編輯不了、
    // 連線與框選全滅 —— 平板使用者沒有第二種指標可以退回。
    const penDraws = kind === "pen" && selectTool === "off" && !connectMode;
    if ((drawMode || penDraws) && canEdit) {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      // 手指起的筆畫遇到筆落下（N3）：手指那筆作廢，讓筆接手 —— 不作廢的話
      // 筆會被當成第二個 pointer 進 pinch，畫面暴縮。
      if (kind === "pen" && strokePointerRef.current !== null && strokePointerRef.current !== event.pointerId) {
        finalizeStroke(true);
      }
      if (strokePointerRef.current === null) {
        strokePointerRef.current = event.pointerId;
        const world = { ...screenToWorld(camera, event.clientX - rect.left, event.clientY - rect.top), pressure: kind === "pen" ? event.pressure : undefined };
        strokeRef.current = [world];
        setStrokePreview([world]);
        strokeDownRef.current = { pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, time: performance.now() };
        strokeScreenRef.current = { x: event.clientX, y: event.clientY };
        return;
      }
      // 第二指：取消當前筆畫，轉 pinch。回放第一指用**當前**座標（S1 —
      // 用起筆點會讓 pinch 基準距離錯到起筆位移那麼多，起手即暴縮），
      // 且回放不經 runEffects（S2 — down 的 hit-test 副作用會誤選節點/
      // 誤起 drag；回放只為重建 pointers map）。
      const first = strokeDownRef.current;
      const firstAt = strokeScreenRef.current ?? first?.point ?? null;
      finalizeStroke(true);
      if (first && firstAt) {
        const restored = gestureReducer(gesture.current, {
          type: "down",
          pointerId: first.pointerId,
          point: { x: firstAt.x, y: firstAt.y },
          time: performance.now(),
        });
        gesture.current = restored.state; // 丟棄 effects：不 hit-test、不 arm 長按計時器
      }
      feed({ type: "down", pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, time: performance.now() }, event);
      return;
    }
    feed({ type: "down", pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, time: performance.now() }, event);
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const kind = pointerKind(event);
    if (!gesture.current.pointers.has(event.pointerId) && shouldRejectPointer(penRef.current, kind, performance.now())) return;
    if (strokePointerRef.current === event.pointerId && strokeRef.current) {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      strokeScreenRef.current = { x: event.clientX, y: event.clientY };
      const world: StrokePoint = {
        ...screenToWorld(camera, event.clientX - rect.left, event.clientY - rect.top),
        pressure: kind === "pen" ? event.pressure : undefined,
      };
      const last = strokeRef.current[strokeRef.current.length - 1];
      // 螢幕 2px 以下抖動不收（世界距離 × zoom）
      if (Math.hypot(world.x - last.x, world.y - last.y) * camera.zoom < 2) return;
      strokeRef.current = [...strokeRef.current, world];
      setStrokePreview(strokeRef.current);
      return;
    }
    feed({ type: "move", pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, time: performance.now(), zoom: camera.zoom }, event);
  };
  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const kind = pointerKind(event);
    if (kind === "pen") penRef.current = penUp(penRef.current, event.pointerId, performance.now());
    // up 永遠要讓已追蹤的 pointer 通過（見 down 的註解）
    else if (!gesture.current.pointers.has(event.pointerId) && shouldRejectPointer(penRef.current, kind, performance.now())) return;
    if (strokePointerRef.current === event.pointerId) {
      finalizeStroke(event.type === "pointercancel");
      return;
    }
    feed({ type: "up", pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, time: performance.now() }, event);
  };

  // ---- frame 拖曳/縮放（WB03）：把手自帶 handler＋pointer capture，
  // stopPropagation 不進畫布手勢 reducer。成員判定凍結在起拖。 ----
  const beginFrameDrag = (event: ReactPointerEvent<HTMLDivElement>, frame: WhiteboardFrame, mode: "move" | "resize") => {
    // 繪圖模式、**觸控筆**（筆優先不開 drawMode — Grok wb05 F4）與唯讀者
    // （把手＝平移死區）都不攔 — 不 stopPropagation，事件冒泡回畫布走
    // 筆畫/平移。
    if (drawMode || event.pointerType === "pen" || !canEdit) return;
    // 掌拒也要管到把手（N6）：筆在寫的時候手掌壓在標題帶上，原本會把整個
    // 區塊連同成員節點拖走。
    if (shouldRejectPointer(penRef.current, pointerKind(event), performance.now())) return;
    // S3：已有進行中的 frame session 時，第二指不得覆寫（先到先贏）
    if (frameDragRef.current) return;
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* 程式性事件不能 capture */
    }
    const members = mode === "move" && canEdit
      ? liveNodes.filter((node) =>
          !node.deletedAt &&
          node.x + node.width / 2 >= frame.x && node.x + node.width / 2 <= frame.x + frame.width &&
          node.y + node.height / 2 >= frame.y && node.y + node.height / 2 <= frame.y + frame.height)
      : [];
    frameDragRef.current = {
      mode,
      pointerId: event.pointerId,
      frame,
      startClient: { x: event.clientX, y: event.clientY },
      memberIds: members.map((node) => node.id),
      startNodes: new Map(members.map((node) => [node.id, node])),
      moved: false,
    };
    setFramePreviewSync(frame);
    api.onFrameDragState?.(frame.id);
  };
  const onFramePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = frameDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!canEdit) return;
    if (!session.moved && Math.hypot(event.clientX - session.startClient.x, event.clientY - session.startClient.y) < 6) return;
    session.moved = true;
    const dx = (event.clientX - session.startClient.x) / camera.zoom;
    const dy = (event.clientY - session.startClient.y) / camera.zoom;
    if (session.mode === "move") {
      setFramePreviewSync({ ...session.frame, x: session.frame.x + dx, y: session.frame.y + dy });
      if (session.memberIds.length) {
        // 成員節點跟著：以起拖快照為基準做**絕對**定位（不疊增量 — F4 教訓）
        const movedById = new Map(
          [...session.startNodes.values()].map((node) => [node.id, { ...node, x: node.x + dx, y: node.y + dy }]),
        );
        const merged = liveNodes.map((node) => movedById.get(node.id) ?? node);
        previewRef.current = merged;
        setPreviewNodes(merged);
        api.onDragState?.(session.memberIds);
      }
    } else {
      setFramePreviewSync({
        ...session.frame,
        width: Math.min(8000, Math.max(120, session.frame.width + dx)),
        height: Math.min(8000, Math.max(90, session.frame.height + dy)),
      });
    }
  };
  const onFramePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = frameDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    frameDragRef.current = null;
    api.onFrameDragState?.(null);
    event.stopPropagation();
    const preview = framePreviewRef.current;
    setFramePreviewSync(null);
    if (!session.moved || !preview) {
      // tap：選取 frame（與節點選取互斥）
      endEdit();
      setSelected([]);
      setSelectedFrameId(session.frame.id);
      api.onDragState?.(null);
      return;
    }
    if (session.mode === "move") {
      const dx = preview.x - session.frame.x;
      const dy = preview.y - session.frame.y;
      api.onUpdateFrame?.(preview);
      if (session.memberIds.length) {
        const movedNodes = [...session.startNodes.values()].map((node) => ({ ...node, x: node.x + dx, y: node.y + dy }));
        api.onUpsertNodes(movedNodes);
        for (const node of movedNodes) {
          const before = session.startNodes.get(node.id);
          if (before) record(nodeUpdateDraft(nextOpId(), before, node));
        }
      }
      // frame 的 draft 最後入帳：單次 undo 先復原 frame（一個手勢多筆 op
      // 的複合 undo 屬 WB04 — 誠實限制）
      record(frameUpdateDraft(nextOpId(), session.frame, preview));
    } else {
      api.onUpdateFrame?.(preview);
      record(frameUpdateDraft(nextOpId(), session.frame, preview));
    }
    previewRef.current = null;
    setPreviewNodes(null);
    api.onDragState?.(null);
  };
  const commitFrameRename = () => {
    const frame = frames.find((item) => item.id === selectedFrameId);
    setFrameRenaming(false);
    if (!frame || !frameTitleDraft.trim() || frameTitleDraft.trim() === frame.title) return;
    const next = { ...frame, title: frameTitleDraft.trim().slice(0, 120) };
    api.onUpdateFrame?.(next);
    record(frameUpdateDraft(nextOpId(), frame, next));
  };

  const addAt = (world: { x: number; y: number }, type: NodeType, content?: WhiteboardNode["content"], linked?: Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId" | "anchor" | "sourceVersionId">) => {
    if (!board || !canEdit) return;
    const node = type === "text"
      ? createSticky({ whiteboardId: board.id, roomId: board.roomId, createdBy: "local", x: world.x - 90, y: world.y - 48 })
      : {
          ...createSticky({ whiteboardId: board.id, roomId: board.roomId, createdBy: "local", x: world.x - 90, y: world.y - 48 }),
          nodeType: type,
          content: content ?? { text: type === "flow" ? "新步驟" : type === "mindmap" ? "主題" : "" },
          ...linked,
        };
    if (type !== "text") {
      node.nodeType = type;
      node.content = content ?? node.content;
    }
    api.onUpsertNode(node, "now");
    record(nodeCreateDraft(nextOpId(), node));
    setSelected([node.id]);
    beginEdit(node);
    setSheet(null);
    return node;
  };

  const addAtView = (type: NodeType, content?: WhiteboardNode["content"], linked?: Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId" | "anchor" | "sourceVersionId">) =>
    addAt(screenToWorld(camera, viewport.width / 2, viewport.height / 2), type, content, linked);

  const deleteSelected = () => {
    for (const id of selected) {
      const node = liveNodes.find((item) => item.id === id);
      if (node && !node.locked) {
        record(nodeDeleteDraft(nextOpId(), node));
        api.onDeleteNode(id);
      }
    }
    setSelected([]);
  };

  const toggleLock = () => {
    const node = liveNodes.find((item) => item.id === selected[0]);
    if (!node) return;
    api.onUpsertNode(applyNodePatch(node, {}), "now");
    api.onUpsertNode({ ...node, locked: !node.locked }, "now");
  };

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600);
  };
  const skippedText = (skipped: string) =>
    skipped === "conflict-drift" ? "已跳過：這步之後被其他人改過" : skipped === "missing-node" ? "已跳過：節點已不存在" : "已跳過：不支援的操作";
  /** 還原之後舊的 undo/redo 不再對得上現況 — 清掉比留著誤導安全（P7）。 */
  const resetHistory = () => setHistory(emptyHistory());
  const runUndo = () => {
    const result = undoStep(historyRef.current, executors, nextOpId());
    setHistory(result.stack);
    if (result.applied) api.onEmitOperation?.(result.applied);
    if (result.skipped) showNotice(skippedText(result.skipped));
  };
  const runRedo = () => {
    const result = redoStep(historyRef.current, executors, nextOpId());
    setHistory(result.stack);
    if (result.applied) api.onEmitOperation?.(result.applied);
    if (result.skipped) showNotice(skippedText(result.skipped));
  };
  const executors = {
    upsert: (node: WhiteboardNode) => api.onUpsertNode(node, "now" as const),
    softDelete: (id: string) => api.onDeleteNode(id),
    recreate: (draft: OperationDraft) => {
      if (!board) return;
      const base: WhiteboardNode = {
        id: draft.entityId,
        whiteboardId: board.id,
        roomId: board.roomId,
        nodeType: "text",
        x: 0,
        y: 0,
        width: 180,
        height: 96,
        content: {},
        createdBy: "local",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };
      api.onUpsertNode(applyMasked(base, draft.fieldMask, draft.after), "now");
    },
    findNode: (id: string) => liveNodes.find((item) => item.id === id),
    // ---- frame（WB03） ----
    upsertFrame: (frame: WhiteboardFrame) => api.onUpdateFrame?.(frame),
    deleteFrame: (id: string) => api.onDeleteFrame?.(id),
    recreateFrame: (draft: OperationDraft) => {
      if (!board || !api.onCreateFrame) return;
      const base: WhiteboardFrame = {
        id: draft.entityId,
        whiteboardId: board.id,
        roomId: board.roomId,
        title: "區塊",
        x: 0,
        y: 0,
        width: 480,
        height: 320,
        kind: "frame",
        style: {},
        zIndex: -1,
        createdBy: "local",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
      };
      api.onCreateFrame(applyFrameMasked(base, draft.fieldMask, draft.after));
    },
    findFrame: (id: string) => frames.find((item) => item.id === id),
  };

  const placeBranch = (branch: RoomBranch, range?: { startTime?: number; endTime?: number }) => {
    if (!board) return;
    const version = latestBranchVersion(api.room, branch.id);
    const summary = branchSummary(api.room, branch.id);
    const plan: PlanDocument | undefined = api.room.plans?.find((item) => item.branchId === branch.id);
    addAtView("room_content", {
      title: branch.name,
      mediaKind: branch.branchType === "copy" ? "plan" : branch.branchType,
      versionLabel: version?.label ?? summary.latestLabel,
      openCommentCount: summary.openCommentCount,
      thumbnailUrl: version?.kind === "image" && version.imageDataUrl && !version.imageDataUrl.startsWith("data:")
        ? version.imageDataUrl
        : undefined,
      subtitle: plan ? `更新於 ${relative(plan.updatedAt)}` : undefined,
      duration: version?.duration,
      startTime: range?.startTime,
      endTime: range?.endTime,
    }, { linkedEntityType: "branch", linkedEntityId: branch.id });
    setPendingVideo(null);
    setPendingPoster(null);
    setPendingPlan(null);
  };

  const placePosterRegion = (branch: RoomBranch, mark?: { region: AnnotationRegion; versionId: string; label: string }) => {
    const version = latestBranchVersion(api.room, branch.id);
    const extra = mark
      ? nodeFromImageRegion({ versionId: mark.versionId, region: mark.region, label: mark.label })
      : null;
    addAtView("room_content", {
      title: branch.name,
      mediaKind: "poster",
      versionLabel: version?.label,
      thumbnailUrl: version?.kind === "image" && version.imageDataUrl && !version.imageDataUrl.startsWith("data:")
        ? version.imageDataUrl
        : undefined,
      subtitle: extra?.subtitle,
    }, {
      linkedEntityType: extra?.link.linkedEntityType ?? "branch",
      linkedEntityId: extra?.link.linkedEntityId ?? branch.id,
      ...(extra ? { anchor: extra.anchor, sourceVersionId: extra.sourceVersionId } : {}),
    });
    setPendingPoster(null);
  };

  const placePlanSection = (branch: RoomBranch, section?: PlanBlock) => {
    const extra = nodeFromPlanSection({ branchId: branch.id, section: section ? { id: section.id, text: section.text } : undefined });
    const plan = api.room.plans?.find((item) => item.branchId === branch.id);
    addAtView("room_content", {
      title: branch.name,
      mediaKind: "plan",
      subtitle: extra.subtitle ?? plan?.title,
    }, {
      linkedEntityType: extra.link.linkedEntityType ?? "plan",
      linkedEntityId: extra.link.linkedEntityId ?? branch.id,
      anchor: extra.anchor,
    });
    setPendingPlan(null);
  };

  const placeAsset = (version: import("../../lib/types").Version) => {
    addAtView("room_content", {
      title: version.label,
      filename: version.mimeType,
      mediaKind: "asset",
      versionLabel: version.label,
      duration: version.duration,
      thumbnailUrl: version.kind === "image" && version.imageDataUrl && !version.imageDataUrl.startsWith("data:")
        ? version.imageDataUrl
        : undefined,
    }, { linkedEntityType: "version", linkedEntityId: version.id });
  };

  const pickBranch = (branch: RoomBranch) => {
    if (branch.branchType === "video") {
      setPendingVideo(branch);
      setVideoStart("00:40");
      setVideoEnd("");
      setSheet("video-range");
      return;
    }
    if (branch.branchType === "poster") {
      setPendingPoster(branch);
      setSheet("poster-region");
      return;
    }
    if (branch.branchType === "plan" || branch.branchType === "copy") {
      setPendingPlan(branch);
      setSheet("plan-section");
      return;
    }
    placeBranch(branch);
  };

  // 在場者（WB04）：只顯示開著同一塊板的人，名字去重、最多列 3 個
  const boardPeople = useMemo(() => {
    const seen = new Set<string>();
    return (api.boardPeople ?? []).filter((person) => {
      const key = person.userId || person.name;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [api.boardPeople]);
  const boardPeopleLabel = boardPeople.length
    ? `${boardPeople.slice(0, 2).map((person) => person.name || "夥伴").join("、")}${boardPeople.length > 2 ? ` 等 ${boardPeople.length} 人` : ""} 也在`
    : "";

  const selectedNode = liveNodes.find((node) => node.id === selected[0]);
  const focusNodeId = focusNodeIdFromSelection(selected);
  const focusCard = selectedNode ? focusCardFromNode(selectedNode) : null;
  const colleagueSaid = lastColleagueForFocus(api.room.discussion ?? [], focusCard?.nodeId);
  const emptyBoard = isEmptyBoard(liveNodes);
  const roomName = emptyRoomTitle(api.room.title);
  const phoneFocusSheet = shouldMountFocusSheet({
    width: chromeWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
    hasFocus: Boolean(selectedNode),
  });
  useEffect(() => {
    api.onSelectionFocus?.(focusNodeId);
  }, [focusNodeId, api]);
  const polls: RoomPoll[] = api.room.polls ?? [];

  if (!board) return <BoardList api={api} />;

  const sheetLayer = (
    <>
      {sheet === "add" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="新增到白板">
            <div className="project-sheet-grip" />
            <div className="wb-sheet">
              <h3>加到白板上</h3>
              <div className="wb-options">
                {ADD_OPTIONS.map((item) => (
                  <button type="button" key={item.label} onClick={() => {
                    if (item.type === "content" || item.type === "image") {
                      setContentKind(item.type === "image" ? "asset" : "all");
                      setSheet("content");
                      return;
                    }
                    addAtView(item.type);
                  }}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {sheet === "content" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="房間內容">
            <div className="project-sheet-grip" />
            <RoomContentPicker room={api.room} onPick={pickBranch} onPickAsset={placeAsset} initialKind={contentKind} />
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {sheet === "search" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="搜尋節點">
            <div className="wb-sheet">
              <h3>搜尋節點</h3>
              <input className="text-input wb-search" autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="擺攤、茶會、QR…" aria-label="搜尋節點" />
              <div className="wb-options">
                {hits.map((node) => (
                  <button type="button" key={node.id} onClick={() => { setSelected([node.id]); setCamera(focusCamera(node, viewport)); setSheet(null); }}>
                    {nodeSearchText(node) || node.nodeType}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {sheet === "more" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="更多">
            <div className="wb-sheet wb-more">
              <h3>更多</h3>
              <button type="button" className="wb-card" data-testid="whiteboard-search" onClick={() => setSheet("search")}>搜尋節點</button>
              <button type="button" className="wb-card" data-testid="whiteboard-arrange" disabled={!canEdit} onClick={() => {
                const next = arrangeBoard(nodes, edges);
                api.onUpsertNodes(next);
                setCamera(fitCamera(next, viewport));
                setSheet(null);
              }}>整理排列</button>
              {canEdit && api.onCreateFrame && (
                <button type="button" className="wb-card" data-testid="wb-create-frame" onClick={() => {
                  const world = screenToWorld(camera, viewport.width / 2, viewport.height / 2);
                  const frame: WhiteboardFrame = {
                    id: nextOpId(),
                    whiteboardId: board.id,
                    roomId: board.roomId,
                    title: "新區塊",
                    x: world.x - 240,
                    y: world.y - 160,
                    width: 480,
                    height: 320,
                    kind: "frame",
                    style: {},
                    zIndex: -1,
                    createdBy: "local",
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    version: 1,
                  };
                  api.onCreateFrame!(frame);
                  record(frameCreateDraft(nextOpId(), frame));
                  setSheet(null);
                }}>新增區塊（Frame）</button>
              )}
              {(api.onAskBoardAi || api.onAskColleague) && (
                <button type="button" className="wb-card" data-testid="wb-open-ai" onClick={() => { setSheet("ai"); setAiQuestion(""); }}>
                  問同事（會先給你看，再決定要不要放上去）
                </button>
              )}
              {api.onListVersions && api.onLoadVersion && (
                <button type="button" className="wb-card" data-testid="wb-open-versions" onClick={() => {
                  setSheet("versions");
                  setVersions(null);
                  void Promise.resolve(api.onListVersions!())
                    .then((list) => setVersions(list))
                    .catch(() => setVersions([]));
                }}>版本歷史</button>
              )}
              {api.canManageBoards && <button type="button" className="wb-card" onClick={() => { api.onArchiveBoard(board.id); api.onOpenBoard(null); setSheet(null); }}>封存這塊白板</button>}
              {api.canToggleOpenEdit && (
                <button type="button" className="wb-card" onClick={() => { api.onToggleAllowEdit(); setSheet(null); }}>
                  {api.allowBoardEdit ? "關閉大家一起編輯" : "允許大家一起編輯"}
                </button>
              )}
              <button type="button" className="wb-card" onClick={() => setSheet("poll")}>放入既有投票</button>
              {api.canManageBoards && (
                <button
                  type="button"
                  className="wb-card"
                  data-testid="wb-create-poll"
                  onClick={() => { setPollQuestion(""); setPollOptions(["", ""]); setSheet("poll-create"); }}
                >＋投票</button>
              )}
              {api.canManageBoards && (
                <button
                  type="button"
                  className="wb-card"
                  data-testid="wb-write-decision"
                  onClick={() => { setDecisionTitle(""); setSheet("decision"); }}
                >寫下決策</button>
              )}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {sheet === "ai" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="問 AI">
            <div className="project-sheet-grip" />
            <div className="wb-sheet" data-testid="wb-ai-sheet">
              <h3>問同事</h3>
              <p className="project-muted">
                Grok 會依這塊板上的焦點給建議，先以虛線顯示在板上 —— 你看過再決定要不要放上去。
                {selected.length ? `目前會以選取的 ${selected.length} 個節點為重點。` : ""}
              </p>
              <input
                className="text-input wb-search"
                autoFocus
                value={aiQuestion}
                onChange={(event) => setAiQuestion(event.target.value)}
                placeholder="例如：把這些點子整理成三個方向"
                aria-label="想問 AI 什麼"
              />
              <button type="button" className="project-save-button project-submit" data-testid="wb-ai-ask" disabled={aiBusy || !aiQuestion.trim()} onClick={async () => {
                if (!api.onAskBoardAi && !api.onAskColleague) return;
                setAiBusy(true);
                try {
                  const askSeq = (aiAskSeqRef.current += 1);
                  // 板內「看看建議」只走預覽。同事氣泡留給焦點卡／@Grok／空板，
                  // 預覽階段不准寫討論（create_comment 也要等人採用）。
                  if (!api.onAskBoardAi) {
                    api.onAskColleague?.({ prompt: aiQuestion.trim(), nodeId: focusNodeId ?? undefined });
                    setSheet(null);
                    return;
                  }
                  const preview = await api.onAskBoardAi(aiQuestion.trim(), {
                    nodes: liveNodes.filter((node) => !node.deletedAt),
                    selectedIds: selected,
                    // F3：預覽要出現在**使用者正在看的地方**，不是固定座標
                    centerWorld: screenToWorld(camera, viewport.width / 2, viewport.height / 2),
                  });
                  // 使用者在等待期間按了取消／關掉 sheet：這批結果作廢
                  // （不然預覽會自己冒出來 — 自審抓到）
                  if (askSeq !== aiAskSeqRef.current) return;
                  setSheet(null);
                  if (!preview.nodes.length) {
                    showNotice("AI 這次沒有可以放上白板的建議");
                    setAiPreview(null);
                    return;
                  }
                  setAiPreview(preview);
                } catch {
                  showNotice("AI 沒有回應，白板沒有任何變動");
                } finally {
                  setAiBusy(false);
                }
              }}>{aiBusy ? "想一下…" : "看看建議"}</button>
            </div>
            <button type="button" className="project-sheet-close" onClick={() => { aiAskSeqRef.current += 1; setSheet(null); }}>取消</button>
          </section>
        </div>
      )}
      {sheet === "versions" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="版本歷史">
            <div className="project-sheet-grip" />
            <div className="wb-sheet" data-testid="wb-versions">
              <h3>版本歷史</h3>
              {versionPreview ? (
                <>
                  <p><strong>{versionPreview.version.label || "快照"}</strong> · {relative(versionPreview.version.createdAt)}</p>
                  <p className="project-muted" data-testid="wb-restore-summary">
                    還原會：{describeRestore(planRestore(versionPreview.snapshot, { nodes: liveNodes, edges, frames }))}
                    {versionPreview.dropped ? `（有 ${versionPreview.dropped} 筆內容格式不符，已略過）` : ""}
                  </p>
                  <button type="button" className="project-save-button project-submit" data-testid="wb-restore-confirm" disabled={!canEdit || versionBusy} onClick={async () => {
                    setVersionBusy(true);
                    try {
                      const result = await api.onRestoreVersion!(versionPreview.snapshot);
                      // 只說真話：離線時是「排隊中」，不是「已還原」
                      showNotice(result.queued
                        ? `已套用 ${result.applied} 筆，離線中會在回網後送出`
                        : result.applied ? `已還原（${result.applied} 筆）` : "沒有需要變更的內容");
                      resetHistory(); // 還原後舊的 undo/redo 不再對得上
                      setSheet(null);
                      setVersionPreview(null);
                    } catch {
                      showNotice("還原沒有完成，畫面維持現狀");
                    } finally {
                      setVersionBusy(false);
                    }
                  }}>確認還原</button>
                  <button type="button" className="wb-card" onClick={() => setVersionPreview(null)}>看其他版本</button>
                </>
              ) : (
                <>
                  <p className="project-muted">存一張快照，之後可以整塊板回到那時候。還原是逐筆寫回，走一樣的版本檢查。</p>
                  {canEdit && api.onSnapshotBoard && (
                    <button type="button" className="project-save-button project-submit" data-testid="wb-snapshot" disabled={versionBusy} onClick={async () => {
                      setVersionBusy(true);
                      try {
                        await api.onSnapshotBoard!(`${new Date().toLocaleString("zh-TW", { hour12: false })} 的快照`);
                        setVersions(await api.onListVersions!());
                        showNotice("已存下這一刻的快照");
                      } catch (error) {
                        showNotice(error instanceof Error && error.message === "snapshot-too-large"
                          ? "這塊板超過 2000 個內容，存不了快照"
                          : "快照沒存成功，請再試一次");
                      } finally {
                        setVersionBusy(false);
                      }
                    }}>存一張快照</button>
                  )}
                  <div className="wb-options">
                    {versions === null && <p className="project-muted">載入中…</p>}
                    {versions?.length === 0 && <p className="project-muted">還沒有快照。先存一張，之後才有得回去。</p>}
                    {(versions ?? []).map((version) => (
                      <button type="button" className="wb-card" key={version.id} data-testid={`wb-version-${version.id}`} disabled={versionBusy} onClick={async () => {
                        setVersionBusy(true);
                        try {
                          const loaded = await api.onLoadVersion!(version.id);
                          setVersionPreview({ version, ...loaded });
                        } catch {
                          showNotice("這個版本讀不出來");
                        } finally {
                          setVersionBusy(false);
                        }
                      }}>
                        <span>
                          <strong>{version.label || "快照"}</strong>
                          <small>{relative(version.createdAt)}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => { setSheet(null); setVersionPreview(null); }}>關閉</button>
          </section>
        </div>
      )}
      {sheet === "poll-create" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="新增投票">
            <div className="wb-sheet" data-testid="wb-poll-draft">
              <h3>新增投票</h3>
              <p className="project-muted">題目與至少兩個選項要人填。空題目不是投票。AI 不能代建。</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const write = boardPollWrite(pollQuestion, pollOptions);
                  if (!write) return;
                  const id = api.onCreatePoll(write.question, write.options);
                  if (id) addAtView("poll", { pollQuestion: write.question, voteCount: 0 }, { linkedEntityType: "poll", linkedEntityId: String(id) });
                  setPollQuestion("");
                  setPollOptions(["", ""]);
                  setSheet(null);
                }}
              >
                <input
                  className="text-input wb-search"
                  autoFocus
                  value={pollQuestion}
                  onChange={(event) => setPollQuestion(event.target.value)}
                  aria-label="投票題目"
                  placeholder="例如：主視覺要不要換？"
                  data-testid="wb-poll-question"
                />
                {pollOptions.map((option, index) => (
                  <input
                    key={index}
                    className="text-input wb-search"
                    value={option}
                    onChange={(event) => {
                      const next = [...pollOptions];
                      next[index] = event.target.value;
                      setPollOptions(next);
                    }}
                    aria-label={`選項 ${index + 1}`}
                    placeholder={`選項 ${index + 1}`}
                    data-testid={`wb-poll-option-${index}`}
                  />
                ))}
                {pollOptions.length < 6 && (
                  <button
                    type="button"
                    className="project-text-button"
                    data-testid="wb-poll-add-option"
                    onClick={() => setPollOptions((current) => [...current, ""])}
                  >加選項</button>
                )}
                <button
                  type="submit"
                  className="project-save-button project-submit"
                  data-testid="wb-create-poll-save"
                  disabled={!boardPollWrite(pollQuestion, pollOptions)}
                >建立投票</button>
              </form>
            </div>
            <button type="button" className="project-sheet-close" onClick={() => { setPollQuestion(""); setPollOptions(["", ""]); setSheet(null); }}>取消</button>
          </section>
        </div>
      )}
      {sheet === "deadline" && selectedNode && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="設定期限">
            <form
              className="wb-sheet"
              data-testid="wb-deadline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const value = String(new FormData(event.currentTarget).get("day") ?? "");
                const startAt = value ? new Date(`${value}T00:00:00+08:00`).getTime() : Date.now();
                api.onNodeDeadline?.(selectedNode, startAt);
                setSheet(null);
              }}
            >
              <h3>設定期限</h3>
              <label>日期<input type="date" name="day" required /></label>
              <button type="submit">加入時程</button>
            </form>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {sheet === "decision" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="寫下決策">
            <div className="wb-sheet" data-testid="wb-decision-draft">
              <h3>寫下決策</h3>
              <p className="project-muted">標題要人填。AI 不能代替成員確認。</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const write = boardDecisionWrite(decisionTitle);
                  if (!write) return;
                  api.onCreateDecision(write.title, undefined, write.status);
                  addAtView("decision", { text: write.title, sourceLabel: "決策區" });
                  setDecisionTitle("");
                  setSheet(null);
                }}
              >
                <input
                  className="text-input wb-search"
                  autoFocus
                  value={decisionTitle}
                  onChange={(event) => setDecisionTitle(event.target.value)}
                  aria-label="決策標題"
                  placeholder="例如：主視覺採 B"
                  data-testid="wb-decision-title"
                />
                <button
                  type="submit"
                  className="project-save-button project-submit"
                  data-testid="wb-write-decision-save"
                  disabled={!boardDecisionWrite(decisionTitle)}
                >寫下</button>
              </form>
            </div>
            <button type="button" className="project-sheet-close" onClick={() => { setDecisionTitle(""); setSheet(null); }}>取消</button>
          </section>
        </div>
      )}
      {sheet === "poll" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="放入投票">
            <div className="wb-sheet" data-testid="wb-poll-picker">
              <h3>放入既有投票</h3>
              <div className="wb-options">
                {polls.map((poll) => (
                  <button type="button" className="wb-card" key={poll.id} onClick={() => { addAtView("poll", { pollQuestion: poll.question, voteCount: (api.room.pollVotes ?? []).filter((vote) => vote.pollId === poll.id).length }, { linkedEntityType: "poll", linkedEntityId: poll.id }); }}>
                    {poll.question} · {(api.room.pollVotes ?? []).filter((vote) => vote.pollId === poll.id).length} 人已投
                  </button>
                ))}
                {!polls.length && <p className="project-muted">這個房間還沒有投票。可用「＋投票」建立一則。</p>}
              </div>
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {sheet === "video-range" && pendingVideo && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="影片時間">
            <div className="wb-sheet" data-testid="wb-video-range">
              <h3>{pendingVideo.name}</h3>
              <p className="project-muted">整段放上白板，或指定時間點／片段。卡片只記時間，不會預載整支影片。</p>
              <button type="button" className="wb-card" data-testid="wb-video-whole" onClick={() => placeBranch(pendingVideo)}>整段</button>
              <button type="button" className="wb-card" data-testid="wb-video-0040" onClick={() => placeBranch(pendingVideo, { startTime: 40 })}>從 00:40</button>
              <label className="project-field">
                <span>開始</span>
                <input className="text-input" value={videoStart} onChange={(event) => setVideoStart(event.target.value)} aria-label="影片開始時間" placeholder="00:40" />
              </label>
              <label className="project-field">
                <span>結束（可空）</span>
                <input className="text-input" value={videoEnd} onChange={(event) => setVideoEnd(event.target.value)} aria-label="影片結束時間" placeholder="00:45" />
              </label>
              <button type="button" className="project-save-button project-submit" onClick={() => {
                const startTime = parseTimestamp(videoStart);
                const endTime = parseTimestamp(videoEnd);
                placeBranch(pendingVideo, { startTime, endTime });
              }}>放入白板</button>
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {sheet === "poster-region" && pendingPoster && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="文宣範圍">
            <div className="wb-sheet" data-testid="wb-poster-region">
              <h3>{pendingPoster.name}</h3>
              <p className="project-muted">整張放上白板，或放入文宣上已圈選的範圍。卡片只記座標，不改原稿。</p>
              <button type="button" className="wb-card" data-testid="wb-poster-whole" onClick={() => placePosterRegion(pendingPoster)}>整張</button>
              {posterRegionMarks(api.room, pendingPoster.id).map((mark) => (
                <button type="button" className="wb-card" key={mark.pinId} data-testid={`wb-poster-region-${mark.pinId}`} onClick={() => placePosterRegion(pendingPoster, mark)}>
                  {mark.label}
                </button>
              ))}
              {!posterRegionMarks(api.room, pendingPoster.id).length && (
                <p className="project-muted">這張文宣還沒有圈選範圍。到文宣上圈選後再放上白板。</p>
              )}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {sheet === "plan-section" && pendingPlan && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="企劃段落">
            <div className="wb-sheet" data-testid="wb-plan-section">
              <h3>{pendingPlan.name}</h3>
              {(() => {
                const plan = api.room.plans?.find((item) => item.branchId === pendingPlan.id);
                const paragraphs = planParagraphs(plan);
                return (
                  <>
                    <p className="project-muted">
                      {paragraphs.omitted
                        ? "企劃段落還沒載入，先放整份企劃。"
                        : "整份放上白板，或指定一個段落。"}
                    </p>
                    <button type="button" className="wb-card" data-testid="wb-plan-whole" onClick={() => placePlanSection(pendingPlan)}>整份企劃</button>
                    {paragraphs.blocks.map((block) => (
                      <button type="button" className="wb-card" key={block.id} data-testid={`wb-plan-section-${block.id}`} onClick={() => placePlanSection(pendingPlan, block)}>
                        {block.text.slice(0, 48) || "空段落"}
                      </button>
                    ))}
                  </>
                );
              })()}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
    </>
  );

  // ---- Focus Mode：portal 到 body 的 fixed 全屏層（wireflow §9） ----
  return createPortal(
    <div
      className={`wb-focus${api.railVisible ? " is-rail-open" : ""}${selectedNode ? " is-node-focus" : ""}`}
      data-testid="whiteboard-workspace"
      data-focus-node-id={focusNodeId ?? ""}
      data-room-focus-id={api.roomFocusId ?? ""}
      data-rail-inline={api.railVisible ? "true" : "false"}
      data-focus-sheet={phoneFocusSheet ? "true" : "false"}
    >
      <header className="wb-focus-top">
        <button type="button" className="project-back-button" onClick={() => window.history.back()} aria-label="回到白板列表">‹</button>
        {renaming && api.canManageBoards ? (
          <form className="wb-rename" onSubmit={(event) => { event.preventDefault(); if (renameDraft.trim()) api.onRenameBoard(board.id, renameDraft.trim()); setRenaming(false); }}>
            <input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} aria-label="白板名稱" />
          </form>
        ) : (
          <h2 onClick={() => { if (api.canManageBoards) { setRenameDraft(board.title); setRenaming(true); } }}>{board.title}</h2>
        )}
        <span className="wb-online" data-testid="wb-presence" title={boardPeopleLabel}>
          {api.online > 0 ? `${api.online}` : "1"} 人
          {/* 名字要看得見（P11）：手機沒有 hover，只放 title 等於沒做。
              數字與名單同語意 — 都是「除了我以外還有誰」。 */}
          {boardPeople.length ? (
            <em data-testid="wb-board-people">{boardPeopleLabel}</em>
          ) : null}
        </span>
        <button type="button" onClick={runUndo} disabled={!history.undo.length} aria-label="復原" data-testid="wb-undo">↺</button>
        <button type="button" onClick={runRedo} disabled={!history.redo.length} aria-label="重做" data-testid="wb-redo">↻</button>
        {api.onToggleRail && (
          <button
            type="button"
            className="wb-rail-toggle"
            data-testid="wb-rail-toggle"
            aria-label={api.railVisible ? "收起討論" : "顯示討論"}
            aria-pressed={Boolean(api.railVisible)}
            onClick={api.onToggleRail}
          >{api.railVisible ? "☰" : "☰ 討論"}</button>
        )}
        <button type="button" onClick={() => setSheet("more")} aria-label="更多" data-testid="whiteboard-more">⋯</button>
        <span hidden data-testid="wb-stats" data-nodes={nodes.length} data-edges={edges.length} data-flow={nodes.filter((node) => node.nodeType === "flow").length} data-mindmap={nodes.filter((node) => node.nodeType === "mindmap").length} />
      </header>

      {api.editors[0] ? <div className="wb-editing-line">{formatEditorLine(api.editors[0], board.title)}</div> : null}

      <div className="wb-focus-main">
      <div
        ref={wrapRef}
        className="wb-focus-canvas"
        data-testid="wb-canvas"
        data-multi-select={multiSelect ? "true" : "false"}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
      >
        <div className="wb-layer" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
          {orderedFrames.map((rawFrame) => {
            const frame = framePreview && framePreview.id === rawFrame.id ? framePreview : rawFrame;
            const frameSelected = selectedFrameId === frame.id;
            return (
              <div key={frame.id} className={`wb-frame wb-frame-${frame.kind}${frameSelected ? " is-selected" : ""}`} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} data-testid={`wb-frame-${frame.id}`}>
                <div
                  className="wb-frame-handle"
                  data-testid={`wb-frame-handle-${frame.id}`}
                  onPointerDown={(event) => beginFrameDrag(event, rawFrame, "move")}
                  onPointerMove={onFramePointerMove}
                  onPointerUp={onFramePointerUp}
                  onPointerCancel={onFramePointerUp}
                >
                  <span className="wb-frame-title">{frame.title}</span>
                </div>
                {canEdit && frameSelected && (
                  <div
                    className="wb-frame-resize"
                    aria-label="調整區塊大小"
                    data-testid={`wb-frame-resize-${frame.id}`}
                    onPointerDown={(event) => beginFrameDrag(event, rawFrame, "resize")}
                    onPointerMove={onFramePointerMove}
                    onPointerUp={onFramePointerUp}
                    onPointerCancel={onFramePointerUp}
                  />
                )}
              </div>
            );
          })}
          <svg className="wb-edge" width={4000} height={4000} style={{ left: 0, top: 0 }}>
            {edges.map((edge) => {
              const source = liveNodes.find((node) => node.id === edge.sourceNodeId);
              const target = liveNodes.find((node) => node.id === edge.targetNodeId);
              if (!source || !target || source.deletedAt || target.deletedAt) return null;
              const x1 = source.x + source.width / 2;
              const y1 = source.y + source.height / 2;
              const x2 = target.x + target.width / 2;
              const y2 = target.y + target.height / 2;
              return <line key={edge.id} x1={x1} y1={y1} x2={x2} y2={y2} stroke={edge.edgeType === "mindmap" ? "#8a7ab0" : edge.edgeType === "flow" ? "#6aa0b8" : "#7d7469"} strokeWidth={2} data-testid={`wb-edge-${edge.id}`} />;
            })}
          </svg>
          {rendered.map((node) => (
            <NodeView
              key={node.id}
              node={node}
              selected={selected.includes(node.id)}
              editing={editingId === node.id}
              canEdit={canEdit}
              connectSource={connectFrom === node.id}
              onChangeText={(text) => api.onUpsertNode(applyNodePatch(node, { content: { ...node.content, text } }), "now")}
            />
          ))}
          {/* WB06 AI 預覽：虛線幽靈節點，pointer-events:none —— 它們還不是
              板上的東西，點不到也拖不動，按「套用」才會變成真的。 */}
          {aiPreview?.nodes.map((node) => (
            <div
              key={node.id}
              className="wb-node wb-node-ai-preview"
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              data-testid={`wb-ai-preview-${node.id}`}
            >
              <span className="wb-node-static">{node.content.text || node.content.title || "AI 建議"}</span>
            </div>
          ))}
          {marquee && (
            <div
              className="wb-marquee"
              style={{
                left: Math.min(marquee.a.x, marquee.b.x),
                top: Math.min(marquee.a.y, marquee.b.y),
                width: Math.abs(marquee.b.x - marquee.a.x),
                height: Math.abs(marquee.b.y - marquee.a.y),
              }}
            />
          )}
          {lassoPath && lassoPath.length > 1 && (
            <svg className="wb-edge" width={4000} height={4000} style={{ left: 0, top: 0 }}>
              <polyline points={lassoPath.map((point) => `${point.x},${point.y}`).join(" ")} fill="rgba(196,92,74,0.08)" stroke="#c45c4a" strokeDasharray="6 4" strokeWidth={1.5} />
            </svg>
          )}
          {strokePreview && strokePreview.length > 1 && (
            <svg className="wb-edge" width={4000} height={4000} style={{ left: 0, top: 0 }} data-testid="wb-stroke-preview">
              {/* 預覽也要逐段線寬（Grok wb05 F6）：畫的時候固定粗細、抬筆
                  才變粗細不一，線條會「跳」一下 */}
              {strokePreview.some((point) => typeof point.pressure === "number")
                ? segmentWidths(strokePreview.map((point) => point.pressure), 3).map((width, index) => (
                    <line
                      key={index}
                      x1={strokePreview[index].x}
                      y1={strokePreview[index].y}
                      x2={strokePreview[index + 1].x}
                      y2={strokePreview[index + 1].y}
                      stroke="#e8c27a"
                      strokeWidth={width}
                      strokeLinecap="round"
                    />
                  ))
                : <polyline points={strokePreview.map((point) => `${point.x},${point.y}`).join(" ")} fill="none" stroke="#e8c27a" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
          )}
        </div>

        {multiSelect && (
          <div className="wb-multiselect" data-testid="wb-multiselect">
            <span>已選 {selected.length} 個</span>
            <button type="button" onClick={() => setMultiSelect(false)}>完成</button>
          </div>
        )}
        {emptyBoard && (
          <div className="wb-empty-board" data-testid="wb-empty-board">
            <strong>{roomName.label}</strong>
            {roomName.unnamed && api.onRenameRoom ? (
              <button type="button" className="project-text-button" data-testid="wb-rename-room" onClick={() => {
                const next = window.prompt("活動房名稱", roomName.label);
                if (next?.trim()) api.onRenameRoom?.(next.trim());
              }}>改名稱</button>
            ) : null}
            <p>這塊板還是空的。選一個下一步：</p>
            <div className="wb-empty-verbs">
              {emptyBoardVerbs().map((verb) => (
                <button
                  type="button"
                  key={verb.id}
                  data-testid={`wb-empty-${verb.id}`}
                  onClick={() => {
                    if (verb.id === "pin-discussion") {
                      if (api.onPinFromDiscussion) api.onPinFromDiscussion();
                      else if (api.onToggleRail && !api.railVisible) api.onToggleRail();
                      else api.onOpenDiscussionMessage?.("");
                    } else if (verb.id === "add-asset") {
                      setContentKind("all");
                      setSheet("content");
                    } else if (verb.id === "ask-grok") {
                      if (api.onAskColleague) api.onAskColleague({ prompt: "我們下一步做什麼" });
                      else setSheet("ai");
                    }
                  }}
                >{verb.label}</button>
              ))}
            </div>
          </div>
        )}
        {notice && <div className="wb-notice" data-testid="wb-notice">{notice}</div>}
        {connectMode && (
          <div className="wb-connect-hint" data-testid="wb-connect-hint">
            <span>{connectFrom ? "點另一個節點完成連線" : "點第一個節點"}</span>
            <button type="button" onClick={() => { setConnectMode(false); setConnectFrom(null); }}>取消</button>
          </div>
        )}
        {phoneFocusSheet && selectedNode && focusCard && (
          <div className="wb-focus-sheet" data-testid="wb-focus-sheet" style={{ bottom: "var(--kb, 0px)" }}>
            <DragSheet
              snap={focusSheetSnap}
              onSnap={setFocusSheetSnap}
              viewportHeight={typeof window === "undefined" ? 640 : window.innerHeight}
              peekHeight={120}
              handle={(
                <>
                  <span className="m-sheet-summary">焦點 · {focusCard.title}</span>
                  <button
                    type="button"
                    className="wb-context-dismiss"
                    data-testid="wb-focus-sheet-dismiss"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => { setSelected([]); endEdit(); }}
                    aria-label="取消選取"
                  >✕</button>
                </>
              )}
            >
              <div className="wb-focus-card is-in-sheet" data-testid="wb-focus-card">
                <strong>{focusCard.title}</strong>
                <small>來源：{focusCard.sourceLabel}</small>
                {focusCard.openCommentCount > 0 ? <small>未完成修改點 {focusCard.openCommentCount}</small> : null}
                {focusCard.lastWriter ? <small>最後寫：{focusCard.lastWriter}</small> : null}
                {colleagueSaid ? <small data-testid="wb-colleague-said">{colleagueSaid}</small> : null}
                <div className="wb-focus-card-actions" data-testid="wb-node-actions">
                  <button type="button" onClick={() => { if (!selectedNode.locked) beginEdit(selectedNode); }} disabled={Boolean(selectedNode.locked)}>編輯</button>
                  {(selectedNode.nodeType === "flow" || selectedNode.nodeType === "text" || selectedNode.nodeType === "mindmap") && (
                    <button type="button" data-testid="wb-next-step" onClick={() => {
                      const next = addFlowNextStep(selectedNode, "下一步", "local", nodes);
                      api.onUpsertNode(next.node, "now");
                      api.onCreateEdge(next.edge);
                      record(nodeCreateDraft(nextOpId(), next.node));
                      setSelected([next.node.id]);
                      beginEdit(next.node);
                      setCamera(focusCamera(next.node, viewport, camera.zoom));
                    }}>+ 下一步</button>
                  )}
                  {(selectedNode.nodeType === "mindmap" || selectedNode.nodeType === "text") && (
                    <button type="button" data-testid="wb-add-child" onClick={() => {
                      const next = addMindmapChild(selectedNode.nodeType === "mindmap" ? selectedNode : { ...selectedNode, nodeType: "mindmap" }, "子項目", "local", edges, nodes);
                      api.onUpsertNode(next.node, "now");
                      api.onCreateEdge(next.edge);
                      record(nodeCreateDraft(nextOpId(), next.node));
                      setSelected([next.node.id]);
                      beginEdit(next.node);
                      setCamera(focusCamera(next.node, viewport, camera.zoom));
                    }}>+ 子項目</button>
                  )}
                  {selectedNode.nodeType === "room_content" && selectedNode.linkedEntityId && (
                    <button type="button" onClick={() => {
                      const open = contentOpenFromNode(selectedNode);
                      const target = openTarget(anchorFromNode(selectedNode));
                      if (target.surface === "content") {
                        api.onOpenContent(target.branchId, open);
                      } else {
                        api.onOpenContent(selectedNode.linkedEntityId!, open);
                      }
                    }}>打開內容</button>
                  )}
                  {discussionIdFromNode(selectedNode) && (
                    <button type="button" data-testid="wb-open-source-message" onClick={() => api.onOpenDiscussionMessage?.(discussionIdFromNode(selectedNode)!)}>打開原訊息</button>
                  )}
                  <button type="button" data-testid="wb-share-focus" onClick={() => api.onSetRoomFocus?.(selectedNode.id)}>讓大家看這個</button>
                  {(api.onAskColleague || api.onAskBoardAi) && (
                    <button type="button" data-testid="wb-ask-colleague" onClick={() => {
                      if (api.onAskColleague) api.onAskColleague({ prompt: "針對這張，我們下一步做什麼？", nodeId: selectedNode.id });
                      else setSheet("ai");
                    }}>問同事</button>
                  )}
                  <button type="button" data-testid="wb-discuss-this" onClick={() => api.onShareNode(selectedNode)}>針對這張討論</button>
                  <button type="button" className="wb-context-dismiss" onClick={() => { setSelected([]); endEdit(); }} aria-label="取消選取">✕</button>
                </div>
              </div>
              <div className="wb-focus-sheet-discussion" data-testid="wb-focus-discussion">
                {api.discussionSlot ?? <p className="project-muted">針對這張留言</p>}
              </div>
            </DragSheet>
          </div>
        )}
      </div>

      {/* 底部：AI 預覽確認列 / frame 情境列 / 節點情境列 / 主工具列
          （wireflow §11）平板時 .wb-focus-main 讓它變成右側的一欄 */}
      {aiPreview ? (
        <nav className="wb-focus-bottom wb-context-bar wb-ai-bar" aria-label="AI 建議" data-testid="wb-ai-preview-bar">
          <span className="wb-ai-summary" data-testid="wb-ai-summary">{describePreview(aiPreview)}</span>
          <button type="button" className="project-save-button" data-testid="wb-ai-apply" disabled={!canEdit || aiBusy || !aiPreview.nodes.length} onClick={async () => {
            if (!api.onApplyBoardAi) return;
            if (aiApplyingRef.current) return; // F4：連點兩次會寫兩批
            aiApplyingRef.current = true;
            setAiBusy(true);
            try {
              const plan = planApply(aiPreview, nextOpId);
              const result = await api.onApplyBoardAi(plan, aiPreview);
              if (!result.applied && !result.queued) {
                showNotice("套用沒有完成，預覽還在，白板維持原狀");
                return;
              }
              // 進 undo 疊（F2）：AI 放上來的東西必須一鍵撤得掉 —— 尤其在
              // 快照沒存成功的時候，↺ 是使用者唯一的退路。
              for (const node of plan.nodes) record(nodeCreateDraft(nextOpId(), node));
              // 只說真話：離線是「排隊中」不是「已完成」；快照／稽核沒成功
              // 都要講出來（使用者事後才發現查無此事最傷）。
              const notes: string[] = [];
              if (!result.snapshotTaken) notes.push("這次沒能存快照");
              if (result.auditRecorded === false) notes.push("稽核紀錄沒寫成");
              const head = result.queued
                ? `已套用 ${result.applied} 項，離線中會在回網後送出`
                : `已套用 ${result.applied} 項`;
              showNotice(notes.length ? `${head}；${notes.join("、")}，按 ↺ 可以撤回` : `${head}（按 ↺ 可以撤回）`);
              setAiPreview(null);
            } catch {
              showNotice("套用沒有完成，預覽還在，白板維持原狀");
            } finally {
              aiApplyingRef.current = false;
              setAiBusy(false);
            }
          }}>套用</button>
          <button type="button" data-testid="wb-ai-discard" onClick={() => setAiPreview(null)}>取消</button>
        </nav>
      ) : selectedFrameId && frames.some((frame) => frame.id === selectedFrameId) && canEdit && !multiSelect ? (
        <nav className="wb-focus-bottom wb-context-bar" aria-label="區塊動作" data-testid="wb-frame-actions">
          {frameRenaming ? (
            <form className="wb-frame-rename" onSubmit={(event) => { event.preventDefault(); commitFrameRename(); }}>
              <input autoFocus value={frameTitleDraft} onChange={(event) => setFrameTitleDraft(event.target.value)} aria-label="區塊名稱" />
              <button type="submit">存</button>
            </form>
          ) : (
            <>
              <button type="button" data-testid="wb-frame-rename" onClick={() => {
                const frame = frames.find((item) => item.id === selectedFrameId);
                if (!frame) return;
                setFrameTitleDraft(frame.title);
                setFrameRenaming(true);
              }}>改名</button>
              <button type="button" data-testid="wb-frame-delete" onClick={() => {
                const frame = frames.find((item) => item.id === selectedFrameId);
                if (!frame) return;
                record(frameDeleteDraft(nextOpId(), frame));
                api.onDeleteFrame?.(frame.id);
                setSelectedFrameId(null);
              }}>刪除</button>
            </>
          )}
          <button type="button" className="wb-context-dismiss" onClick={() => { setSelectedFrameId(null); setFrameRenaming(false); }} aria-label="取消選取">✕</button>
        </nav>
      ) : selectedNode && canEdit && !multiSelect && !phoneFocusSheet ? (
        <nav className="wb-focus-bottom wb-context-bar" aria-label="節點動作" data-testid="wb-node-actions">
          <button type="button" onClick={() => { if (!selectedNode.locked) beginEdit(selectedNode); }} disabled={Boolean(selectedNode.locked)}>編輯</button>
          <button type="button" onClick={() => { setConnectMode(true); setConnectFrom(selectedNode.id); }}>連線</button>
          {(selectedNode.nodeType === "flow" || selectedNode.nodeType === "text" || selectedNode.nodeType === "mindmap") && (
            <button type="button" data-testid="wb-next-step" onClick={() => {
              const next = addFlowNextStep(selectedNode, "下一步", "local", nodes);
              api.onUpsertNode(next.node, "now");
              api.onCreateEdge(next.edge);
              record(nodeCreateDraft(nextOpId(), next.node));
              setSelected([next.node.id]);
              beginEdit(next.node);
              setCamera(focusCamera(next.node, viewport, camera.zoom));
            }}>+ 下一步</button>
          )}
          {(selectedNode.nodeType === "mindmap" || selectedNode.nodeType === "text") && (
            <button type="button" data-testid="wb-add-child" onClick={() => {
              const next = addMindmapChild(selectedNode.nodeType === "mindmap" ? selectedNode : { ...selectedNode, nodeType: "mindmap" }, "子項目", "local", edges, nodes);
              api.onUpsertNode(next.node, "now");
              api.onCreateEdge(next.edge);
              record(nodeCreateDraft(nextOpId(), next.node));
              setSelected([next.node.id]);
              beginEdit(next.node);
              setCamera(focusCamera(next.node, viewport, camera.zoom));
            }}>+ 子項目</button>
          )}
          {selectedNode.nodeType === "room_content" && selectedNode.linkedEntityId && (
            <button type="button" onClick={() => {
              const open = contentOpenFromNode(selectedNode);
              const target = openTarget(anchorFromNode(selectedNode));
              if (target.surface === "content") {
                api.onOpenContent(target.branchId, open);
              } else {
                api.onOpenContent(selectedNode.linkedEntityId!, open);
              }
            }}>打開內容</button>
          )}
          {selectedNode.linkedEntityType === "discussion" && selectedNode.linkedEntityId && (
            <button type="button" data-testid="wb-open-source-message" onClick={() => {
              const target = openTarget(anchorFromNode(selectedNode));
              if (target.surface !== "discussion") return;
              const exists = (api.room.discussion ?? []).some((message) => message.id === target.messageId);
              if (!exists) {
                showNotice("來源訊息已不存在");
                return;
              }
              api.onOpenDiscussionMessage?.(target.messageId);
            }}>打開原訊息</button>
          )}
          <button
            type="button"
            data-testid="wb-share-focus"
            onClick={() => {
              api.onSetRoomFocus?.(selectedNode.id);
              writeBoardSession(board.id, { roomFocusId: selectedNode.id, camera: cameraRef.current, selection: [selectedNode.id] });
              setCamera(focusCamera(selectedNode, viewport));
            }}
          >讓大家看這個</button>
          {(api.onAskColleague || api.onAskBoardAi) && (
            <button
              type="button"
              data-testid="wb-ask-colleague"
              onClick={() => {
                if (api.onAskColleague) api.onAskColleague({ prompt: "針對這張，我們下一步做什麼？", nodeId: selectedNode.id });
                else setSheet("ai");
              }}
            >問同事</button>
          )}
          <button type="button" data-testid="wb-discuss-this" onClick={() => api.onShareNode(selectedNode)}>針對這張討論</button>
          <button type="button" onClick={() => api.onShareNode(selectedNode)}>分享至討論</button>
          {api.onNodeDeadline && (
            <button type="button" data-testid="wb-set-deadline" onClick={() => setSheet("deadline")}>設定期限</button>
          )}
          {selected.length > 1 && (
            <>
              <button type="button" onClick={() => {
                const grouped = groupSelected(nodes, selected, "local");
                if (!grouped) return;
                api.onUpsertNode(grouped.group, "now");
                api.onUpsertNodes(grouped.nodes);
              }}>群組</button>
              <button type="button" onClick={() => createRelationEdges(board.id, board.roomId, selected).forEach(api.onCreateEdge)}>建立關係</button>
            </>
          )}
          <button type="button" data-testid="wb-lock" onClick={toggleLock}>{selectedNode.locked ? "解鎖" : "鎖定"}</button>
          <button type="button" onClick={deleteSelected} disabled={Boolean(selectedNode.locked)}>刪除</button>
          <button type="button" className="wb-context-dismiss" onClick={() => { setSelected([]); endEdit(); }} aria-label="取消選取">✕</button>
        </nav>
      ) : (
        <nav className="wb-focus-bottom" aria-label="白板工具" data-compact={chromeWidth < 768 ? "true" : "false"} data-testid="wb-compact-toolbar">
          <button
            type="button"
            className={selectTool !== "off" ? "is-active" : ""}
            data-testid="wb-tool-select"
            title={selectTool === "lasso" ? "套索" : selectTool === "marquee" ? "框選" : "選取"}
            aria-label={selectTool === "lasso" ? "套索" : selectTool === "marquee" ? "框選" : "選取"}
            onClick={() => { setSelectTool((current) => (current === "off" ? "marquee" : current === "marquee" ? "lasso" : "off")); setDrawMode(false); }}
          ><span>▣</span>{selectTool === "lasso" ? "套索" : selectTool === "marquee" ? "框選" : "選取"}</button>
          <button
            type="button"
            className={drawMode ? "is-active" : ""}
            data-testid="wb-tool-draw"
            title="畫筆"
            aria-label="畫筆"
            disabled={!canEdit}
            onClick={() => { setDrawMode((current) => !current); setConnectMode(false); setConnectFrom(null); setSelectTool("off"); }}
          ><span>✎</span>畫筆</button>
          <button type="button" data-testid="wb-tool-sticky" title="文字／便利貼" aria-label="文字／便利貼" disabled={!canEdit} onClick={() => addAtView("text")}><span>📝</span>文字／便利貼</button>
          <button
            type="button"
            className={connectMode ? "is-active" : ""}
            data-testid="wb-tool-connect"
            title="連線"
            aria-label="連線"
            disabled={!canEdit}
            onClick={() => { setConnectMode((current) => !current); setConnectFrom(null); setDrawMode(false); }}
          ><span>↦</span>連線</button>
          <button type="button" data-testid="whiteboard-add" title="加入" aria-label="加入" onClick={() => setSheet("add")} disabled={!canEdit}><span>＋</span>加入</button>
        </nav>
      )}

      </div>
      {sheetLayer}
      {focusCard && !phoneFocusSheet && (
        <aside className="wb-focus-card" data-testid="wb-focus-card">
          <strong>{focusCard.title}</strong>
          <small>來源：{focusCard.sourceLabel}</small>
          {focusCard.openCommentCount > 0 ? <small>未完成修改點 {focusCard.openCommentCount}</small> : null}
          {focusCard.lastWriter ? <small>最後寫：{focusCard.lastWriter}</small> : null}
          {colleagueSaid ? <small data-testid="wb-colleague-said">{colleagueSaid}</small> : null}
          {api.roomFocusId === focusCard.nodeId ? <small>大家正在看這張</small> : null}
        </aside>
      )}
    </div>,
    document.body,
  );
}
