import type { MediaType } from "./types";

/**
 * 分享語境 — the ONE place that knows whether a share is about 一張文宣 or
 * 一支影片 (PR #30).
 *
 * Before this module the ShareSheet hard-wrote 「這張文宣」/「顯示文宣縮圖」/
 * 「低解析度文宣預覽」 in five different places, so a video room played a video
 * but shared a poster: the LINE message said 文宣, the toggle said 文宣, and the
 * fallback card said 文宣討論區. Copy that has to agree across the sheet, the
 * LINE deep link, the OS share sheet, the clipboard text and the Edge Function
 * cannot be re-typed per call site — it has to be derived, once, from the room's
 * media type.
 *
 * Deliberately dependency-free (no React, no Supabase, no Vite env) so the Edge
 * Function's copy and the e2e suites can be checked against the same constants.
 */

/* ------------------------------------------------------------- constants -- */

/** Product label a stranger sees when there is no room-specific card. */
export const IMAGE_BRAND = "文宣討論區";
export const VIDEO_BRAND = "影片對稿";

/** The card's own sentence — what the reviewer is being asked to do. */
export const IMAGE_SHARE_DESCRIPTION = "幫我看一下這張文宣，點需要調整的位置留一句話就可以，不用改原稿。";
export const VIDEO_SHARE_DESCRIPTION = "幫我看一下這支影片，在需要調整的時間點留一句話就可以。";

/** The generic 1200×630 cover, per media type. Served from the app origin. */
export const IMAGE_GENERIC_COVER = "og-cover.png";
export const VIDEO_GENERIC_COVER = "og-video-cover.png";

/**
 * Where the card's picture comes from.
 *
 *   auto   — follow the room: the poster artwork, or a video's poster frame.
 *            Switching version refreshes it.
 *   custom — an image the host uploaded for this card only. A version switch
 *            must NOT overwrite it; that is the whole point of choosing it.
 *   none   — no picture. The platform falls back to the generic brand cover.
 */
export type CoverSource = "auto" | "custom" | "none";

export const COVER_SOURCES: CoverSource[] = ["auto", "custom", "none"];

export function isCoverSource(value: unknown): value is CoverSource {
  return value === "auto" || value === "custom" || value === "none";
}

/* ---------------------------------------------------------- presentation -- */

/**
 * Every user-visible string a share surface needs, already resolved for one
 * media type. A caller picks fields off this; it never branches on mediaType
 * itself, which is what keeps the two modes from drifting apart again.
 */
export type SharePresentation = {
  mediaType: MediaType;
  /** 文宣分享 / 影片分享 — the heading of the customisation block. */
  sectionTitle: string;
  /** 文宣討論區 / 影片對稿 — the product label on a card with no room title. */
  brand: string;
  /** What the card's title starts as: the room's own name. */
  defaultTitle: string;
  /** What the card's description starts as. */
  defaultDescription: string;
  /** 顯示文宣縮圖 / 顯示影片封面 */
  thumbnailLabel: string;
  /** One line of plain-language privacy, for the ON state. */
  privacyCopy: string;
  /** …and for the OFF state. */
  privacyOffCopy: string;
  /** Shown while the preview is still being built and sharing is held back. */
  preparingCopy: string;
  /** The LINE button's own label during that wait. */
  preparingActionCopy: string;
  /** 使用文宣縮圖 / 使用影片封面 — the `auto` radio. */
  coverAutoLabel: string;
  /** Placeholder for the 分享標題 field. */
  titlePlaceholder: string;
  /** The message that travels with the link, in LINE / the OS sheet / clipboard. */
  inviteText: (shareTitle: string) => string;
};

const IMAGE: Omit<SharePresentation, "defaultTitle"> = {
  mediaType: "image",
  sectionTitle: "文宣分享",
  brand: IMAGE_BRAND,
  defaultDescription: IMAGE_SHARE_DESCRIPTION,
  thumbnailLabel: "顯示文宣縮圖",
  privacyCopy: "開啟後，分享平台會看到一張低解析度文宣預覽。",
  privacyOffCopy: `關閉時，分享平台只會看到「${IMAGE_BRAND}」的通用封面。`,
  preparingCopy: "正在準備文宣分享預覽…",
  preparingActionCopy: "正在準備 LINE 預覽…",
  coverAutoLabel: "使用文宣縮圖",
  titlePlaceholder: "例如：期初茶會文宣｜初稿",
  inviteText: (shareTitle) =>
    `幫我看一下這張文宣「${shareTitle}」，點需要調整的位置留一句話就可以，不用改原稿 🙏`,
};

const VIDEO: Omit<SharePresentation, "defaultTitle"> = {
  mediaType: "video",
  sectionTitle: "影片分享",
  brand: VIDEO_BRAND,
  defaultDescription: VIDEO_SHARE_DESCRIPTION,
  thumbnailLabel: "顯示影片封面",
  privacyCopy: "開啟後，分享平台會看到一張影片封面預覽。",
  privacyOffCopy: `關閉時，分享平台只會看到「${VIDEO_BRAND}」的通用封面。`,
  preparingCopy: "正在準備影片分享預覽…",
  preparingActionCopy: "正在準備 LINE 預覽…",
  coverAutoLabel: "使用影片封面",
  titlePlaceholder: "例如：小華招生短片｜第一剪",
  inviteText: (shareTitle) =>
    `幫我看一下這支影片「${shareTitle}」，在需要調整的時間點留一句話就可以 🙏`,
};

/**
 * Resolve every share string for one room.
 *
 * `roomTitle` is only a DEFAULT here. The title that actually travels can be
 * customised per card (see `share_previews.title`), and that customisation must
 * never write back to the room — a room called 未命名影片 can still be shared as
 * 「淡江招生短片｜第一剪」.
 */
export function sharePresentation(mediaType: MediaType, roomTitle: string): SharePresentation {
  const base = mediaType === "video" ? VIDEO : IMAGE;
  return { ...base, defaultTitle: roomTitle.trim() || base.brand };
}

/** The generic cover for a media type, as an absolute URL under `origin`. */
export function genericCoverUrl(origin: string, mediaType: MediaType): string {
  const file = mediaType === "video" ? VIDEO_GENERIC_COVER : IMAGE_GENERIC_COVER;
  return `${origin.replace(/\/+$/, "")}/${file}`;
}
