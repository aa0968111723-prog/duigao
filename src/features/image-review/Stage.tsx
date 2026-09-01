import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Point, Version } from "../../lib/types";
import type { RoomContextFocus } from "../../lib/assetIntelligence";
import { regionFromPoints } from "../../lib/region";
import { VisualProposalOverlay } from "../visual-proposal/VisualProposalOverlay";
import { nextPinNumber, pinNumber, type WorkspaceApi } from "../../components/api";
import {
  clampTransform,
  DEFAULT_VIEWER_TRANSFORM,
  focusTransform,
  sameTransform,
  stagePointToNormalized,
  containRect,
  type ViewerRect,
  type ViewerSize,
  type ViewerTransform,
  type ZoomPreset,
  zoomScaleForPreset,
} from "./viewerGeometry";

export type ViewerMetrics = {
  box: ViewerSize;
  frame: ViewerRect;
  natural: ViewerSize;
};

export type ZoomRequest = { preset: ZoomPreset; nonce: number };

type ViewerProps = {
  api: WorkspaceApi;
  compact?: boolean;
  /** Enables the local transform and touch gesture model used by the immersive viewer. */
  zoomable?: boolean;
  transform?: ViewerTransform;
  onTransformChange?: (next: ViewerTransform) => void;
  onMetricsChange?: (metrics: ViewerMetrics) => void;
  zoomRequest?: ZoomRequest | null;
  focusPinId?: string | null;
  /** AI region focus uses the same normalized poster coordinate system as pins. */
  focusTarget?: RoomContextFocus | null;
  showAnnotations?: boolean;
  onOpenImmersive?: () => void;
  onTap?: () => void;
};

export function Viewer({
  api,
  compact,
  zoomable = false,
  transform,
  onTransformChange,
  onMetricsChange,
  zoomRequest,
  focusPinId,
  focusTarget,
  showAnnotations = true,
  onOpenImmersive,
  onTap,
}: ViewerProps) {
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
        <Stage
          api={api}
          version={primary}
          interactive
          compact={compact}
          zoomable={zoomable}
          transform={transform}
          onTransformChange={onTransformChange}
          onMetricsChange={onMetricsChange}
          zoomRequest={zoomRequest}
          focusPinId={focusPinId}
          focusTarget={focusTarget}
          showAnnotations={showAnnotations}
          onOpenImmersive={onOpenImmersive}
          onTap={onTap}
        />
        <Stage api={api} version={compare} interactive={false} compact={compact} showAnnotations={showAnnotations} />
      </div>
    );
  }

  if (view.compareMode === "wipe" && room.versions.length >= 2) {
    return (
      <div className="stage-wrap">
        <Stage
          api={api}
          version={primary}
          interactive
          wipeWith={compare}
          compact={compact}
          zoomable={zoomable}
          transform={transform}
          onTransformChange={onTransformChange}
          onMetricsChange={onMetricsChange}
          zoomRequest={zoomRequest}
          focusPinId={focusPinId}
          focusTarget={focusTarget}
          showAnnotations={showAnnotations}
          onOpenImmersive={onOpenImmersive}
          onTap={onTap}
        />
      </div>
    );
  }

  return (
    <div className="stage-wrap">
      <Stage
        api={api}
        version={primary}
        interactive
        compact={compact}
        zoomable={zoomable}
        transform={transform}
        onTransformChange={onTransformChange}
        onMetricsChange={onMetricsChange}
        zoomRequest={zoomRequest}
        focusPinId={focusPinId}
        focusTarget={focusTarget}
        showAnnotations={showAnnotations}
        onOpenImmersive={onOpenImmersive}
        onTap={onTap}
      />
    </div>
  );
}

type StageProps = {
  api: WorkspaceApi;
  version: Version;
  interactive: boolean;
  wipeWith?: Version;
  compact?: boolean;
  zoomable?: boolean;
  transform?: ViewerTransform;
  onTransformChange?: (next: ViewerTransform) => void;
  onMetricsChange?: (metrics: ViewerMetrics) => void;
  zoomRequest?: ZoomRequest | null;
  focusPinId?: string | null;
  focusTarget?: RoomContextFocus | null;
  showAnnotations?: boolean;
  onOpenImmersive?: () => void;
  onTap?: () => void;
};

type PointerPosition = { x: number; y: number };

type ZoomGesture =
  | {
      kind: "single";
      start: PointerPosition;
      moved: boolean;
      startTransform: ViewerTransform;
    }
  | {
      kind: "pinch";
      pointerIds: [number, number];
      startDistance: number;
      startMidpoint: PointerPosition;
      moved: boolean;
      startTransform: ViewerTransform;
    };

export function Stage({
  api,
  version,
  interactive,
  wipeWith,
  compact,
  zoomable = false,
  transform,
  onTransformChange,
  onMetricsChange,
  zoomRequest,
  focusPinId,
  focusTarget,
  showAnnotations = true,
  onOpenImmersive,
  onTap,
}: StageProps) {
  const { room, view, tool, guest, draftPin, selectedPinId } = api;
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const activeTransform = transform ?? DEFAULT_VIEWER_TRANSFORM;
  const liveTransform = useRef<ViewerTransform>(activeTransform);
  const pendingTransform = useRef<ViewerTransform | null>(null);
  const transformRaf = useRef(0);
  const lastZoomNonce = useRef<number | null>(null);
  const lastFocusKey = useRef<string | null>(null);
  const activePointers = useRef(new Map<number, PointerPosition>());
  const zoomGesture = useRef<ZoomGesture | null>(null);
  const lastTap = useRef<{ time: number; point: PointerPosition } | null>(null);
  const tapTimer = useRef(0);

  /**
   * The live gesture (draw on desktop, 圈範圍 on mobile) never touches React
   * state: points accumulate in a ref and the polyline is updated straight on
   * the DOM inside one requestAnimationFrame per frame. Nothing is persisted
   * until pointer up.
   */
  const gesturePoints = useRef<Point[]>([]);
  const gestureActive = useRef(false);
  const livePolyline = useRef<SVGPolylineElement>(null);
  const liveRaf = useRef(0);

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

  const allPins = room.comments.filter((c) => c.versionId === version.id);
  const allStrokes = room.strokes.filter((s) => s.versionId === version.id);

  const writeTransform = useCallback((next: ViewerTransform) => {
    liveTransform.current = next;
    const el = contentRef.current;
    if (!el) return;
    el.style.transform = `translate3d(${next.translateX}px, ${next.translateY}px, 0) scale(${next.scale})`;
    el.style.setProperty("--viewer-scale", String(next.scale));
    el.style.setProperty("--viewer-marker-scale", String(1 / next.scale));
  }, []);

  /** Update the compositor directly, publishing at most once per frame. */
  const publishTransform = useCallback(
    (next: ViewerTransform, immediate = false) => {
      const safe = clampTransform(next, box, frame);
      writeTransform(safe);
      if (!onTransformChange) return;
      pendingTransform.current = safe;
      if (immediate) {
        if (transformRaf.current) cancelAnimationFrame(transformRaf.current);
        transformRaf.current = 0;
        pendingTransform.current = null;
        onTransformChange(safe);
        return;
      }
      if (!transformRaf.current) {
        transformRaf.current = requestAnimationFrame(() => {
          transformRaf.current = 0;
          const queued = pendingTransform.current;
          pendingTransform.current = null;
          if (queued) onTransformChange(queued);
        });
      }
    },
    [box.h, box.w, frame.height, frame.left, frame.top, frame.width, onTransformChange, writeTransform],
  );

  useLayoutEffect(() => {
    const next = clampTransform(activeTransform, box, frame);
    writeTransform(next);
    if (onTransformChange && !sameTransform(next, activeTransform)) onTransformChange(next);
  }, [activeTransform, box.h, box.w, frame.height, frame.left, frame.top, frame.width, onTransformChange, writeTransform]);

  useEffect(() => {
    onMetricsChange?.({ box, frame, natural });
  }, [box.h, box.w, frame.height, frame.left, frame.top, frame.width, natural.h, natural.w, onMetricsChange]);

  useEffect(() => {
    if (!zoomRequest || !zoomable || !ready || lastZoomNonce.current === zoomRequest.nonce) return;
    lastZoomNonce.current = zoomRequest.nonce;
    publishTransform(
      {
        scale: zoomScaleForPreset(zoomRequest.preset, frame, natural),
        translateX: 0,
        translateY: 0,
      },
      true,
    );
  }, [frame, natural, publishTransform, ready, zoomRequest, zoomable]);

  useEffect(() => {
    if (!focusPinId) {
      lastFocusKey.current = null;
      return;
    }
    if (!zoomable || !ready) return;
    const pin = allPins.find((item) => item.id === focusPinId);
    if (!pin) return;
    const focusKey = `${version.id}:${focusPinId}`;
    if (lastFocusKey.current === focusKey) return;
    lastFocusKey.current = focusKey;
    const point = pin.region
      ? { x: pin.region.x + pin.region.width / 2, y: pin.region.y + pin.region.height / 2 }
      : { x: pin.x, y: pin.y };
    publishTransform(focusTransform(point, box, frame, liveTransform.current, 2), true);
  }, [allPins, box, focusPinId, frame, publishTransform, ready, version.id, zoomable]);

  useEffect(() => {
    if (!focusTarget?.locator || focusTarget.locator.kind !== "image-region") return;
    if (!zoomable || !ready || (focusTarget.versionId && focusTarget.versionId !== version.id)) return;
    const region = focusTarget.locator.region;
    const focusKey = `${version.id}:ai:${focusTarget.assetId}:${region.x}:${region.y}:${region.width}:${region.height}`;
    if (lastFocusKey.current === focusKey) return;
    lastFocusKey.current = focusKey;
    publishTransform(
      focusTransform({ x: region.x + region.width / 2, y: region.y + region.height / 2 }, box, frame, liveTransform.current, 2),
      true,
    );
  }, [box, focusTarget, frame, publishTransform, ready, version.id, zoomable]);

  useEffect(
    () => () => {
      if (liveRaf.current) cancelAnimationFrame(liveRaf.current);
      if (transformRaf.current) cancelAnimationFrame(transformRaf.current);
      if (tapTimer.current) window.clearTimeout(tapTimer.current);
    },
    [],
  );

  /** Pointer position as a fraction of the poster itself, not of the viewport box. */
  const stagePoint = useCallback((e: ReactPointerEvent | ReactMouseEvent): PointerPosition | null => {
    const el = boxRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const relative = useCallback(
    (e: ReactPointerEvent | ReactMouseEvent): Point | null => {
      const point = stagePoint(e);
      if (!point || !ready) return null;
      return stagePointToNormalized(point, frame, box, liveTransform.current);
    },
    [box, frame, ready, stagePoint],
  );

  const paintLive = useCallback(() => {
    liveRaf.current = 0;
    const el = livePolyline.current;
    if (!el) return;
    const pts = gesturePoints.current;
    el.setAttribute("points", pts.length > 1 ? pts.map((p) => `${p.x * 100},${p.y * 100}`).join(" ") : "");
  }, []);

  const scheduleLive = useCallback(() => {
    if (!liveRaf.current) liveRaf.current = requestAnimationFrame(paintLive);
  }, [paintLive]);

  /**
   * While a gesture is live, stop the browser from turning the touch into a
   * scroll/pan (which would fire pointercancel and eat the circle). CSS
   * touch-action already blocks it declaratively; this covers engines that
   * still initiate a scroll from the touch stream. Passive:false is required
   * for preventDefault to work. Outside a gesture nothing is prevented, so
   * view-mode pinch/pan is untouched.
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const prevent = (e: TouchEvent) => {
      if (gestureActive.current || (zoomable && activePointers.current.size > 0)) e.preventDefault();
    };
    el.addEventListener("touchstart", prevent, { passive: false });
    el.addEventListener("touchmove", prevent, { passive: false });
    return () => {
      el.removeEventListener("touchstart", prevent);
      el.removeEventListener("touchmove", prevent);
    };
  }, [zoomable]);

  const gestureTool = tool === "draw" || tool === "region";
  const overlayBusy = () =>
    Boolean(contentRef.current?.querySelector(".proposal-layer.is-editing, [data-cropping='true']"));

  const onDown = (e: ReactPointerEvent) => {
    if (!interactive) return;
    if (overlayBusy()) return;
    if (gestureTool) {
      const p = relative(e);
      if (!p) return;
      gestureActive.current = true;
      gesturePoints.current = [p];
      boxRef.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (!zoomable || tool !== "pan") return;
    const point = stagePoint(e);
    if (!point) return;
    activePointers.current.set(e.pointerId, point);
    const pointers = [...activePointers.current.entries()];
    if (pointers.length === 1) {
      zoomGesture.current = {
        kind: "single",
        start: point,
        moved: false,
        startTransform: liveTransform.current,
      };
    } else if (pointers.length === 2) {
      const [first, second] = pointers;
      zoomGesture.current = {
        kind: "pinch",
        pointerIds: [first[0], second[0]],
        startDistance: Math.max(1, Math.hypot(second[1].x - first[1].x, second[1].y - first[1].y)),
        startMidpoint: {
          x: (first[1].x + second[1].x) / 2,
          y: (first[1].y + second[1].y) / 2,
        },
        moved: false,
        startTransform: liveTransform.current,
      };
    }
    boxRef.current?.setPointerCapture(e.pointerId);
  };

  /**
   * Pins are placed on `click`, the last event of a tap. Placing them earlier
   * lets the browser's follow-up mousedown blur the composer's first field,
   * which on iOS means the keyboard never opens. A finished 圈範圍 gesture also
   * emits a click, so region mode ignores it entirely.
   */
  const onClick = (e: ReactMouseEvent) => {
    if (!interactive || tool === "region") return;
    if (overlayBusy()) return;
    // Zoomable pan mode handles taps from pointer-up so a double tap can be
    // recognised before the browser's synthetic click arrives.
    if (zoomable && tool === "pan") return;
    const p = relative(e);
    if (tool === "pin") {
      if (p) api.placePin(version.id, p.x, p.y);
    } else if (tool === "pan" && onOpenImmersive) {
      onOpenImmersive();
    } else if (selectedPinId) {
      api.selectPin(null);
    }
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!interactive) return;
    if (gestureActive.current) {
      const p = relative(e);
      if (!p) return;
      const pts = gesturePoints.current;
      const last = pts[pts.length - 1];
      // Light sampling: sub-half-percent jitters add nothing to a bounding box.
      if (last && Math.abs(p.x - last.x) < 0.004 && Math.abs(p.y - last.y) < 0.004) return;
      pts.push(p);
      scheduleLive();
      return;
    }
    if (!zoomable || tool !== "pan" || !activePointers.current.has(e.pointerId)) return;
    const point = stagePoint(e);
    if (!point) return;
    activePointers.current.set(e.pointerId, point);
    const gesture = zoomGesture.current;
    if (!gesture) return;

    if (gesture.kind === "pinch") {
      const first = activePointers.current.get(gesture.pointerIds[0]);
      const second = activePointers.current.get(gesture.pointerIds[1]);
      if (!first || !second) return;
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const scale = (distance / gesture.startDistance) * gesture.startTransform.scale;
      const ratio = scale / gesture.startTransform.scale;
      const center = { x: box.w / 2, y: box.h / 2 };
      const next = {
        scale,
        // Keep the image point under the pinch midpoint stable while the
        // midpoint itself moves — this makes pinch feel anchored, not rubbery.
        translateX:
          midpoint.x - center.x - ratio * (gesture.startMidpoint.x - center.x - gesture.startTransform.translateX),
        translateY:
          midpoint.y - center.y - ratio * (gesture.startMidpoint.y - center.y - gesture.startTransform.translateY),
      };
      gesture.moved = true;
      publishTransform(next);
      return;
    }

    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    if (Math.hypot(dx, dy) < 6) return;
    gesture.moved = true;
    publishTransform({
      ...gesture.startTransform,
      translateX: gesture.startTransform.translateX + dx,
      translateY: gesture.startTransform.translateY + dy,
    });
  };

  const endGesture = (): Point[] | null => {
    if (!interactive || !gestureActive.current) return null;
    gestureActive.current = false;
    const pts = gesturePoints.current;
    gesturePoints.current = [];
    if (liveRaf.current) {
      cancelAnimationFrame(liveRaf.current);
      liveRaf.current = 0;
    }
    // The freehand trace disappears the moment the finger lifts.
    livePolyline.current?.setAttribute("points", "");
    return pts;
  };

  const zoomAround = (point: PointerPosition, targetScale: number) => {
    const current = liveTransform.current;
    if (targetScale === 1) {
      publishTransform(DEFAULT_VIEWER_TRANSFORM, true);
      return;
    }
    const ratio = targetScale / current.scale;
    const center = { x: box.w / 2, y: box.h / 2 };
    publishTransform(
      {
        scale: targetScale,
        translateX: point.x - center.x - ratio * (point.x - center.x - current.translateX),
        translateY: point.y - center.y - ratio * (point.y - center.y - current.translateY),
      },
      true,
    );
  };

  const handleZoomTap = (point: PointerPosition) => {
    const now = performance.now();
    const previous = lastTap.current;
    if (previous && now - previous.time < 320 && Math.hypot(point.x - previous.point.x, point.y - previous.point.y) < 36) {
      if (tapTimer.current) window.clearTimeout(tapTimer.current);
      tapTimer.current = 0;
      lastTap.current = null;
      const targetScale = liveTransform.current.scale <= 1.02 ? zoomScaleForPreset("200", frame, natural) : 1;
      zoomAround(point, targetScale);
      return;
    }
    lastTap.current = { time: now, point };
    if (tapTimer.current) window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = 0;
      lastTap.current = null;
      onTap?.();
    }, 280);
  };

  const onUp = (e: ReactPointerEvent) => {
    const pts = endGesture();
    if (pts) {
      if (tool === "draw") {
        api.addStroke(version.id, pts);
      } else if (tool === "region") {
        const region = regionFromPoints(pts);
        if (region) api.placeRegion(version.id, region);
        else api.showToast("範圍太小，再圈一次");
      }
      return;
    }

    if (!interactive || !zoomable || tool !== "pan" || !activePointers.current.has(e.pointerId)) return;
    const point = stagePoint(e);
    activePointers.current.delete(e.pointerId);
    const gesture = zoomGesture.current;
    if (activePointers.current.size > 0) {
      const [remainingId, remainingPoint] = [...activePointers.current.entries()][0];
      if (gesture?.kind === "pinch") {
        zoomGesture.current = {
          kind: "single",
          start: remainingPoint,
          moved: true,
          startTransform: liveTransform.current,
        };
      }
      return;
    }
    zoomGesture.current = null;
    if (gesture?.kind === "single" && !gesture.moved && point) handleZoomTap(point);
  };

  /** The browser took the pointer (scroll/system gesture): drop the trace, keep quiet. */
  const onCancel = (e: ReactPointerEvent) => {
    endGesture();
    if (zoomable) {
      activePointers.current.delete(e.pointerId);
      if (activePointers.current.size === 0) zoomGesture.current = null;
    }
  };

  const selectedPin = selectedPinId ? allPins.find((pin) => pin.id === selectedPinId) : undefined;

  /**
   * The poster itself stays clean in view mode. Desktop annotation tools reveal
   * active marks; selecting an item from the discussion only reveals that one
   * locator (a thin region box when the feedback circled an area). The mobile
   * 圈範圍 mode shows nothing but the live gesture. Resolved pins live in the
   * list and never remain stamped over the artwork.
   */
  const editingAnnotations = tool === "pin" || tool === "draw" || tool === "erase";
  const circling = tool === "region";
  const selectedRegionPin = !editingAnnotations && !circling && selectedPin?.region ? selectedPin : undefined;
  const pins = editingAnnotations
    ? allPins.filter((pin) => !pin.resolved)
    : !circling && selectedPin && !selectedPin.region
      ? [selectedPin]
      : [];
  // Legacy strokes stay hidden while viewing; the 舊圈畫 manager can preview one.
  const previewStroke =
    tool === "pan" && api.previewStrokeId ? allStrokes.find((s) => s.id === api.previewStrokeId) : undefined;
  const strokes = editingAnnotations ? allStrokes : previewStroke ? [previewStroke] : [];
  const annotationsVisible = showAnnotations || editingAnnotations || Boolean(draftPin);

  const toPolyline = (pts: Point[]) => pts.map((p) => `${p.x * 100},${p.y * 100}`).join(" ");
  const imgStyle = ready
    ? { left: frame.left, top: frame.top, width: frame.width, height: frame.height }
    : { inset: 0 };
  const dimOthers = editingAnnotations && (selectedPinId != null || draftPin != null);
  const contentStyle = zoomable
    ? {
        transform: `translate3d(${activeTransform.translateX}px, ${activeTransform.translateY}px, 0) scale(${activeTransform.scale})`,
        ["--viewer-scale" as string]: String(activeTransform.scale),
        ["--viewer-marker-scale" as string]: String(1 / activeTransform.scale),
      }
    : undefined;

  return (
    <div
      ref={boxRef}
      className={`stage tool-${tool} ${interactive ? "is-interactive" : ""} ${editingAnnotations ? "stage-annotations" : "stage-clean"} ${zoomable ? "stage-zoomable" : ""}`}
      onClick={onClick}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
    >
      <div ref={contentRef} className={`stage-content ${zoomable ? "stage-content-zoomable" : ""}`} style={contentStyle} data-testid="poster-compose-stage">
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
          <div
            className="stage-frame"
            data-density={pins.length > 10 ? "dense" : undefined}
            style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
          >
            <VisualProposalOverlay
              roomId={room.id}
              versionId={version.id}
              author={guest}
              compact={compact}
              canManage={api.canManage}
              showToast={api.showToast}
              onBeginCrop={() => api.setTool("pan")}
            />

            {annotationsVisible && (
            <>
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
              {gestureTool && interactive && (
                <polyline
                  ref={livePolyline}
                  points=""
                  fill="none"
                  stroke={guest.color}
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>

            {selectedRegionPin?.region && (
              <div
                key={selectedRegionPin.id}
                className="region-rect"
                role="img"
                aria-label={`修改點 ${pinNumber(room, selectedRegionPin.id)} 的範圍：${selectedRegionPin.body}`}
                style={{
                  left: `${selectedRegionPin.region.x * 100}%`,
                  top: `${selectedRegionPin.region.y * 100}%`,
                  width: `${selectedRegionPin.region.width * 100}%`,
                  height: `${selectedRegionPin.region.height * 100}%`,
                  ["--pin" as string]: selectedRegionPin.authorColor,
                }}
              >
                <span className="region-tag">{pinNumber(room, selectedRegionPin.id)}</span>
              </div>
            )}

            {draftPin?.region && draftPin.versionId === version.id && (
              <div
                className="region-rect is-draft"
                aria-hidden
                style={{
                  left: `${draftPin.region.x * 100}%`,
                  top: `${draftPin.region.y * 100}%`,
                  width: `${draftPin.region.width * 100}%`,
                  height: `${draftPin.region.height * 100}%`,
                  ["--pin" as string]: guest.color,
                }}
              />
            )}

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

            {draftPin && !draftPin.region && draftPin.versionId === version.id && (
              <span
                className="pin pin-draft"
                style={{ left: `${draftPin.x * 100}%`, top: `${draftPin.y * 100}%` }}
                aria-hidden
              >
                <span className="pin-no">{nextPinNumber(room, version.id)}</span>
              </span>
            )}
            </>
            )}
          </div>
        )}
      </div>

      {!compact && <span className="stage-label">{version.label}</span>}
    </div>
  );
}
