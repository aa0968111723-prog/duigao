import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useProposalStore, type ProposalItem } from "./store";
import "./proposal.css";

type Props = {
  roomId: string;
  versionId: string;
  authorName: string;
};

type DragPreview = { id: string; x: number; y: number } | null;

type DragSession = {
  id: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return `rgba(0, 0, 0, ${alpha})`;
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function VisualProposalOverlay({ roomId, versionId, authorName }: Props) {
  const proposal = useProposalStore(roomId, versionId, authorName);
  const [dragPreview, setDragPreview] = useState<DragPreview>(null);
  const drag = useRef<DragSession | null>(null);

  if (!proposal.visible || !proposal.active) return null;

  const active = proposal.active;
  const background = active.background;

  const itemPosition = (item: ProposalItem) => {
    if (dragPreview?.id === item.id) return { x: dragPreview.x, y: dragPreview.y };
    return { x: item.x, y: item.y };
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, item: ProposalItem) => {
    if (!proposal.editing) return;
    event.stopPropagation();
    proposal.selectItem(item.id);
    const layer = event.currentTarget.closest(".proposal-layer") as HTMLElement | null;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    drag.current = {
      id: item.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: item.x,
      startY: item.y,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const x = clamp(session.startX + (event.clientX - session.startClientX) / session.width, 0, 1);
    const y = clamp(session.startY + (event.clientY - session.startClientY) / session.height, 0, 1);
    setDragPreview({ id: session.id, x, y });
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = drag.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const preview = dragPreview;
    if (preview?.id === session.id) proposal.updateItem(session.id, { x: preview.x, y: preview.y });
    drag.current = null;
    setDragPreview(null);
  };

  return (
    <div
      className={`proposal-layer ${proposal.editing ? "is-editing" : "is-preview"}`}
      onPointerDown={(event) => {
        if (!proposal.editing) return;
        event.stopPropagation();
        proposal.selectItem(null);
      }}
      aria-label={`${active.name} 視覺提案層`}
    >
      {background.imageDataUrl && (
        <img
          className="proposal-background-image"
          src={background.imageDataUrl}
          alt="提案背景"
          style={{ opacity: background.imageOpacity }}
          draggable={false}
        />
      )}
      {background.colorOpacity > 0 && (
        <span
          className="proposal-background-color"
          style={{ background: hexToRgba(background.color, background.colorOpacity) }}
          aria-hidden
        />
      )}

      {active.items.map((item) => {
        const position = itemPosition(item);
        const selected = proposal.selectedItem?.id === item.id;
        const sharedStyle = {
          left: `${position.x * 100}%`,
          top: `${position.y * 100}%`,
          width: `${item.width}%`,
          opacity: item.opacity,
          transform: `translate(-50%, -50%) rotate(${item.rotation}deg)`,
        };

        if (item.type === "image") {
          return (
            <button
              key={item.id}
              type="button"
              className={`proposal-item proposal-image ${selected ? "is-selected" : ""}`}
              style={sharedStyle}
              onPointerDown={(event) => beginDrag(event, item)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClick={(event) => event.stopPropagation()}
              aria-label={`素材：${item.name}`}
            >
              <img src={item.imageDataUrl} alt={item.name} draggable={false} />
            </button>
          );
        }

        return (
          <button
            key={item.id}
            type="button"
            className={`proposal-item proposal-text ${selected ? "is-selected" : ""}`}
            style={{
              ...sharedStyle,
              color: item.color,
              fontFamily: item.fontFamily,
              fontSize: `${item.fontSize}cqw`,
              fontWeight: item.fontWeight,
              textAlign: item.align,
              background: hexToRgba(item.backdropColor, item.backdropOpacity),
            }}
            onPointerDown={(event) => beginDrag(event, item)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={(event) => event.stopPropagation()}
          >
            {item.text}
          </button>
        );
      })}

      <span className="proposal-preview-label">{active.name} · 模擬</span>
      {proposal.editing && (
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
