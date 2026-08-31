import { createImageItem } from "./helpers";
import type { ProposalImageItem } from "./store";

/**
 * Open sticker catalog for the compose layer.
 * Hits are raster data URLs (PNG). Local curated set — tests inject fixtures,
 * no live Iconify/Google roundtrip required.
 */
export type CatalogHit = {
  id: string;
  name: string;
  tags: string[];
  pngDataUrl: string;
};

const PNG = (b64: string) => `data:image/png;base64,${b64}`;

/** 24×24 solid OFL-free rasters (generated, not third-party artwork). */
export const OPEN_STICKER_CATALOG: CatalogHit[] = [
  { id: "tea", name: "茶會", tags: ["茶", "tea", "活動"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGM4EuP1n5aYYdSCUQtGLRi1YNSCUQtGLRi1YGhYAAD7EGyMg6KrxAAAAABJRU5ErkJggg==") },
  { id: "star", name: "星星", tags: ["裝飾", "star"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGN4cajqPy0xw6gFoxaMWjBqwagFoxaMWjBqwdCwAAD+4A8qynCtpgAAAABJRU5ErkJggg==") },
  { id: "loc", name: "地點", tags: ["地點", "location", "地圖"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGOI6sn7T0vMMGrBqAWjFoxaMGrBqAWjFoxaMDQsAACDkjsMdvZJzQAAAABJRU5ErkJggg==") },
  { id: "cal", name: "日曆", tags: ["日期", "calendar"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGOIylv1n5aYYdSCUQtGLRi1YNSCUQtGLRi1YGhYAAAaT36MWFcHqAAAAABJRU5ErkJggg==") },
  { id: "heart", name: "愛心", tags: ["愛心", "heart"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGM4EZDyn5aYYdSCUQtGLRi1YNSCUQtGLRi1YGhYAAAOp5UMMvxXEgAAAABJRU5ErkJggg==") },
  { id: "qr", name: "QR", tags: ["qr", "報名"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGPQ0DH7T0vMMGrBqAWjFoxaMGrBqAWjFoxaMDQsAACmpnRusVURxgAAAABJRU5ErkJggg==") },
  { id: "cam", name: "相機", tags: ["照片", "camera"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGOoiFrwn5aYYdSCUQtGLRi1YNSCUQtGLRi1YGhYAAB0T36MsEvZTQAAAABJRU5ErkJggg==") },
  { id: "mic", name: "喇叭", tags: ["宣傳", "mic"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGNw61nwn5aYYdSCUQtGLRi1YNSCUQtGLRi1YGhYAAADz36MNnvbqgAAAABJRU5ErkJggg==") },
  { id: "ticket", name: "票券", tags: ["票", "ticket"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGPYkuf2n5aYYdSCUQtGLRi1YNSCUQtGLRi1YGhYAABmpGgMtjE9SgAAAABJRU5ErkJggg==") },
  { id: "pin", name: "圖釘", tags: ["標記", "pin"], pngDataUrl: PNG("iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAJUlEQVR4nGOIWhD1n5aYYdSCUQtGLRi1YNSCUQtGLRi1YGhYAACwkjsMYS7m4gAAAABJRU5ErkJggg==") },
];

export function isRasterDataUrl(url: string): boolean {
  return /^data:image\/(png|webp|jpe?g)(;|,)/i.test(url);
}

export function searchOpenStickers(
  query: string,
  catalog: CatalogHit[] = OPEN_STICKER_CATALOG,
): CatalogHit[] {
  const needle = query.trim().toLowerCase();
  const pool = catalog.filter((hit) => isRasterDataUrl(hit.pngDataUrl));
  if (!needle) return pool.slice(0, 12);
  return pool.filter((hit) => {
    const hay = `${hit.name} ${hit.tags.join(" ")} ${hit.id}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function imageItemFromCatalogHit(hit: CatalogHit): ProposalImageItem {
  if (!isRasterDataUrl(hit.pngDataUrl)) {
    throw new Error("圖庫只落 PNG／WebP／JPEG，不把 SVG 當存檔形態。");
  }
  return createImageItem(hit.pngDataUrl, hit.name);
}
