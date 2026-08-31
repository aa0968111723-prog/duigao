/**
 * Working-layer crop / replace math. Display uses CSS; original bytes stay
 * until 存成新版本. Never writes a versions storage path.
 */
import type { ProposalImageItem } from "./store";

export type CropInsets = { l: number; t: number; r: number; b: number };

/** Each edge at most 0.45 so the remaining window is at least 10%. */
export const CROP_EDGE_MAX = 0.45;

export const IDENTITY_CROP: CropInsets = { l: 0, t: 0, r: 0, b: 0 };

export function clampCropEdge(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(CROP_EDGE_MAX, Math.max(0, n));
}

export function clampCrop(raw: Partial<CropInsets> | null | undefined): CropInsets {
  return {
    l: clampCropEdge(raw?.l),
    t: clampCropEdge(raw?.t),
    r: clampCropEdge(raw?.r),
    b: clampCropEdge(raw?.b),
  };
}

export function isIdentityCrop(raw: Partial<CropInsets> | null | undefined): boolean {
  const crop = clampCrop(raw);
  return crop.l === 0 && crop.t === 0 && crop.r === 0 && crop.b === 0;
}

export function parseCrop(raw: unknown): CropInsets | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const crop = clampCrop(raw as Partial<CropInsets>);
  return isIdentityCrop(crop) ? undefined : crop;
}

/** CSS clip-path insets for the working-layer <img>. Box size stays x/y/width. */
export function cropClipPath(raw: Partial<CropInsets> | null | undefined): string | undefined {
  if (isIdentityCrop(raw)) return undefined;
  const crop = clampCrop(raw);
  return `inset(${crop.t * 100}% ${crop.r * 100}% ${crop.b * 100}% ${crop.l * 100}%)`;
}

export function cropObjectPosition(raw: Partial<CropInsets> | null | undefined): string | undefined {
  if (isIdentityCrop(raw)) return undefined;
  const crop = clampCrop(raw);
  const x = crop.l / Math.max(0.001, 1 - crop.r);
  const y = crop.t / Math.max(0.001, 1 - crop.b);
  return `${(x * 100).toFixed(2)}% ${(y * 100).toFixed(2)}%`;
}

/** Replace pixels only. Geometry (x, y, width, crop, rotation) stays. */
export function replaceImageKeepingBox(
  item: ProposalImageItem,
  src: { imageDataUrl: string; name: string },
): ProposalImageItem {
  if (!src.imageDataUrl || src.imageDataUrl.length < 32) return item;
  return {
    ...item,
    imageDataUrl: src.imageDataUrl,
    name: src.name || item.name,
  };
}

export function resetImageGeometry(item: ProposalImageItem): Pick<ProposalImageItem, "x" | "y" | "rotation" | "crop"> {
  return { x: 0.5, y: 0.5, rotation: 0, crop: undefined };
}

export function nudgePosition(x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  const clamp01 = (n: number) => Math.min(0.98, Math.max(0.02, n));
  return { x: clamp01(x + dx), y: clamp01(y + dy) };
}

export type CropHandle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

/** `dx`/`dy` are fractions of the item box (positive = right / down). */
export function applyCropDrag(start: CropInsets, handle: CropHandle, dx: number, dy: number): CropInsets {
  const next: CropInsets = { ...clampCrop(start) };
  if (handle.includes("w")) next.l += dx;
  if (handle.includes("e")) next.r -= dx;
  if (handle.includes("n")) next.t += dy;
  if (handle.includes("s")) next.b -= dy;
  return clampCrop(next);
}

export const CROP_HANDLE_POS: Record<CropHandle, { left: string; top: string }> = {
  n: { left: "50%", top: "0%" },
  s: { left: "50%", top: "100%" },
  e: { left: "100%", top: "50%" },
  w: { left: "0%", top: "50%" },
  nw: { left: "0%", top: "0%" },
  ne: { left: "100%", top: "0%" },
  sw: { left: "0%", top: "100%" },
  se: { left: "100%", top: "100%" },
};

export const CROP_HANDLES = Object.keys(CROP_HANDLE_POS) as CropHandle[];
