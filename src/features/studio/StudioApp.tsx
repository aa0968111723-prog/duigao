import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { postStudioToParent, type StudioExportPayload } from "../../lib/studioEmbed";
import {
  addShapeElement,
  addTextElement,
  blankDesign,
  drawDesign,
  patchElement,
  type StudioDesign,
} from "./studioModel";
import { closeNativeStudio, useStudio } from "./studioStore";

function defaultName(kind: "poster" | "video"): string {
  return kind === "video" ? "未命名影片" : "未命名海報";
}

async function blobFromCanvas(canvas: HTMLCanvasElement, mime: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("export failed"));
    }, mime);
  });
}

async function exportDesign(design: StudioDesign): Promise<{ file: File; payload: StudioExportPayload }> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(design.width));
  canvas.height = Math.max(1, Math.round(design.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  drawDesign(ctx, design);

  if (design.kind === "video" && typeof MediaRecorder !== "undefined" && typeof canvas.captureStream === "function") {
    const stream = canvas.captureStream(24);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    const file = await new Promise<File>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => reject(new Error("record failed"));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        resolve(new File([blob], `${design.name || defaultName("video")}.webm`, { type: "video/webm" }));
      };
      recorder.start();
      window.setTimeout(() => {
        try {
          recorder.stop();
        } catch {
          reject(new Error("record stop failed"));
        }
        stream.getTracks().forEach((track) => track.stop());
      }, 400);
    });
    return {
      file,
      payload: {
        kind: "video",
        name: design.name,
        mime: "video/webm",
        filename: file.name,
        width: design.width,
        height: design.height,
        duration: design.duration || 6,
      },
    };
  }

  const blob = await blobFromCanvas(canvas, "image/png");
  const file = new File([blob], `${design.name || defaultName("poster")}.png`, { type: "image/png" });
  return {
    file,
    payload: {
      kind: "poster",
      name: design.name,
      mime: "image/png",
      filename: file.name,
      width: design.width,
      height: design.height,
    },
  };
}

async function payloadWithDataUrl(file: File, payload: StudioExportPayload): Promise<StudioExportPayload> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { ...payload, dataUrl };
}

export function StudioApp() {
  const session = useStudio();
  const [design, setDesign] = useState<StudioDesign>(() =>
    blankDesign(session.kind, session.name || defaultName(session.kind), session.width, session.height),
  );
  const [selectedId, setSelectedId] = useState<string | null>(design.elements[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (!session.open) return;
    setDesign(blankDesign(session.kind, session.name || defaultName(session.kind), session.width, session.height));
  }, [session.open, session.kind, session.name, session.width, session.height]);

  const selected = useMemo(
    () => design.elements.find((element) => element.id === selectedId) ?? null,
    [design.elements, selectedId],
  );

  const scale = Math.min(1, 360 / design.width, 520 / design.height);

  function cancel() {
    session.onCancel?.();
    if (session.embed) postStudioToParent({ source: "inlay", type: "inlay:cancel" });
    closeNativeStudio();
  }

  async function finish() {
    if (busy) return;
    setBusy(true);
    try {
      const { file, payload } = await exportDesign(design);
      session.onExport?.(file, payload);
      if (session.embed) {
        postStudioToParent({
          source: "inlay",
          type: "inlay:export",
          payload: await payloadWithDataUrl(file, payload),
        });
      }
      closeNativeStudio();
    } catch {
      setBusy(false);
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    const element = design.elements.find((item) => item.id === id);
    if (!element || element.locked) return;
    setSelectedId(id);
    const host = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!host) return;
    dragRef.current = {
      id,
      dx: (event.clientX - host.left) / scale - element.x,
      dy: (event.clientY - host.top) / scale - element.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const host = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!host) return;
    const x = (event.clientX - host.left) / scale - drag.dx;
    const y = (event.clientY - host.top) / scale - drag.dy;
    setDesign((current) => patchElement(current, drag.id, { x, y }));
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  return (
    <div className="studio-app" data-testid="studio-app" role="dialog" aria-label="圖影編輯器">
      <header className="studio-app-bar">
        <button type="button" className="studio-app-ghost" onClick={cancel}>取消</button>
        <strong>{design.name}</strong>
        <button type="button" className="studio-app-done" data-testid="studio-export" onClick={() => void finish()} disabled={busy}>
          完成，送到對稿
        </button>
      </header>
      <div className="studio-app-tools">
        <button type="button" onClick={() => setDesign((current) => addTextElement(current))}>＋文字</button>
        <button type="button" onClick={() => setDesign((current) => addShapeElement(current))}>＋色塊</button>
        <label className="studio-app-bg">
          底
          <input
            type="color"
            value={design.background}
            aria-label="背景色"
            onChange={(event) => setDesign((current) => ({ ...current, background: event.target.value }))}
          />
        </label>
      </div>
      <div className="studio-app-stage">
        <div
          className="studio-app-canvas"
          style={{
            width: design.width * scale,
            height: design.height * scale,
            background: design.background,
          }}
        >
          {design.elements.filter((element) => !element.hidden).map((element) => (
            <button
              type="button"
              key={element.id}
              className={`studio-el${selectedId === element.id ? " is-selected" : ""}`}
              style={{
                left: element.x * scale,
                top: element.y * scale,
                width: element.width * scale,
                height: element.height * scale,
                opacity: element.opacity,
                transform: `rotate(${element.rotation}deg)`,
                background: element.type === "shape" ? element.fill : "transparent",
                borderRadius: element.type === "shape" ? 12 : 0,
                color: element.type === "text" ? element.color : undefined,
                fontSize: element.type === "text" ? element.fontSize * scale : undefined,
                fontWeight: element.type === "text" ? element.fontWeight : undefined,
                fontStyle: element.type === "text" && element.italic ? "italic" : undefined,
                textAlign: element.type === "text" ? element.align : undefined,
              }}
              onPointerDown={(event) => onPointerDown(event, element.id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {element.type === "text" ? element.content : ""}
            </button>
          ))}
        </div>
      </div>
      {selected?.type === "text" ? (
        <label className="studio-app-inspect">
          文字
          <input
            value={selected.content}
            onChange={(event) => setDesign((current) => patchElement(current, selected.id, { content: event.target.value, name: event.target.value }))}
          />
        </label>
      ) : (
        <p className="studio-app-hint">匯出是新檔，原稿不被修改。</p>
      )}
    </div>
  );
}
