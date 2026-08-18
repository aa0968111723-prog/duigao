import { uid } from "../../lib/id";
import type {
  BgImageFit,
  GradientKind,
  ProposalBackground,
  ProposalImageItem,
  ProposalTextItem,
  TextRole,
} from "./store";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

/** Friendly font "feel" names mapped to safe system font stacks — no engineering names. */
export type FontStyle = { key: string; label: string; stack: string; weight: number };

export const FONT_STYLES: FontStyle[] = [
  { key: "modern", label: "現代", stack: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif', weight: 700 },
  { key: "solid", label: "穩重", stack: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif', weight: 900 },
  { key: "soft", label: "柔和", stack: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif', weight: 400 },
  { key: "lively", label: "活潑", stack: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif', weight: 800 },
  { key: "serif", label: "明體", stack: '"Noto Serif TC", "Songti TC", "PMingLiU", serif', weight: 600 },
  { key: "hand", label: "手寫感", stack: '"DFKai-SB", "BiauKai", "Noto Serif TC", cursive', weight: 500 },
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
  if (!file.type.startsWith("image/")) {
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
