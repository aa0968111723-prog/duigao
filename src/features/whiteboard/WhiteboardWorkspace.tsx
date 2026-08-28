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
import type { NodeType, PresenceEditor, Whiteboard, WhiteboardEdge, WhiteboardFrame, WhiteboardNode } from "../collaboration/types";
import { nodeCreateDraft, nodeDeleteDraft, nodeUpdateDraft, applyMasked, type OperationDraft } from "../collaboration/operations";
import { DRAG_PERSIST_MS, fitCamera, focusCamera, marqueeHits, screenToWorld, visibleNodes, zoomAt, clampZoom, type Camera } from "./canvas";
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
import { rendererFor } from "./registry";
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
  onOpenContent: (branchId: string, opts?: { startTime?: number; endTime?: number }) => void;
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
};

type Sheet = "add" | "search" | "content" | "more" | "poll" | "video-range" | null;

const ADD_OPTIONS: { type: NodeType | "content"; label: string }[] = [
  { type: "text", label: "便利貼" },
  { type: "flow", label: "流程" },
  { type: "mindmap", label: "心智圖" },
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

export function WhiteboardWorkspace({ api }: { api: WhiteboardApi }) {
  const board = api.boards.find((item) => item.id === api.activeBoardId && !item.archivedAt) ?? null;
  const canEdit = board ? canEditBoard(api.roleAllowsEdit ? "editor" : "reviewer", api.allowBoardEdit, board) && api.canEdit : false;
  const nodes = useMemo(() => api.nodes.filter((node) => node.whiteboardId === board?.id), [api.nodes, board?.id]);
  const edges = useMemo(() => api.edges.filter((edge) => edge.whiteboardId === board?.id), [api.edges, board?.id]);
  const frames = useMemo(() => (api.frames ?? []).filter((frame) => frame.whiteboardId === board?.id), [api.frames, board?.id]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 24, y: 24, zoom: 1 });
  const [selected, setSelected] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [search, setSearch] = useState("");
  const [viewport, setViewport] = useState({ width: 360, height: 520 });
  const [marquee, setMarquee] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const [lassoPath, setLassoPath] = useState<{ x: number; y: number }[] | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectTool, setSelectTool] = useState<"off" | "marquee" | "lasso">("off");
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [pendingVideo, setPendingVideo] = useState<RoomBranch | null>(null);
  const [videoStart, setVideoStart] = useState("00:40");
  const [videoEnd, setVideoEnd] = useState("");
  const [contentKind, setContentKind] = useState<"all" | "poster" | "video" | "plan" | "asset">("all");
  const [previewNodes, setPreviewNodes] = useState<WhiteboardNode[] | null>(null);
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
  const focused = Boolean(board);
  const poppingRef = useRef(false);
  const sheetRef = useRef<Sheet>(null);
  sheetRef.current = sheet;
  useEffect(() => {
    api.onFocusChange?.(focused);
    if (!focused) return;
    // 進 Focus：恰一層 history；back = 先關 sheet、再退出白板
    window.history.pushState({ layer: "board-focus" }, "");
    const onPop = () => {
      if (sheetRef.current) {
        setSheet(null);
        window.history.pushState({ layer: "board-focus" }, "");
        return;
      }
      poppingRef.current = true;
      api.onOpenBoard(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sheetRef.current) {
        setSheet(null);
        return;
      }
      window.history.back();
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("keydown", onKey);
      api.onFocusChange?.(false);
      // UI 返回（非 back 手勢）離開：吃掉自己 push 的那層，保持疊乾淨
      if (!poppingRef.current) window.history.back();
      poppingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, board?.id]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [board?.id]);

  useEffect(() => {
    if (!api.focusNodeId) return;
    const node = nodes.find((item) => item.id === api.focusNodeId);
    if (!node) return;
    setSelected([node.id]);
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
  useEffect(() => {
    if (!editingId || keyboardInset <= 0) return;
    const node = liveNodes.find((item) => item.id === editingId);
    if (!node) return;
    const screenBottom = (node.y + node.height) * camera.zoom + camera.y;
    const limit = viewport.height - keyboardInset - 72; // 72 = 情境列餘裕
    if (screenBottom > limit) {
      setCamera((current) => ({ ...current, y: current.y - (screenBottom - limit) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, keyboardInset]);

  const persistSoon = useRef<number | null>(null);
  const persistNodes = useCallback((next: WhiteboardNode[]) => {
    if (persistSoon.current) window.clearTimeout(persistSoon.current);
    persistSoon.current = window.setTimeout(() => {
      api.onUpsertNodes(next);
    }, DRAG_PERSIST_MS);
  }, [api]);

  // ---- 編輯 session：進出各記一次，session 結束才入 op/undo ----
  const beginEdit = useCallback((node: WhiteboardNode) => {
    editStartNode.current = node;
    setEditingId(node.id);
  }, []);
  const endEdit = useCallback(() => {
    const start = editStartNode.current;
    editStartNode.current = null;
    setEditingId((current) => {
      if (start && current === start.id) {
        const now = (previewNodes ?? nodes).find((item) => item.id === start.id);
        if (now) record(nodeUpdateDraft(nextOpId(), start, now));
      }
      return null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, previewNodes, record]);

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
          setPreviewNodes(null);
          dragStartNodes.current = null;
          api.onDragState?.(null);
          break;
        case "move-nodes": {
          if (!canEdit || !gesture.current.dragIds.length) break;
          const moved = moveNodes(previewNodes ?? liveNodes, gesture.current.dragIds, effect.dxWorld, effect.dyWorld);
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
          const source = previewNodes ?? liveNodes;
          const ids = gesture.current.dragIds.length ? gesture.current.dragIds : [...(dragStartNodes.current?.keys() ?? [])];
          const movedNodes = source.filter((node) => ids.includes(node.id));
          if (movedNodes.length) {
            persistNodes(movedNodes);
            // undo/op：每個實際移動的節點一筆 move draft
            for (const node of movedNodes) {
              const before = dragStartNodes.current?.get(node.id);
              if (before) record(nodeUpdateDraft(nextOpId(), before, node));
            }
          }
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

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("textarea, input, button, a")) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* programmatic pointer events cannot capture */
    }
    feed({ type: "down", pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, time: performance.now() }, event);
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    feed({ type: "move", pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, time: performance.now(), zoom: camera.zoom }, event);
  };
  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    feed({ type: "up", pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, time: performance.now() }, event);
  };

  const addAt = (world: { x: number; y: number }, type: NodeType, content?: WhiteboardNode["content"], linked?: Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId">) => {
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

  const addAtView = (type: NodeType, content?: WhiteboardNode["content"], linked?: Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId">) =>
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

  const runUndo = () => {
    const result = undoStep(historyRef.current, executors, nextOpId());
    setHistory(result.stack);
    if (result.applied) api.onEmitOperation?.(result.applied);
  };
  const runRedo = () => {
    const result = redoStep(historyRef.current, executors, nextOpId());
    setHistory(result.stack);
    if (result.applied) api.onEmitOperation?.(result.applied);
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
    placeBranch(branch);
  };

  const selectedNode = liveNodes.find((node) => node.id === selected[0]);
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
                  api.onCreateFrame!({
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
                  });
                  setSheet(null);
                }}>新增區塊（Frame）</button>
              )}
              {api.canManageBoards && <button type="button" className="wb-card" onClick={() => { api.onArchiveBoard(board.id); api.onOpenBoard(null); setSheet(null); }}>封存這塊白板</button>}
              {api.canToggleOpenEdit && (
                <button type="button" className="wb-card" onClick={() => { api.onToggleAllowEdit(); setSheet(null); }}>
                  {api.allowBoardEdit ? "關閉大家一起編輯" : "允許大家一起編輯"}
                </button>
              )}
              <button type="button" className="wb-card" onClick={() => setSheet("poll")}>放入既有投票</button>
              {api.canManageBoards && <button type="button" className="wb-card" data-testid="wb-create-poll" onClick={() => { const id = api.onCreatePoll("主視覺要不要換？", ["要，換成 B 版", "先維持 A 版"]); if (id) addAtView("poll", { pollQuestion: "主視覺要不要換？", voteCount: 0 }, { linkedEntityType: "poll", linkedEntityId: String(id) }); setSheet(null); }}>＋投票</button>}
              {api.canManageBoards && <button type="button" className="wb-card" data-testid="wb-write-decision" onClick={() => { api.onCreateDecision("已決定：採用 B 版", undefined, "decided"); addAtView("decision", { text: "已決定：採用 B 版", sourceLabel: "決策區" }); setSheet(null); }}>寫下決策</button>}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
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
    </>
  );

  // ---- Focus Mode：portal 到 body 的 fixed 全屏層（wireflow §9） ----
  return createPortal(
    <div className="wb-focus" data-testid="whiteboard-workspace">
      <header className="wb-focus-top">
        <button type="button" className="project-back-button" onClick={() => api.onOpenBoard(null)} aria-label="回到白板列表">‹</button>
        {renaming && api.canManageBoards ? (
          <form className="wb-rename" onSubmit={(event) => { event.preventDefault(); if (renameDraft.trim()) api.onRenameBoard(board.id, renameDraft.trim()); setRenaming(false); }}>
            <input autoFocus value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} aria-label="白板名稱" />
          </form>
        ) : (
          <h2 onClick={() => { if (api.canManageBoards) { setRenameDraft(board.title); setRenaming(true); } }}>{board.title}</h2>
        )}
        <span className="wb-online" data-testid="wb-presence">{api.online > 0 ? `${api.online}` : "1"} 人</span>
        <button type="button" onClick={runUndo} disabled={!history.undo.length} aria-label="復原" data-testid="wb-undo">↺</button>
        <button type="button" onClick={runRedo} disabled={!history.redo.length} aria-label="重做" data-testid="wb-redo">↻</button>
        <button type="button" onClick={() => setSheet("more")} aria-label="更多" data-testid="whiteboard-more">⋯</button>
        <span hidden data-testid="wb-stats" data-nodes={nodes.length} data-edges={edges.length} data-flow={nodes.filter((node) => node.nodeType === "flow").length} data-mindmap={nodes.filter((node) => node.nodeType === "mindmap").length} />
      </header>

      {api.editors[0] ? <div className="wb-editing-line">{formatEditorLine(api.editors[0], board.title)}</div> : null}

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
          {orderedFrames.map((frame) => (
            <div key={frame.id} className={`wb-frame wb-frame-${frame.kind}`} style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }} data-testid={`wb-frame-${frame.id}`}>
              <span className="wb-frame-title">{frame.title}</span>
            </div>
          ))}
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
        </div>

        {multiSelect && (
          <div className="wb-multiselect" data-testid="wb-multiselect">
            <span>已選 {selected.length} 個</span>
            <button type="button" onClick={() => setMultiSelect(false)}>完成</button>
          </div>
        )}
        {connectMode && (
          <div className="wb-connect-hint" data-testid="wb-connect-hint">
            <span>{connectFrom ? "點另一個節點完成連線" : "點第一個節點"}</span>
            <button type="button" onClick={() => { setConnectMode(false); setConnectFrom(null); }}>取消</button>
          </div>
        )}
      </div>

      {/* 底部：情境工具列（選取節點）或主工具列（三態，wireflow §11） */}
      {selectedNode && canEdit && !multiSelect ? (
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
              const target = openTarget(anchorFromNode(selectedNode));
              if (target.surface === "content") {
                api.onOpenContent(target.branchId, { startTime: selectedNode.content.startTime, endTime: selectedNode.content.endTime });
              } else {
                api.onOpenContent(selectedNode.linkedEntityId!, { startTime: selectedNode.content.startTime, endTime: selectedNode.content.endTime });
              }
            }}>打開內容</button>
          )}
          <button type="button" onClick={() => api.onShareNode(selectedNode)}>分享至討論</button>
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
        <nav className="wb-focus-bottom" aria-label="白板工具">
          <button
            type="button"
            className={selectTool !== "off" ? "is-active" : ""}
            data-testid="wb-tool-select"
            onClick={() => setSelectTool((current) => (current === "off" ? "marquee" : current === "marquee" ? "lasso" : "off"))}
          ><span>▣</span>{selectTool === "lasso" ? "套索" : selectTool === "marquee" ? "框選" : "選取"}</button>
          <button type="button" data-testid="wb-tool-sticky" disabled={!canEdit} onClick={() => addAtView("text")}><span>📝</span>便利貼</button>
          <button
            type="button"
            className={connectMode ? "is-active" : ""}
            data-testid="wb-tool-connect"
            disabled={!canEdit}
            onClick={() => { setConnectMode((current) => !current); setConnectFrom(null); }}
          ><span>↦</span>連線</button>
          <button type="button" data-testid="wb-tool-material" onClick={() => { setContentKind("all"); setSheet("content"); }}><span>▤</span>素材</button>
          <button type="button" data-testid="whiteboard-add" onClick={() => setSheet("add")} disabled={!canEdit}><span>＋</span>更多</button>
        </nav>
      )}

      {sheetLayer}
    </div>,
    document.body,
  );
}
