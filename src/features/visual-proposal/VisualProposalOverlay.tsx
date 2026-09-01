import { memo, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useProposalStore, type ProposalAuthor, type ProposalItem } from "./store";
import { OPEN_COMPOSE_PICKER_EVENT } from "./ComposeAssetPicker";
import { backgroundColorCss, clamp, hexToRgba, objectFitFor, prepareImageFile, proposalTypeLabel } from "./helpers";
import type { ImageCrop } from "./store";
import { ensureComposeFonts } from "./composeFonts";
import { OpenStickerPicker } from "./OpenStickerPicker";
import { QuickEditBar } from "./QuickEditBar";
import {
  applyCropDrag,
  clampCrop,
  CROP_HANDLE_POS,
  CROP_HANDLES,
  cropClipPath,
  cropObjectPosition,
  IDENTITY_CROP,
  isBoxCrop,
  nudgePosition,
  toInsets,
  type CropHandle,
  type CropInsets,
} from "./quickEdit";
import type { ShowToast } from "../../toast";
import "./proposal.css";

export const COMPOSE_VERSION_SAVED_EVENT = "duigao-compose-version-saved";

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
  compact?: boolean;
  canManage?: boolean;
  showToast?: ShowToast;
  onBeginCrop?: () => void;
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

export function VisualProposalOverlay({
  roomId,
  versionId,
  author,
  compact,
  canManage = false,
  showToast,
  onBeginCrop,
}: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  useEffect(() => { ensureComposeFonts(); }, []);
  const gesture = useRef<Gesture | null>(null);
  const resize = useRef<{ id: string; cx: number; cy: number; startDist: number; startWidth: number } | null>(null);
  const cropDrag = useRef<{
    handle: CropHandle;
    start: CropInsets;
    clientX: number;
    clientY: number;
    width: number;
    height: number;
  } | null>(null);
  const nudgeHold = useRef<ReturnType<typeof setInterval> | null>(null);
  const nudgeTicks = useRef(0);
  const replaceFileRef = useRef<HTMLInputElement>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [quickTool, setQuickTool] = useState<"move" | "crop">("move");
  const [cropMode, setCropMode] = useState(false);
  const [cropDraft, setCropDraft] = useState<CropInsets>(IDENTITY_CROP);
  const [liveHint, setLiveHint] = useState<"watching" | "saved">("watching");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);

  const { active, editing, visible, viewMode, compareSplit, selectedItem, layerEditing } = proposal;
  const selectedRef = useRef(selectedItem);
  selectedRef.current = selectedItem;

  const cancelCrop = () => {
    setCropMode(false);
    setQuickTool("move");
    setCropDraft(selectedItem?.type === "image" ? toInsets(selectedItem.crop) : IDENTITY_CROP);
  };

  const replaceFromFile = async (file: File) => {
    try {
      const prepared = await prepareImageFile(file);
      proposal.replaceSelectedImage({ imageDataUrl: prepared.dataUrl, name: prepared.name });
      setReplaceOpen(false);
      setStickerOpen(false);
      showToast?.(prepared.note ?? "已換圖，框位還在");
    } catch (err) {
      showToast?.(err instanceof Error ? err.message : "換圖失敗，請再試一次", { tone: "error" });
    }
  };

  useEffect(() => {
    const onSaved = () => setLiveHint("saved");
    window.addEventListener(COMPOSE_VERSION_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(COMPOSE_VERSION_SAVED_EVENT, onSaved);
  }, []);

  useEffect(() => {
    if (editing) setLiveHint((prev) => (prev === "saved" ? "saved" : "watching"));
  }, [editing]);

  useEffect(() => {
    if (selectedItem?.type !== "image") {
      setCropMode(false);
      setQuickTool("move");
      setReplaceOpen(false);
      setStickerOpen(false);
    }
  }, [selectedItem?.id, selectedItem?.type]);

  useEffect(() => {
    if (!editing || !canManage || !selectedItem) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
        return;
      }
      const step = event.shiftKey ? 0.03 : 0.01;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        proposal.updateItem(selectedItem.id, nudgePosition(selectedItem.x, selectedItem.y, -step, 0));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        proposal.updateItem(selectedItem.id, nudgePosition(selectedItem.x, selectedItem.y, step, 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        proposal.updateItem(selectedItem.id, nudgePosition(selectedItem.x, selectedItem.y, 0, -step));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        proposal.updateItem(selectedItem.id, nudgePosition(selectedItem.x, selectedItem.y, 0, step));
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        proposal.deleteItem(selectedItem.id);
      } else if (event.key === "Escape" && cropMode) {
        event.preventDefault();
        cancelCrop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canManage, cropMode, editing, proposal, selectedItem]);

  useEffect(() => {
    if (!editing || !canManage) return;
    const onPaste = (event: ClipboardEvent) => {
      if (selectedItem?.type !== "image") return;
      const file = [...(event.clipboardData?.files ?? [])].find((entry) => entry.type.startsWith("image/"));
      if (!file) return;
      event.preventDefault();
      void replaceFromFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [canManage, editing, selectedItem]);

  useEffect(() => () => {
    if (nudgeHold.current) clearInterval(nudgeHold.current);
  }, []);

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
  const pickable = canManage && !editing;
  const showQuick = Boolean(canManage && editing && selectedItem);
  const imageCount = active.items.filter((item) => item.type === "image").length;

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
    if (!canManage) return;
    event.stopPropagation();
    proposal.selectItem(item.id);
    if (!editing) {
      proposal.setEditing(true);
      return;
    }
    if (cropMode) return;
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
    if (!selectedItem || cropMode) return;
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

  const startCrop = () => {
    if (!selectedItem || selectedItem.type !== "image") return;
    setQuickTool("crop");
    setCropMode(true);
    setCropDraft(toInsets(selectedItem.crop));
    onBeginCrop?.();
  };

  const confirmCrop = () => {
    if (!selectedItem || selectedItem.type !== "image") return;
    const next = clampCrop(cropDraft);
    proposal.updateItem(selectedItem.id, { crop: next });
    setCropMode(false);
    setQuickTool("move");
  };

  const onCropHandleDown = (event: ReactPointerEvent<HTMLElement>, handle: CropHandle) => {
    event.stopPropagation();
    event.preventDefault();
    const wrap = event.currentTarget.closest(".proposal-item-wrap") as HTMLElement | null;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    cropDrag.current = {
      handle,
      start: clampCrop(cropDraft),
      clientX: event.clientX,
      clientY: event.clientY,
      width: rect.width || 1,
      height: rect.height || 1,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onCropHandleMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = cropDrag.current;
    if (!drag) return;
    event.stopPropagation();
    const dx = (event.clientX - drag.clientX) / drag.width;
    const dy = (event.clientY - drag.clientY) / drag.height;
    setCropDraft(applyCropDrag(drag.start, drag.handle, dx, dy));
  };

  const onCropHandleUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!cropDrag.current) return;
    event.stopPropagation();
    cropDrag.current = null;
  };

  const stopNudge = () => {
    if (nudgeHold.current) {
      clearInterval(nudgeHold.current);
      nudgeHold.current = null;
      proposal.endEdit();
    }
  };

  const startNudge = (dirX: number, dirY: number) => {
    if (!selectedItem) return;
    stopNudge();
    proposal.beginEdit();
    const apply = (step: number) => {
      const current = selectedRef.current;
      if (!current) return;
      proposal.updateItemLive(current.id, nudgePosition(current.x, current.y, dirX * step, dirY * step));
    };
    apply(0.01);
    nudgeTicks.current = 0;
    nudgeHold.current = setInterval(() => {
      nudgeTicks.current += 1;
      apply(nudgeTicks.current > 8 ? 0.03 : 0.01);
    }, 80);
  };

  const hintText =
    liveHint === "saved"
      ? "已加一版，大家可對照"
      : imageCount === 1
        ? "大家在看這張 · 你在工作層改 · 可裁剪或換這一塊"
        : "大家在看這張 · 你在工作層改";

  return (
    <div
      className={`proposal-layer ${editing ? "is-editing" : "is-preview"} ${pickable ? "can-pick" : ""} ${comparing ? "is-comparing" : ""}`}
      data-testid="poster-compose-canvas"
      data-cropping={cropMode ? "true" : undefined}
      onPointerDown={(event) => {
        if (!editing) return;
        event.stopPropagation();
        if (cropMode) return;
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
              selected={(editing || pickable) && selectedItem?.id === item.id}
              crop={item.type === "image" && cropMode && selectedItem?.id === item.id ? cropDraft : item.type === "image" ? item.crop : undefined}
              cropping={cropMode && selectedItem?.id === item.id && item.type === "image"}
              onPointerDown={onItemPointerDown}
              onPointerMove={onItemPointerMove}
              onPointerUp={onItemPointerUp}
              onCropHandleDown={onCropHandleDown}
              onCropHandleMove={onCropHandleMove}
              onCropHandleUp={onCropHandleUp}
            />
          ))}
      </div>

      {comparing && (
        <>
          <button
            type="button"
            className="proposal-compare-line"
            data-testid="proposal-compare-line"
            aria-label="拖動對照"
            style={{ left: `${compareSplit * 100}%` }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const layer = event.currentTarget.parentElement;
              if (!layer) return;
              const rect = layer.getBoundingClientRect();
              proposal.setCompareSplit(clamp((event.clientX - rect.left) / (rect.width || 1), 0, 1));
            }}
          />
          <span className="proposal-compare-tag proposal-compare-tag-left">原稿</span>
          <span className="proposal-compare-tag proposal-compare-tag-right">工作層</span>
          <input
            type="range"
            className="proposal-compare-slider"
            data-testid="proposal-compare-slider"
            min={0}
            max={1}
            step={0.01}
            value={compareSplit}
            aria-label="對照位置"
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => proposal.setCompareSplit(Number(event.target.value))}
          />
        </>
      )}

      {editing && active.items.length === 0 && !background.imageDataUrl && (
        <p className="poster-compose-empty-hint" data-testid="poster-compose-empty-hint">
          把 logo、照片丟上來，或
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
          。拼完按存成新版本。
        </p>
      )}

      {editing && guides.x != null && <span className="proposal-guide proposal-guide-v" style={{ left: `${guides.x * 100}%` }} aria-hidden />}
      {editing && guides.y != null && <span className="proposal-guide proposal-guide-h" style={{ top: `${guides.y * 100}%` }} aria-hidden />}

      {editing && selectedItem && !cropMode && (
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

      {showQuick && selectedItem && (
        <div data-testid="poster-item-shortcuts" aria-label="移動 裁剪 換圖">
          <QuickEditBar
            item={selectedItem}
            tool={quickTool}
            cropping={cropMode}
            onTool={(tool) => {
              if (tool === "crop") startCrop();
              else cancelCrop();
            }}
            onRotate={(delta) => {
              proposal.updateItem(selectedItem.id, { rotation: clamp(selectedItem.rotation + delta, -180, 180) });
            }}
            onCenter={(axis) => proposal.updateItem(selectedItem.id, { [axis]: 0.5 })}
            onReplace={() => {
              setStickerOpen(false);
              setReplaceOpen(true);
            }}
            onDelete={() => proposal.deleteItem(selectedItem.id)}
            onCropConfirm={confirmCrop}
            onCropCancel={cancelCrop}
            onNudgeStart={startNudge}
            onNudgeEnd={stopNudge}
          />
        </div>
      )}

      {replaceOpen && canManage && editing && (
        <div
          className="quick-edit-replace"
          data-testid="quick-edit-replace"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => replaceFileRef.current?.click()}>從相簿</button>
          <button type="button" onClick={() => { setReplaceOpen(false); setStickerOpen(true); }}>開源貼圖</button>
          <button type="button" onClick={() => setReplaceOpen(false)}>取消</button>
        </div>
      )}

      {stickerOpen && canManage && editing && (
        <div
          className="quick-edit-stickers"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <OpenStickerPicker
            onPick={(hit) => {
              proposal.replaceSelectedImage({ imageDataUrl: hit.pngDataUrl, name: hit.name });
              setStickerOpen(false);
              showToast?.("已換圖，框位還在");
            }}
          />
        </div>
      )}

      <input
        ref={replaceFileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void replaceFromFile(file);
        }}
      />

      {canManage && editing && (
        <p className="live-edit-hint" data-testid="live-edit-hint">
          {hintText}
        </p>
      )}

      <span className={`proposal-preview-label ${active.status === "accepted" ? "is-accepted" : ""}`}>
        {active.status === "accepted" ? "已採用 · " : ""}
        {active.title} · {proposalTypeLabel(active.type)}
      </span>

    </div>
  );
}

type ItemViewProps = {
  item: ProposalItem;
  selected: boolean;
  crop?: CropInsets | ImageCrop;
  cropping?: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, item: ProposalItem) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onCropHandleDown: (e: ReactPointerEvent<HTMLElement>, handle: CropHandle) => void;
  onCropHandleMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onCropHandleUp: (e: ReactPointerEvent<HTMLElement>) => void;
};

const ProposalItemView = memo(function ProposalItemView({
  item,
  selected,
  crop,
  cropping,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onCropHandleDown,
  onCropHandleMove,
  onCropHandleUp,
}: ItemViewProps) {
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
    const box = isBoxCrop(crop) ? crop : isBoxCrop(item.crop) ? item.crop : undefined;
    const insets = crop && !isBoxCrop(crop) ? crop : undefined;
    const clip = cropClipPath(insets);
    const objectPosition = cropObjectPosition(insets);
    return (
      <div className={`proposal-item-wrap ${selected ? "is-selected-wrap" : ""}`} style={shared}>
        <button
          type="button"
          className={`proposal-item proposal-image ${selected ? "is-selected" : ""} ${box ? "has-crop" : ""}`}
          style={box ? { ["--crop-ar" as string]: `${box.width} / ${box.height}` } : undefined}
          {...handlers}
          aria-label={`素材：${item.name}`}
          aria-pressed={selected}
        >
          {box ? (
            <span className="proposal-image-crop">
              <img
                src={item.imageDataUrl}
                alt={item.name}
                draggable={false}
                style={{
                  width: `${100 / box.width}%`,
                  height: `${100 / box.height}%`,
                  left: `${-box.x / box.width * 100}%`,
                  top: `${-box.y / box.height * 100}%`,
                  maxWidth: "none",
                }}
              />
            </span>
          ) : (
            <img
              src={item.imageDataUrl}
              alt={item.name}
              draggable={false}
              style={clip || objectPosition ? { clipPath: clip, objectPosition } : undefined}
            />
          )}
        </button>
        {cropping &&
          CROP_HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              className={`crop-handle crop-handle-${handle}`}
              data-testid={`crop-handle-${handle}`}
              style={CROP_HANDLE_POS[handle]}
              aria-label={`裁剪 ${handle}`}
              onPointerDown={(event) => onCropHandleDown(event, handle)}
              onPointerMove={onCropHandleMove}
              onPointerUp={onCropHandleUp}
              onPointerCancel={onCropHandleUp}
              onClick={(event) => event.stopPropagation()}
            />
          ))}
      </div>
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
