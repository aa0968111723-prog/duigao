import { memo, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useProposalStore, type ProposalAuthor, type ProposalItem } from "./store";
import { OPEN_COMPOSE_PICKER_EVENT } from "./ComposeAssetPicker";
import { backgroundColorCss, clamp, hexToRgba, objectFitFor, proposalTypeLabel } from "./helpers";
import { ensureComposeFonts } from "./composeFonts";
import "./proposal.css";

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
  compact?: boolean;
};

const SAFE = 0.06;
const SNAP_TARGETS = [SAFE, 0.5, 1 - SAFE];
const SNAP_THRESHOLD = 0.018;

type Gesture = {
  itemId: string;
  frame: { left: number; top: number; width: number; height: number };
  pointers: Map<number, { x: number; y: number }>;
  primaryId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  startWidth: number;
  startRotation: number;
  pinchDist: number;
  pinchAngle: number;
  mode: "drag" | "pinch";
  moved: boolean;
};

function snapAxis(value: number): { value: number; guide: number | null } {
  for (const target of SNAP_TARGETS) {
    if (Math.abs(value - target) <= SNAP_THRESHOLD) return { value: target, guide: target };
  }
  return { value, guide: null };
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angle(a: { x: number; y: number }, b: { x: number; y: number }) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

export function VisualProposalOverlay({ roomId, versionId, author, compact }: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  useEffect(() => { ensureComposeFonts(); }, []);
  const gesture = useRef<Gesture | null>(null);
  const resize = useRef<{ id: string; cx: number; cy: number; startDist: number; startWidth: number } | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });

  const { active, editing, visible, viewMode, compareSplit, selectedItem, layerEditing } = proposal;

  // 原稿 mode hides the paint — but keep the layer mounted while composing.
  // Hook `editing` is gated on viewMode==="proposal"; layerEditing is the raw
  // session flag so a one-tick 原稿 flicker cannot unmount poster-compose-canvas.
  if (!active) return null;
  if (!visible && !layerEditing) return null;

  const background = active.background;
  const colorCss = backgroundColorCss(background);
  const comparing = viewMode === "compare";
  // 對照: the proposal only paints to the right of the split, original shows left.
  const clip = comparing ? { clipPath: `inset(0 0 0 ${compareSplit * 100}%)` } : undefined;

  const twoPointers = (g: Gesture) => Array.from(g.pointers.values());

  const rebaseline = (g: Gesture) => {
    const pts = twoPointers(g);
    const item = active.items.find((i) => i.id === g.itemId);
    if (!item) return;
    g.startWidth = item.width;
    g.startRotation = item.rotation;
    if (pts.length >= 2) {
      g.mode = "pinch";
      g.pinchDist = distance(pts[0], pts[1]) || 1;
      g.pinchAngle = angle(pts[0], pts[1]);
    } else {
      g.mode = "drag";
      g.startX = item.x;
      g.startY = item.y;
      const primary = g.pointers.get(g.primaryId);
      if (primary) {
        g.startClientX = primary.x;
        g.startClientY = primary.y;
      }
    }
  };

  const onItemPointerDown = (event: ReactPointerEvent<HTMLElement>, item: ProposalItem) => {
    if (!editing) return;
    event.stopPropagation();
    proposal.selectItem(item.id);
    const layer = event.currentTarget.closest(".proposal-layer") as HTMLElement | null;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    proposal.beginEdit();

    let g = gesture.current;
    if (!g || g.itemId !== item.id) {
      g = {
        itemId: item.id,
        frame: { left: rect.left, top: rect.top, width: rect.width || 1, height: rect.height || 1 },
        pointers: new Map(),
        primaryId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: item.x,
        startY: item.y,
        startWidth: item.width,
        startRotation: item.rotation,
        pinchDist: 1,
        pinchAngle: 0,
        mode: "drag",
        moved: false,
      };
      gesture.current = g;
    }
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    rebaseline(g);
  };

  const onItemPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g || !g.pointers.has(event.pointerId)) return;
    event.stopPropagation();
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    g.moved = true;

    if (g.mode === "pinch") {
      const pts = twoPointers(g);
      if (pts.length < 2) return;
      const dist = distance(pts[0], pts[1]) || 1;
      const ratio = dist / g.pinchDist;
      const width = clamp(g.startWidth * ratio, 5, 100);
      const rotation = clamp(g.startRotation + (angle(pts[0], pts[1]) - g.pinchAngle), -180, 180);
      proposal.updateItemLive(g.itemId, { width, rotation: Math.round(rotation) });
      return;
    }

    const rawX = g.startX + (event.clientX - g.startClientX) / g.frame.width;
    const rawY = g.startY + (event.clientY - g.startClientY) / g.frame.height;
    const sx = snapAxis(clamp(rawX, 0.02, 0.98));
    const sy = snapAxis(clamp(rawY, 0.02, 0.98));
    setGuides({ x: sx.guide, y: sy.guide });
    proposal.updateItemLive(g.itemId, { x: sx.value, y: sy.value });
  };

  const onItemPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    event.stopPropagation();
    g.pointers.delete(event.pointerId);
    if (g.pointers.size === 0) {
      gesture.current = null;
      setGuides({ x: null, y: null });
      proposal.endEdit();
    } else {
      rebaseline(g);
    }
  };

  // Corner resize handle (mouse / single-finger): scale width from centre distance.
  const onHandleDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!selectedItem) return;
    event.stopPropagation();
    const layer = event.currentTarget.closest(".proposal-layer") as HTMLElement | null;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    const cx = rect.left + (selectedItem.x * rect.width);
    const cy = rect.top + (selectedItem.y * rect.height);
    const startDist = Math.hypot(event.clientX - cx, event.clientY - cy) || 1;
    resize.current = { id: selectedItem.id, cx, cy, startDist, startWidth: selectedItem.width };
    event.currentTarget.setPointerCapture(event.pointerId);
    proposal.beginEdit();
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLElement>) => {
    const r = resize.current;
    if (!r) return;
    event.stopPropagation();
    const dist = Math.hypot(event.clientX - r.cx, event.clientY - r.cy) || 1;
    proposal.updateItemLive(r.id, { width: clamp(r.startWidth * (dist / r.startDist), 5, 100) });
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!resize.current) return;
    event.stopPropagation();
    resize.current = null;
    proposal.endEdit();
  };

  return (
    <div
      className={`proposal-layer ${editing ? "is-editing" : "is-preview"} ${comparing ? "is-comparing" : ""}`}
      data-testid="poster-compose-canvas"
      onPointerDown={(event) => {
        if (!editing) return;
        event.stopPropagation();
        proposal.selectItem(null);
      }}
      aria-label={`${active.title} 視覺提案層`}
    >
      <div className="proposal-paint" style={clip}>
        {background.imageDataUrl && (
          <img
            className="proposal-background-image"
            src={background.imageDataUrl}
            alt="提案背景"
            style={{ opacity: background.imageOpacity, objectFit: objectFitFor(background.imageFit) }}
            draggable={false}
          />
        )}
        {colorCss && <span className="proposal-background-color" style={{ background: colorCss }} aria-hidden />}

        {active.items
          .filter((item) => item.visible)
          .map((item) => (
            <ProposalItemView
              key={item.id}
              item={item}
              selected={editing && selectedItem?.id === item.id}
              onPointerDown={onItemPointerDown}
              onPointerMove={onItemPointerMove}
              onPointerUp={onItemPointerUp}
            />
          ))}
      </div>

      {comparing && (
        <>
          <span className="proposal-compare-line" style={{ left: `${compareSplit * 100}%` }} aria-hidden />
          <span className="proposal-compare-tag proposal-compare-tag-left">原稿</span>
          <span className="proposal-compare-tag proposal-compare-tag-right">提案</span>
        </>
      )}

      {editing && active.items.length === 0 && !background.imageDataUrl && (
        <p className="poster-compose-empty-hint" data-testid="poster-compose-empty-hint">
          把 logo、照片丟上來。拼完存成新版本。原稿不會被改。
          {" "}
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              window.dispatchEvent(new Event(OPEN_COMPOSE_PICKER_EVENT));
            }}
          >
            從房間撿
          </button>
        </p>
      )}

      {editing && guides.x != null && <span className="proposal-guide proposal-guide-v" style={{ left: `${guides.x * 100}%` }} aria-hidden />}
      {editing && guides.y != null && <span className="proposal-guide proposal-guide-h" style={{ top: `${guides.y * 100}%` }} aria-hidden />}

      {editing && selectedItem && (
        <button
          type="button"
          className="proposal-resize-handle"
          style={{
            left: `${clamp(selectedItem.x + selectedItem.width / 200, 0, 1) * 100}%`,
            top: `${selectedItem.y * 100}%`,
          }}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onClick={(e) => e.stopPropagation()}
          aria-label="調整大小"
        />
      )}

      <span className={`proposal-preview-label ${active.status === "accepted" ? "is-accepted" : ""}`}>
        {active.status === "accepted" ? "已採用 · " : ""}
        {active.title} · {proposalTypeLabel(active.type)}
      </span>
      {editing && !compact && (
        <button
          type="button"
          className="proposal-finish"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            proposal.setEditing(false);
          }}
        >
          完成擺放
        </button>
      )}
    </div>
  );
}

type ItemViewProps = {
  item: ProposalItem;
  selected: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, item: ProposalItem) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
};

const ProposalItemView = memo(function ProposalItemView({ item, selected, onPointerDown, onPointerMove, onPointerUp }: ItemViewProps) {
  const shared: CSSProperties = {
    left: `${item.x * 100}%`,
    top: `${item.y * 100}%`,
    width: `${item.width}%`,
    opacity: item.opacity,
    transform: `translate(-50%, -50%) rotate(${item.rotation}deg)`,
  };

  const handlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onPointerDown(e, item),
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onClick: (e: { stopPropagation: () => void }) => e.stopPropagation(),
  };

  if (item.type === "image") {
    return (
      <button
        type="button"
        className={`proposal-item proposal-image ${selected ? "is-selected" : ""}`}
        style={shared}
        {...handlers}
        aria-label={`素材：${item.name}`}
        aria-pressed={selected}
      >
        <img src={item.imageDataUrl} alt={item.name} draggable={false} />
      </button>
    );
  }

  if (item.type === "shape") {
    return (
      <button
        type="button"
        className={`proposal-item proposal-shape ${selected ? "is-selected" : ""}`}
        style={{ ...shared, height: `${item.height}%`, background: item.color, borderRadius: `${item.radius}px` }}
        {...handlers}
        aria-label="色塊"
        aria-pressed={selected}
      />
    );
  }

  const padding = `${item.backdropPadding}em ${item.backdropPadding * 1.4}em`;
  return (
    <button
      type="button"
      className={`proposal-item proposal-text ${selected ? "is-selected" : ""}`}
      style={{
        ...shared,
        color: item.color,
        fontFamily: item.fontFamily,
        fontSize: `${item.fontSize}cqw`,
        fontWeight: item.fontWeight,
        textAlign: item.align,
        background: hexToRgba(item.backdropColor, item.backdropOpacity),
        padding,
        borderRadius: `${item.backdropRadius}px`,
      }}
      {...handlers}
      aria-label={`文字：${item.text}`}
      aria-pressed={selected}
    >
      {item.text}
    </button>
  );
});
