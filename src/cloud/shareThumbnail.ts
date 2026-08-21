/**
 * The share-card image (PR #21).
 *
 * Kept free of any Supabase / Vite import on purpose: this is pure canvas work,
 * which makes the one property that actually matters directly testable in a
 * browser — **the poster is contained, never cropped and never stretched.**
 * A portrait event poster squeezed into a 1200×630 card by a cover-crop would
 * lose its title at the top and its date / QR code at the bottom, which is the
 * exact failure this module exists to avoid.
 *
 * The source is always the ORIGINAL version image — for a video room, the
 * poster frame captured at upload. Never a screenshot of the canvas or of the
 * player: that would drag pins, regions, proposal overlays, the transport bar,
 * the timeline and the toolbar into what is supposed to look like a clean frame.
 *
 * A host-supplied cover (PR #30) goes through the exact same renderer, so an
 * 8MB phone photo becomes the same small, contained 1200×630 derivative as
 * everything else — the original file is never uploaded anywhere.
 */

/** Open Graph's canonical card size. */
export const CANVAS_W = 1200;
export const CANVAS_H = 630;
/** Breathing room so a contained poster never touches the card edge. */
export const PAD = 18;
/** A LINE card is a thumbnail, not a deliverable — stay well under a megabyte. */
const TARGET_BYTES = 700 * 1024;
const QUALITY_STEPS = [0.82, 0.72, 0.62, 0.5, 0.4];

export type RenderedThumbnail = { blob: Blob; mime: string };

/**
 * Optional decoration for a video room's card: a play glyph over the frame, and
 * the running time in the corner. Nothing here touches the fit — the frame is
 * still contained, and no app UI, timeline or comment ever reaches the card.
 */
export type ThumbnailDecoration = { play?: boolean; durationLabel?: string };

type Source = ImageBitmap | HTMLImageElement;

/**
 * What a card may be rendered from.
 *
 * A URL is the room's own artwork (a poster, or a video's captured poster
 * frame). A Blob is a cover the host picked from their camera roll — it is
 * rendered here, client-side, and only the 1200×630 derivative is ever
 * uploaded. The original file never reaches the public bucket.
 */
export type ThumbnailSource = string | Blob;

/** What a custom cover may be. Anything else is refused before it is read. */
export const COVER_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

async function loadBitmap(source: ThumbnailSource): Promise<Source> {
  if (typeof source !== "string") return await loadBlob(source);
  const url = source;
  // fetch → blob → bitmap keeps the canvas untainted no matter how the storage
  // URL is served, and gives a clear failure instead of a silent security error.
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) throw new Error(`thumbnail source ${res.status}`);
    const blob = await res.blob();
    if (typeof createImageBitmap === "function") return await createImageBitmap(blob);
    return await loadImageElement(URL.createObjectURL(blob), true);
  } catch {
    // Older Safari has no createImageBitmap for some types; try the img path.
    return await loadImageElement(url, false);
  }
}

/** A picked file never travels through the network, so it skips the fetch. */
async function loadBlob(blob: Blob): Promise<Source> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through to the <img> path below */
    }
  }
  return await loadImageElement(URL.createObjectURL(blob), true);
}

function loadImageElement(src: string, revoke: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (revoke) URL.revokeObjectURL(src);
      resolve(img);
    };
    img.onerror = () => {
      if (revoke) URL.revokeObjectURL(src);
      reject(new Error("thumbnail source failed to load"));
    };
    img.src = src;
  });
}

function sizeOf(source: Source): { w: number; h: number } {
  const w = "naturalWidth" in source ? source.naturalWidth : source.width;
  const h = "naturalHeight" in source ? source.naturalHeight : source.height;
  return { w: w || 1, h: h || 1 };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** Where the poster lands inside the card. Uniform scale — aspect ratio is never touched. */
export function containRect(iw: number, ih: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min((CANVAS_W - PAD * 2) / iw, (CANVAS_H - PAD * 2) / ih);
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  return { x: Math.round((CANVAS_W - w) / 2), y: Math.round((CANVAS_H - h) / 2), w, h };
}

/**
 * Compose the card: the poster contained over a darkened, blurred blow-up of
 * itself. The blur is decoration; the contain is the contract.
 *
 * Transparent PNGs composite onto that opaque backdrop, so alpha never turns
 * into the checkerboard-grey mush a naive JPEG flatten produces.
 */
export async function renderShareThumbnail(
  imageUrl: ThumbnailSource,
  decoration?: ThumbnailDecoration,
): Promise<RenderedThumbnail> {
  const source = await loadBitmap(imageUrl);
  const { w: iw, h: ih } = sizeOf(source);

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  ctx.fillStyle = "#141210";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Backdrop: cover-scaled and pushed back. `ctx.filter` is not universal
  // (Safari < 16.4), and on those browsers the assignment just creates an own
  // property that reads back unchanged — so the support test has to look at the
  // prototype, not at the value. Without blur we darken instead, which reads as
  // a plain mat; without either, the card would be a bright cropped duplicate.
  const coverScale = Math.max(CANVAS_W / iw, CANVAS_H / ih);
  const cw = iw * coverScale;
  const ch = ih * coverScale;
  ctx.save();
  let blurred = false;
  try {
    if ("filter" in Object.getPrototypeOf(ctx)) {
      ctx.filter = "blur(30px) brightness(0.42) saturate(0.85)";
      blurred = ctx.filter !== "none";
    }
  } catch {
    blurred = false;
  }
  ctx.drawImage(source, (CANVAS_W - cw) / 2, (CANVAS_H - ch) / 2, cw, ch);
  ctx.restore();
  if (!blurred) {
    ctx.fillStyle = "rgba(20, 18, 16, 0.82)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }

  // Foreground: the poster itself, whole.
  const fit = containRect(iw, ih);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, fit.x, fit.y, fit.w, fit.h);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
  ctx.lineWidth = 1;
  ctx.strokeRect(fit.x + 0.5, fit.y + 0.5, fit.w - 1, fit.h - 1);

  if (decoration?.play) drawPlayBadge(ctx, fit);
  if (decoration?.durationLabel) drawDurationBadge(ctx, fit, decoration.durationLabel);

  if ("close" in source && typeof source.close === "function") source.close();

  // WebP first, JPEG when the browser cannot encode it. Step the quality down
  // until the card is comfortably small; keep the last result either way.
  for (const type of ["image/webp", "image/jpeg"]) {
    for (const quality of QUALITY_STEPS) {
      const blob = await toBlob(canvas, type, quality);
      if (!blob) break;
      if (blob.type !== type) break; // encoder unsupported — try the next type
      if (blob.size <= TARGET_BYTES || quality === QUALITY_STEPS[QUALITY_STEPS.length - 1]) {
        return { blob, mime: type };
      }
    }
  }
  throw new Error("thumbnail encoding failed");
}

/** A soft disc with a triangle: the one universally understood "this plays". */
function drawPlayBadge(
  ctx: CanvasRenderingContext2D,
  fit: { x: number; y: number; w: number; h: number },
): void {
  const cx = fit.x + fit.w / 2;
  const cy = fit.y + fit.h / 2;
  const r = Math.max(34, Math.min(fit.w, fit.h) * 0.14);

  ctx.save();
  ctx.fillStyle = "rgba(16, 14, 12, 0.55)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.72)";
  ctx.lineWidth = Math.max(2, r * 0.06);
  ctx.stroke();

  // Optically centred: a triangle balanced on its bounding box reads left-heavy.
  const t = r * 0.46;
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.beginPath();
  ctx.moveTo(cx - t * 0.55 + t * 0.18, cy - t);
  ctx.lineTo(cx + t + t * 0.18, cy);
  ctx.lineTo(cx - t * 0.55 + t * 0.18, cy + t);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Running time, bottom-right of the frame itself so it cannot look like chrome. */
function drawDurationBadge(
  ctx: CanvasRenderingContext2D,
  fit: { x: number; y: number; w: number; h: number },
  label: string,
): void {
  ctx.save();
  const fontSize = 26;
  ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Noto Sans TC", sans-serif`;
  const padX = 14;
  const padY = 8;
  const textWidth = ctx.measureText(label).width;
  const w = textWidth + padX * 2;
  const h = fontSize + padY * 2;
  const x = fit.x + fit.w - w - 16;
  const y = fit.y + fit.h - h - 16;

  ctx.fillStyle = "rgba(16, 14, 12, 0.66)";
  const r = 10;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + padX, y + h / 2 + 1);
  ctx.restore();
}
