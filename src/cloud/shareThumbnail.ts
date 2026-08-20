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
 * The source is always the ORIGINAL version image. Never a screenshot of the
 * canvas: that would drag pins, regions, proposal overlays and the toolbar into
 * what is supposed to look like a clean poster.
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

type Source = ImageBitmap | HTMLImageElement;

async function loadBitmap(url: string): Promise<Source> {
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
export async function renderShareThumbnail(imageUrl: string): Promise<RenderedThumbnail> {
  const source = await loadBitmap(imageUrl);
  const { w: iw, h: ih } = sizeOf(source);

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  ctx.fillStyle = "#141210";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Backdrop: cover-scaled and pushed back. `ctx.filter` is not universal, so
  // read it back — without blur we still darken, which reads as a plain mat.
  const coverScale = Math.max(CANVAS_W / iw, CANVAS_H / ih);
  const cw = iw * coverScale;
  const ch = ih * coverScale;
  ctx.save();
  let blurred = false;
  try {
    ctx.filter = "blur(30px) brightness(0.42) saturate(0.85)";
    blurred = ctx.filter !== "none";
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
