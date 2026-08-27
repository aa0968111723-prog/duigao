import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { PlanDocument, Room, RoomBranch, RoomPoll } from "../../lib/types";
import { branchSummary, branchTypeLabel, latestBranchVersion } from "../../lib/roomBranches";
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
} from "../collaboration/nodes";
import { arrangeBoard } from "../collaboration/layout";
import { canEditBoard } from "../collaboration/permissions";
import type { NodeType, PresenceEditor, Whiteboard, WhiteboardEdge, WhiteboardNode } from "../collaboration/types";
import { BROADCAST_THROTTLE_MS, DRAG_PERSIST_MS, LONG_PRESS_MS, focusCamera, marqueeHits, nodeHit, screenToWorld, visibleNodes, zoomAt, type Camera } from "./canvas";
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
  onCreateBoard: (title: string) => void;
  onArchiveBoard: (id: string) => void;
  onRenameBoard: (id: string, title: string) => void;
  onUpsertNode: (node: WhiteboardNode, persist?: "now" | "end") => void;
  onDeleteNode: (id: string) => void;
  onUpsertNodes: (nodes: WhiteboardNode[]) => void;
  onCreateEdge: (edge: WhiteboardEdge) => void;
  onShareNode: (node: WhiteboardNode) => void;
  onOpenContent: (branchId: string, opts?: { startTime?: number; endTime?: number }) => void;
  onCreatePoll: (question: string, options: string[]) => string | void;
  onCreateDecision: (title: string, source?: { type: "poll"; id: string }) => void;
  onToggleAllowEdit: () => void;
  allowBoardEdit: boolean;
  canToggleOpenEdit: boolean;
};

type Sheet = "add" | "search" | "content" | "more" | "create-board" | "poll" | null;

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
  onChangeText,
}: {
  node: WhiteboardNode;
  selected: boolean;
  editing: boolean;
  onChangeText: (text: string) => void;
}) {
  const content = node.content;
  const className = `wb-node wb-node-${node.nodeType} ${selected ? "is-selected" : ""} ${editing ? "is-editing" : ""}`;
  const style = { left: node.x, top: node.y, width: node.width, height: node.height };
  if (node.nodeType === "text" || (editing && (node.nodeType === "flow" || node.nodeType === "mindmap"))) {
    return (
      <div className={className} style={style} data-testid={`wb-node-${node.id}`} data-node-type={node.nodeType}>
        <textarea
          className="wb-node-text"
          value={content.text ?? ""}
          placeholder={node.nodeType === "text" ? "直接打字…" : "步驟"}
          onChange={(event) => onChangeText(event.target.value)}
          autoFocus={editing}
        />
      </div>
    );
  }
  if (node.nodeType === "room_content" || node.nodeType === "image") {
    return (
      <div className={`${className} wb-node-content`} style={style} data-testid={`wb-node-${node.id}`} data-node-type={node.nodeType}>
        {content.thumbnailUrl
          ? <img className="wb-thumb" src={content.thumbnailUrl} alt="" />
          : <span className="wb-thumb-fallback" aria-hidden>{content.mediaKind === "video" ? "▶" : content.mediaKind === "plan" ? "☷" : "▧"}</span>}
        <span className="wb-card-copy">
          <strong>{content.title ?? "房間內容"}</strong>
          <small>
            {content.versionLabel ? `${content.versionLabel}` : ""}
            {content.openCommentCount ? ` · ${content.openCommentCount} 則待處理` : ""}
            {content.startTime != null ? ` · ${formatVideoRange(content.startTime, content.endTime)}` : ""}
            {content.subtitle ? ` · ${content.subtitle}` : ""}
          </small>
        </span>
      </div>
    );
  }
  if (node.nodeType === "poll") {
    return (
      <div className={className} style={style} data-testid={`wb-node-${node.id}`} data-node-type="poll">
        <strong>{content.pollQuestion ?? content.title ?? "投票"}</strong>
        <small>{content.voteCount ?? 0} 人已投</small>
      </div>
    );
  }
  if (node.nodeType === "decision") {
    return (
      <div className={className} style={style} data-testid={`wb-node-${node.id}`} data-node-type="decision">
        <strong>✓ {content.text ?? content.title ?? "已決定"}</strong>
        {content.sourceLabel ? <small>{content.sourceLabel}</small> : null}
      </div>
    );
  }
  return (
    <div className={className} style={style} data-testid={`wb-node-${node.id}`} data-node-type={node.nodeType}>
      {content.text || content.title || node.nodeType}
    </div>
  );
});

function RoomContentPicker({ room, onPick }: { room: Room; onPick: (branch: RoomBranch) => void }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "poster" | "video" | "plan">("all");
  const branches = (room.branches ?? []).filter((branch) => branch.status !== "archived");
  const filtered = branches.filter((branch) => {
    if (kind !== "all" && branch.branchType !== kind && !(kind === "plan" && branch.branchType === "copy")) return false;
    return !query.trim() || branch.name.toLowerCase().includes(query.trim().toLowerCase());
  });
  return (
    <div className="wb-sheet" data-testid="wb-content-picker">
      <h3>放入房間內容</h3>
      <input className="text-input wb-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋檔名、標籤、類型…" aria-label="搜尋房間內容" />
      <div className="rd-tabs" style={{ marginTop: 0 }}>
        {(["all", "poster", "video", "plan"] as const).map((item) => (
          <button type="button" key={item} className={kind === item ? "is-active" : ""} onClick={() => setKind(item)}>
            {item === "all" ? "全部" : item === "poster" ? "文宣" : item === "video" ? "影片" : "企劃"}
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
        {!filtered.length && <p className="project-muted">這個房間還沒有符合的內容</p>}
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

export function WhiteboardWorkspace({ api }: { api: WhiteboardApi }) {
  const board = api.boards.find((item) => item.id === api.activeBoardId && !item.archivedAt) ?? null;
  const canEdit = board ? canEditBoard(api.roleAllowsEdit ? "editor" : "reviewer", api.allowBoardEdit, board) && api.canEdit : false;
  const nodes = useMemo(() => api.nodes.filter((node) => node.whiteboardId === board?.id), [api.nodes, board?.id]);
  const edges = useMemo(() => api.edges.filter((edge) => edge.whiteboardId === board?.id), [api.edges, board?.id]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 24, y: 24, zoom: 1 });
  const [selected, setSelected] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [search, setSearch] = useState("");
  const [viewport, setViewport] = useState({ width: 360, height: 520 });
  const [marquee, setMarquee] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const drag = useRef<{ ids: string[]; origin: { x: number; y: number }; last: { x: number; y: number } } | null>(null);
  const longPress = useRef<number | null>(null);
  const lastBroadcast = useRef(0);

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

  const rendered = useMemo(() => visibleNodes(nodes, camera, viewport), [nodes, camera, viewport]);
  const hits = search.trim() ? findNodes(nodes, search) : [];

  const persistSoon = useRef<number | null>(null);
  const persistNodes = useCallback((next: WhiteboardNode[]) => {
    if (persistSoon.current) window.clearTimeout(persistSoon.current);
    persistSoon.current = window.setTimeout(() => {
      api.onUpsertNodes(next);
    }, DRAG_PERSIST_MS);
  }, [api]);

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: camera.zoom };
      if (longPress.current) window.clearTimeout(longPress.current);
      return;
    }
    const rect = wrapRef.current!.getBoundingClientRect();
    const world = screenToWorld(camera, event.clientX - rect.left, event.clientY - rect.top);
    const hit = nodeHit(nodes, world.x, world.y);
    if (hit) {
      const nextSelected = event.shiftKey || selected.includes(hit.id) ? Array.from(new Set([...selected, hit.id])) : [hit.id];
      setSelected(nextSelected);
      setEditingId(null);
      drag.current = { ids: nextSelected, origin: world, last: world };
      longPress.current = window.setTimeout(() => {
        setSelected((current) => Array.from(new Set([...current, hit.id])));
      }, LONG_PRESS_MS);
      return;
    }
    if (event.shiftKey && !api.isMobile) {
      setMarquee({ a: world, b: world });
      return;
    }
    setSelected([]);
    setEditingId(null);
    drag.current = { ids: [], origin: world, last: { x: event.clientX, y: event.clientY } };
    longPress.current = window.setTimeout(() => {
      setSelected([]);
    }, LONG_PRESS_MS);
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const rect = wrapRef.current!.getBoundingClientRect();
      setCamera((current) => zoomAt(current, mid.x - rect.left, mid.y - rect.top, pinch.current!.zoom * (distance / pinch.current!.distance)));
      return;
    }
    if (marquee) {
      const rect = wrapRef.current!.getBoundingClientRect();
      const world = screenToWorld(camera, event.clientX - rect.left, event.clientY - rect.top);
      setMarquee({ ...marquee, b: world });
      return;
    }
    if (!drag.current) return;
    if (longPress.current) {
      window.clearTimeout(longPress.current);
      longPress.current = null;
    }
    if (!drag.current.ids.length) {
      const dx = event.clientX - drag.current.last.x;
      const dy = event.clientY - drag.current.last.y;
      drag.current.last = { x: event.clientX, y: event.clientY };
      setCamera((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
      return;
    }
    if (!canEdit) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    const world = screenToWorld(camera, event.clientX - rect.left, event.clientY - rect.top);
    const dx = world.x - drag.current.last.x;
    const dy = world.y - drag.current.last.y;
    drag.current.last = world;
    const moved = moveNodes(nodes, drag.current.ids, dx, dy);
    api.onUpsertNodes(moved.filter((node) => drag.current!.ids.includes(node.id)));
    const now = performance.now();
    if (now - lastBroadcast.current > BROADCAST_THROTTLE_MS) lastBroadcast.current = now;
  };

  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (longPress.current) {
      window.clearTimeout(longPress.current);
      longPress.current = null;
    }
    if (marquee) {
      setSelected(marqueeHits(nodes, marquee.a, marquee.b));
      setMarquee(null);
    }
    if (drag.current?.ids.length) {
      persistNodes(nodes.filter((node) => drag.current!.ids.includes(node.id)));
    }
    drag.current = null;
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const world = screenToWorld(camera, event.clientX - rect.left, event.clientY - rect.top);
    const hit = nodeHit(nodes, world.x, world.y);
    if (hit) {
      setEditingId(hit.id);
      setCamera(focusCamera(hit, viewport, camera.zoom * 1.12));
    }
  };

  const addAtView = (type: NodeType, content?: WhiteboardNode["content"], linked?: Pick<WhiteboardNode, "linkedEntityType" | "linkedEntityId">) => {
    if (!board || !canEdit) return;
    const world = screenToWorld(camera, viewport.width / 2, viewport.height / 2);
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
    setSelected([node.id]);
    setEditingId(node.id);
    setSheet(null);
  };

  const pickBranch = (branch: RoomBranch) => {
    if (!board) return;
    const version = latestBranchVersion(api.room, branch.id);
    const summary = branchSummary(api.room, branch.id);
    const plan: PlanDocument | undefined = api.room.plans?.find((item) => item.branchId === branch.id);
    const isVideo = branch.branchType === "video";
    addAtView("room_content", {
      title: branch.name,
      mediaKind: branch.branchType === "copy" ? "plan" : branch.branchType,
      versionLabel: isVideo ? version?.label ?? summary.latestLabel : version?.label ?? summary.latestLabel,
      openCommentCount: summary.openCommentCount,
      thumbnailUrl: version?.imageDataUrl && version.imageDataUrl.startsWith("data:") === false && version.kind !== "video"
        ? version.imageDataUrl
        : version?.kind === "image"
          ? version.imageDataUrl
          : undefined,
      subtitle: plan ? `更新於 ${relative(plan.updatedAt)}` : undefined,
      duration: version?.duration,
    }, { linkedEntityType: "branch", linkedEntityId: branch.id });
  };

  const selectedNode = nodes.find((node) => node.id === selected[0]);
  const polls: RoomPoll[] = api.room.polls ?? [];

  if (!board) return <BoardList api={api} />;

  return (
    <div className="wb-shell" data-testid="whiteboard-workspace">
      <div className="wb-toolbar">
        <button type="button" className="project-back-button" onClick={() => api.onOpenBoard(null)} aria-label="回到白板列表">‹</button>
        <h2>{board.title}</h2>
      </div>
      <div
        ref={wrapRef}
        className="wb-canvas-wrap"
        data-testid="wb-canvas"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
        onDoubleClick={onDoubleClick}
      >
        <div className="wb-presence" data-testid="wb-presence">
          <span>{api.online > 0 ? `${api.online} 人在線` : "只有你"}</span>
          {api.editors[0] ? <span>{api.editors[0].name}正在編輯「{api.editors[0].whiteboardTitle ?? board.title}」</span> : null}
        </div>
        <div className="wb-layer" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
          <svg className="wb-edge" width={4000} height={4000} style={{ left: 0, top: 0 }}>
            {edges.map((edge) => {
              const source = nodes.find((node) => node.id === edge.sourceNodeId);
              const target = nodes.find((node) => node.id === edge.targetNodeId);
              if (!source || !target) return null;
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
        </div>
        {selectedNode && canEdit && (
          <div className="wb-node-actions" data-testid="wb-node-actions">
            {(selectedNode.nodeType === "flow" || selectedNode.nodeType === "text") && (
              <button type="button" onClick={() => {
                const next = addFlowNextStep(selectedNode.nodeType === "flow" ? selectedNode : { ...selectedNode, nodeType: "flow" }, "下一步", "local", nodes);
                api.onUpsertNode(next.node, "now");
                api.onCreateEdge(next.edge);
                setSelected([next.node.id]);
                setEditingId(next.node.id);
              }}>+ 下一步</button>
            )}
            {(selectedNode.nodeType === "mindmap" || selectedNode.nodeType === "text") && (
              <button type="button" onClick={() => {
                const next = addMindmapChild(selectedNode.nodeType === "mindmap" ? selectedNode : { ...selectedNode, nodeType: "mindmap" }, "子項目", "local", edges, nodes);
                api.onUpsertNode(next.node, "now");
                api.onCreateEdge(next.edge);
                setSelected([next.node.id]);
                setEditingId(next.node.id);
              }}>+ 子項目</button>
            )}
            {selectedNode.nodeType === "room_content" && selectedNode.linkedEntityId && (
              <button type="button" onClick={() => api.onOpenContent(selectedNode.linkedEntityId!, { startTime: selectedNode.content.startTime, endTime: selectedNode.content.endTime })}>打開內容</button>
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
            <button type="button" onClick={() => { selected.forEach(api.onDeleteNode); setSelected([]); }}>刪除</button>
          </div>
        )}
        <nav className="wb-bottom" aria-label="白板工具">
          <button type="button" onClick={() => setSheet("add")} disabled={!canEdit}><span>＋</span>+</button>
          <button type="button" onClick={() => setSheet("search")}><span>⌕</span>搜尋</button>
          <button type="button" onClick={() => api.onUpsertNodes(arrangeBoard(nodes, edges))} disabled={!canEdit}><span>⊞</span>整理</button>
          <button type="button" onClick={() => setSheet("more")}><span>⋯</span>更多</button>
        </nav>
      </div>

      {sheet === "add" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="新增到白板">
            <div className="project-sheet-grip" />
            <div className="wb-sheet">
              <h3>加到白板上</h3>
              <div className="wb-options">
                {ADD_OPTIONS.map((item) => (
                  <button type="button" key={item.label} onClick={() => item.type === "content" ? setSheet("content") : addAtView(item.type)}>
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
            <RoomContentPicker room={api.room} onPick={pickBranch} />
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
              {api.canManageBoards && <button type="button" className="wb-card" onClick={() => { api.onArchiveBoard(board.id); api.onOpenBoard(null); setSheet(null); }}>封存這塊白板</button>}
              {api.canToggleOpenEdit && (
                <button type="button" className="wb-card" onClick={() => { api.onToggleAllowEdit(); setSheet(null); }}>
                  {api.allowBoardEdit ? "關閉大家一起編輯" : "允許大家一起編輯"}
                </button>
              )}
              <button type="button" className="wb-card" onClick={() => setSheet("poll")}>放入既有投票</button>
              {api.canManageBoards && <button type="button" className="wb-card" onClick={() => { const id = api.onCreatePoll("主視覺要不要換？", ["要，換成 B 版", "先維持 A 版"]); if (id) addAtView("poll", { pollQuestion: "主視覺要不要換？", voteCount: 0 }, { linkedEntityType: "poll", linkedEntityId: String(id) }); }}>＋投票</button>}
              {api.canManageBoards && <button type="button" className="wb-card" onClick={() => { api.onCreateDecision("已決定：採用 B 版"); addAtView("decision", { text: "已決定：採用 B 版", sourceLabel: "決策區" }); setSheet(null); }}>寫下決策</button>}
              {polls.map((poll) => (
                <button type="button" className="wb-card" key={poll.id} onClick={() => { addAtView("poll", { pollQuestion: poll.question, voteCount: (api.room.pollVotes ?? []).filter((vote) => vote.pollId === poll.id).length }, { linkedEntityType: "poll", linkedEntityId: poll.id }); }}>
                  {poll.question}
                </button>
              ))}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setSheet(null)}>取消</button>
          </section>
        </div>
      )}
    </div>
  );
}
