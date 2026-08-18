import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Point, Version } from "../lib/types";
import { VisualProposalOverlay } from "../features/visual-proposal/VisualProposalOverlay";
import { nextPinNumber, pinNumber, type WorkspaceApi } from "./api";

type Rect = { left: number; top: number; width: number; height: number };

const EMPTY_RECT: Rect = { left: 0, top: 0, width: 0, height: 0 };

/** Where an `object-fit: contain` image actually lands inside its box. */
function containRect(box: { w: number; h: number }, natural: { w: number; h: number }): Rect {
  if (box.w <= 0 || box.h <= 0 || natural.w <= 0 || natural.h <= 0) return EMPTY_RECT;
  const scale = Math.min(box.w / natural.w, box.h / natural.h);
  const width = natural.w * scale;
  const height = natural.h * scale;
  return { left: (box.w - width) / 2, top: (box.h - height) / 2, width, height };
}

export function Viewer({ api, compact }: { api: WorkspaceApi; compact?: boolean }) {
  const { room, view } = api;
  const primary = room.versions.find((v) => v.id === view.versionId) ?? room.versions[0];
  if (!primary) return null;

  let compare = room.versions.find((v) => v.id === view.compareId) ?? primary;
  if (compare.id === primary.id && room.versions.length >= 2) {
    compare = room.versions.find((v) => v.id !== primary.id) ?? primary;
  }

  if (view.compareMode === "side" && room.versions.length >= 2) {
    return (
      <div className="stage-wrap stage-side">
        <Stage api={api} version={primary} interactive compact={compact} />
        <Stage api={api} version={compare} interactive={false} compact={compact} />
      </div>
    );
  }

  if (view.compareMode === "wipe" && room.versions.length >= 2) {
    return (
      <div className="stage-wrap">
        <Stage api={api} version={primary} interactive wipeWith={compare} compact={compact} />
      </div>
    );
  }

  return (
    <div className="stage-wrap">
      <Stage api={api} version={primary} interactive compact={compact} />
    </div>
  );
}

type StageProps = {
  api: WorkspaceApi;
  version: Version;
  interactive: boolean;
  wipeWith?: Version;
  compact?: boolean;
};

export function Stage({ api, version, interactive, wipeWith, compact }: StageProps) {
  const { room, view, tool, guest, draftPin, selectedPinId } = api;
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [live, setLive] = useState<Point[]>([]);
  const drawing = useRef(false);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = version.imageDataUrl;
    return () => {
      cancelled = true;
    };
  }, [version.imageDataUrl]);

  const frame = containRect(box, natural);
  const ready = frame.width > 0;

  /** Pointer position as a fraction of the poster itself, not of the viewport box. */
  const relative = useCallback(
    (e: ReactPointerEvent | ReactMouseEvent): Point | null => {
      const el = boxRef.current;
      if (!el || !ready) return null;
      const rect = el.getBoundingClientRect();
      const x = (e.clientX - rect.left - frame.left) / frame.width;
      const y = (e.clientY - rect.top - frame.top) / frame.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return { x, y };
    },
    [frame.left, frame.top, frame.width, frame.height, ready],
  );

  const onDown = (e: ReactPointerEvent) => {
    if (!interactive || tool !== "draw") return;
    const p = relative(e);
    if (!p) return;
    drawing.current = true;
    setLive([p]);
    boxRef.current?.setPointerCapture(e.pointerId);
  };

  /**
   * Pins are placed on `click`, the last event of a tap. Placing them earlier
   * lets the browser's follow-up mousedown blur the composer's first field,
   * which on iOS means the keyboard never opens.
   */
  const onClick = (e: ReactMouseEvent) => {
    if (!interactive) return;
    const p = relative(e);
    if (tool === "pin") {
      if (p) api.placePin(version.id, p.x, p.y);
    } else if (selectedPinId) {
      api.selectPin(null);
    }
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!interactive || !drawing.current) return;
    const p = relative(e);
    if (p) setLive((pts) => [...pts, p]);
  };

  const onUp = () => {
    if (!interactive || !drawing.current) return;
    drawing.current = false;
    const pts = live;
    setLive([]);
    api.addStroke(version.id, pts);
  };

  const allPins = room.comments.filter((c) => c.versionId === version.id);
  const allStrokes = room.strokes.filter((s) => s.versionId === version.id);
  const selectedPin = selectedPinId ? allPins.find((pin) => pin.id === selectedPinId) : undefined;

  /**
   * The poster itself stays clean in view mode. Annotation tools reveal active
   * marks; selecting an item from the discussion only reveals that one locator.
   * Resolved pins live in the list and never remain stamped over the artwork.
   */
  const editingAnnotations = tool !== "pan";
  const pins = editingAnnotations
    ? allPins.filter((pin) => !pin.resolved)
    : selectedPin
      ? [selectedPin]
      : [];
  const strokes = editingAnnotations ? allStrokes : [];

  const toPolyline = (pts: Point[]) => pts.map((p) => `${p.x * 100},${p.y * 100}`).join(" ");
  const imgStyle = ready
    ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height }
    : { inset: 0 };
  const dimOthers = editingAnnotations && (selectedPinId != null || draftPin != null);

  return (
    <div
      ref={boxRef}
      className={`stage tool-${tool} ${interactive ? "is-interactive" : ""} ${editingAnnotations ? "stage-annotations" : "stage-clean"}`}
      onClick={onClick}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <img
        className={`stage-img mode-${view.colorMode}`}
        style={imgStyle}
        src={version.imageDataUrl}
        alt={version.label}
        draggable={false}
      />
      {view.colorMode === "split" && (
        <img className="stage-img split-gray" style={imgStyle} src={version.imageDataUrl} alt="" draggable={false} />
      )}
      {wipeWith && wipeWith.id !== version.id && (
        <img
          className="stage-img wipe-top"
          style={{ ...imgStyle, clipPath: `inset(0 0 0 ${view.wipe * 100}%)` }}
          src={wipeWith.imageDataUrl}
          alt={wipeWith.label}
          draggable={false}
        />
      )}

      {ready && (
        <div className="stage-frame" data-density={pins.length > 10 ? "dense" : undefined} style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}>
          <svg className="overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
            {strokes.map((s) => (
              <polyline
                key={s.id}
                points={toPolyline(s.points)}
                fill="none"
                stroke={s.color}
                strokeWidth={s.width}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className={tool === "erase" && interactive ? "stroke-erasable" : ""}
                onPointerDown={(e) => {
                  if (tool === "erase" && interactive) {
                    e.stopPropagation();
                    api.eraseStroke(s.id);
                  }
                }}
              />
            ))}
            {live.length > 1 && (
              <polyline
                points={toPolyline(live)}
                fill="none"
                stroke={guest.color}
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          <VisualProposalOverlay roomId={room.id} versionId={version.id} authorName={guest.name} compact={compact} />

          {pins.map((pin) => {
            const n = pinNumber(room, pin.id);
            const selected = pin.id === selectedPinId;
            const locatorOnly = !editingAnnotations && selected;
            const tipLeft = pin.x > 0.55;
            const showTip = selected && !compact && editingAnnotations;
            return (
              <button
                key={pin.id}
                type="button"
                className={[
                  "pin",
                  selected ? "pin-selected" : "",
                  locatorOnly ? "pin-locator" : "",
                  selected && showTip ? (tipLeft ? "pin-tip-left" : "pin-tip-right") : "",
                  dimOthers && !selected ? "pin-dim" : "",
                  compact ? "pin-compact" : "",
                ].join(" ")}
                style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, ["--pin" as string]: pin.authorColor }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  api.selectPin(selected ? null : pin.id);
                }}
                aria-label={`修改點 ${n}：${pin.body}`}
              >
                {showTip && tipLeft && <span className="pin-tip pin-tip-start">{pin.body}</span>}
                <span className="pin-no">{n}</span>
                {showTip && !tipLeft && <span className="pin-tip">{pin.body}</span>}
              </button>
            );
          })}

          {draftPin && draftPin.versionId === version.id && (
            <span
              className="pin pin-draft"
              style={{ left: `${draftPin.x * 100}%`, top: `${draftPin.y * 100}%` }}
              aria-hidden
            >
              <span className="pin-no">{nextPinNumber(room, version.id)}</span>
            </span>
          )}
        </div>
      )}

      {!compact && <span className="stage-label">{version.label}</span>}
    </div>
  );
}
