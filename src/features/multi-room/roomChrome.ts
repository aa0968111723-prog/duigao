/**
 * First-layer room chrome (PR-GAP-04).
 *
 * Phone/tablet first screen is 返回 / 房名 / 在線 / 語音 / 更多
 * and 對話／白板 only. Search, 總覽, 內容, 企劃, 檔案, AI, and the add FAB
 * live behind 更多 — never as persistent first-layer tabs.
 */

export const FIRST_LAYER_TOP = ["back", "title", "presence", "voice", "more"] as const;
export const FIRST_LAYER_TABS = ["對話", "白板"] as const;
export const SECONDARY_CHROME = ["總覽", "內容", "企劃", "搜尋", "AI", "新增"] as const;

export const PHONE_WIDTHS = [360, 390, 412] as const;
export const TABLET_WIDTHS = [768, 820] as const;

export type FirstLayerChrome = {
  top: typeof FIRST_LAYER_TOP;
  tabs: typeof FIRST_LAYER_TABS;
  persistentSecondary: string[];
  visibleSecondary: readonly string[];
  tabletSplit: boolean;
  hideRoomChrome: boolean;
};

export function firstLayerChrome(input: {
  moreOpen: boolean;
  width: number;
  composerActive?: boolean;
}): FirstLayerChrome {
  // Phone composer focus (GAP-02 hideRoomChrome) wins over 更多.
  // Tablet (>=768) keeps the more-sheet / split so 768 evidence stays true.
  const hideRoomChrome = Boolean(input.composerActive) && input.width < 768;
  const moreOpen = hideRoomChrome ? false : input.moreOpen;
  const tabletSplit = input.width >= 768 && moreOpen;
  return {
    top: FIRST_LAYER_TOP,
    tabs: FIRST_LAYER_TABS,
    persistentSecondary: [],
    visibleSecondary: moreOpen ? SECONDARY_CHROME : [],
    tabletSplit,
    hideRoomChrome,
  };
}

export function firstLayerHasPersistentSecondary(layer: FirstLayerChrome): boolean {
  return layer.persistentSecondary.some((label) =>
    ["總覽", "內容", "企劃", "檔案", "AI", "搜尋"].includes(label),
  );
}

export function isTabletSplitWidth(width: number): boolean {
  return width >= 768;
}
