import { uid } from "../../lib/id";
import { composeFontFace, composeFontStack } from "./composeFonts";
import type {
  BgImageFit,
  GradientKind,
  ProposalBackground,
  ImageCrop,
  ProposalImageItem,
  ProposalShapeItem,
  ProposalStatus,
  ProposalTextItem,
  ProposalType,
  TextRole,
} from "./store";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Proposal kinds, in the order they read best on a phone. Labels are the only UI copy. */
export const PROPOSAL_TYPES: { key: ProposalType; label: string }[] = [
  { key: "text", label: "文字提案" },
  { key: "font", label: "字體提案" },
  { key: "background", label: "背景提案" },
  { key: "asset", label: "素材提案" },
  { key: "layout", label: "排版提案" },
  { key: "color", label: "色彩提案" },
];

export function proposalTypeLabel(type: ProposalType): string {
  return PROPOSAL_TYPES.find((t) => t.key === type)?.label ?? "排版提案";
}

export const PROPOSAL_STATUSES: { key: ProposalStatus; label: string }[] = [
  { key: "draft", label: "草稿" },
  { key: "discussing", label: "討論中" },
  { key: "accepted", label: "已採用" },
  { key: "rejected", label: "不採用" },
];

export function proposalStatusLabel(status: ProposalStatus): string {
  return PROPOSAL_STATUSES.find((s) => s.key === status)?.label ?? "草稿";
}

export function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) return `rgba(0, 0, 0, ${alpha})`;
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const GRADIENT_ANGLE: Record<Exclude<GradientKind, "none">, string> = {
  vertical: "to bottom",
  horizontal: "to right",
  diagonal: "135deg",
};

/** CSS for the proposal background color / gradient overlay (image handled separately). */
export function backgroundColorCss(bg: ProposalBackground): string | null {
  if (bg.gradient !== "none" && bg.gradientOpacity > 0) {
    const from = hexToRgba(bg.gradientFrom, bg.gradientOpacity);
    const to = hexToRgba(bg.gradientTo, bg.gradientOpacity);
    return `linear-gradient(${GRADIENT_ANGLE[bg.gradient]}, ${from}, ${to})`;
  }
  if (bg.colorOpacity > 0) return hexToRgba(bg.color, bg.colorOpacity);
  return null;
}

export function objectFitFor(fit: BgImageFit): "cover" | "contain" {
  return fit === "contain" ? "contain" : "cover";
}

/** Friendly font "feel" names mapped to loaded Traditional Chinese webfonts. */
export type FontStyle = { key: string; label: string; stack: string; weight: number };

export const FONT_STYLES: FontStyle[] = [
  { key: "modern", label: "現代", stack: composeFontStack("modern"), weight: composeFontFace("modern").weight },
  { key: "solid", label: "穩重", stack: composeFontStack("solid"), weight: composeFontFace("solid").weight },
  { key: "soft", label: "柔和", stack: composeFontStack("soft"), weight: composeFontFace("soft").weight },
  { key: "lively", label: "活潑", stack: composeFontStack("lively"), weight: composeFontFace("lively").weight },
  { key: "serif", label: "明體", stack: composeFontStack("serif"), weight: composeFontFace("serif").weight },
  { key: "hand", label: "手寫感", stack: composeFontStack("hand"), weight: composeFontFace("hand").weight },
];

export function fontStyleByKey(key: string): FontStyle {
  return FONT_STYLES.find((f) => f.key === key) ?? FONT_STYLES[0];
}

export function fontStyleLabel(key: string): string {
  return fontStyleByKey(key).label;
}

/** Common poster copy roles, each with a sensible starting size and default text. */
export type TextRoleDef = {
  key: TextRole;
  label: string;
  placeholder: string;
  fontSize: number;
  fontStyle: string;
  y: number;
  width: number;
};

export const TEXT_ROLES: TextRoleDef[] = [
  { key: "title", label: "主標題", placeholder: "主標題", fontSize: 7, fontStyle: "modern", y: 0.24, width: 80 },
  { key: "subtitle", label: "副標題", placeholder: "副標題", fontSize: 4.4, fontStyle: "soft", y: 0.38, width: 70 },
  { key: "body", label: "內文", placeholder: "內文說明文字", fontSize: 3.2, fontStyle: "soft", y: 0.55, width: 72 },
  { key: "date", label: "日期", placeholder: "2026.06.20", fontSize: 4, fontStyle: "solid", y: 0.7, width: 60 },
  { key: "place", label: "地點", placeholder: "活動地點", fontSize: 3.4, fontStyle: "soft", y: 0.78, width: 60 },
  { key: "cta", label: "行動呼籲", placeholder: "立即報名", fontSize: 3.8, fontStyle: "lively", y: 0.87, width: 50 },
  { key: "custom", label: "自訂", placeholder: "輸入文字", fontSize: 4.5, fontStyle: "modern", y: 0.5, width: 70 },
];

export function textRoleLabel(role: TextRole): string {
  return TEXT_ROLES.find((r) => r.key === role)?.label ?? "文字";
}

/** Build a text item from a role preset so "add text" needs no configuration up front. */
export function createTextItem(role: TextRole): ProposalTextItem {
  const preset = TEXT_ROLES.find((r) => r.key === role) ?? TEXT_ROLES[TEXT_ROLES.length - 1];
  const style = fontStyleByKey(preset.fontStyle);
  return {
    id: uid("vpt_"),
    type: "text",
    role,
    text: preset.placeholder,
    x: 0.5,
    y: preset.y,
    width: preset.width,
    rotation: 0,
    opacity: 1,
    visible: true,
    fontFamily: style.stack,
    fontStyle: style.key,
    fontSize: preset.fontSize,
    fontWeight: style.weight,
    color: "#ffffff",
    align: "center",
    backdropColor: "#000000",
    backdropOpacity: 0,
    backdropPadding: 0.3,
    backdropRadius: 8,
  };
}

export function createImageItem(imageDataUrl: string, name: string): ProposalImageItem {
  return {
    id: uid("vpi_"),
    type: "image",
    name,
    imageDataUrl,
    x: 0.5,
    y: 0.5,
    width: 32,
    rotation: 0,
    opacity: 1,
    visible: true,
  };
}

export function clampCrop(crop: { x: number; y: number; width: number; height: number }): ImageCrop {
  const x = clamp(crop.x, 0, 0.85);
  const y = clamp(crop.y, 0, 0.85);
  return {
    x,
    y,
    width: clamp(crop.width, 0.15, 1 - x),
    height: clamp(crop.height, 0.15, 1 - y),
  };
}

/** Inset the visible window. Repeatable; stored on the item JSON. */
export function insetCrop(crop: ImageCrop | undefined, pad = 0.08): ImageCrop {
  const base = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  return clampCrop({
    x: base.x + pad * base.width,
    y: base.y + pad * base.height,
    width: base.width * (1 - 2 * pad),
    height: base.height * (1 - 2 * pad),
  });
}

export function replaceImageKeepingFrame(
  item: ProposalImageItem,
  imageDataUrl: string,
  name: string,
): ProposalImageItem {
  return { ...item, imageDataUrl, name, crop: undefined };
}

export function nudgeItemPosition(x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  return { x: clamp(x + dx, 0, 1), y: clamp(y + dy, 0, 1) };
}

export function nextRotation(rotation: number, step = 15): number {
  return ((Math.round(rotation) + step) % 360 + 360) % 360;
}

/** A colour block — the simplest "cover this / add a band here" proposal element. */
export function createShapeItem(color = "#c45c4a"): ProposalShapeItem {
  return {
    id: uid("vps_"),
    type: "shape",
    color,
    x: 0.5,
    y: 0.5,
    width: 60,
    height: 18,
    radius: 10,
    rotation: 0,
    opacity: 0.9,
    visible: true,
  };
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // hard cap before we even try to read
const MAX_EDGE = 1600; // long-edge cap keeps base64 (and IndexedDB) reasonable

export type PreparedImage = { dataUrl: string; name: string; note?: string };

/**
 * Read + downscale an uploaded image so IndexedDB is not blown up by a huge
 * photo. Transparent formats (PNG / WEBP) keep PNG output to preserve alpha;
 * SVG is passed through untouched (vector, tiny, no raster needed).
 */
export async function prepareImageFile(file: File): Promise<PreparedImage> {
  const namedImage = /\.(png|jpe?g|webp|gif|svg)$/i.test(file.name);
  if (file.type && !file.type.startsWith("image/") && !namedImage) {
    throw new Error("這個檔案不是圖片，請換一張。");
  }
  if (!file.type && !namedImage) {
    throw new Error("這個檔案不是圖片，請換一張。");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("圖片太大了（超過 12MB），請先縮小或換一張。");
  }

  const original = await fileToDataUrl(file);
  if (file.type === "image/svg+xml") {
    return { dataUrl: original, name: file.name };
  }

  const keepAlpha = file.type === "image/png" || file.type === "image/webp";
  try {
    const img = await loadImage(original);
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    if (longEdge <= MAX_EDGE) {
      return { dataUrl: original, name: file.name };
    }
    const scale = MAX_EDGE / longEdge;
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl: original, name: file.name };
    ctx.drawImage(img, 0, 0, w, h);
    const outMime = keepAlpha ? "image/png" : "image/jpeg";
    const out = canvas.toDataURL(outMime, keepAlpha ? undefined : 0.85);
    return { dataUrl: out, name: file.name, note: "圖片已自動縮小以維持順暢" };
  } catch {
    // If anything about canvas fails, fall back to the original data URL.
    return { dataUrl: original, name: file.name };
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("圖片讀取失敗"));
    img.src = src;
  });
}
