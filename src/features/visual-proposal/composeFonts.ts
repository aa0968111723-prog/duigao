/**
 * Compose-layer Traditional Chinese webfonts.
 * FONT_STYLES chips write these family names; the stylesheet actually loads them.
 */
export const COMPOSE_FONTS_STYLESHEET =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;700;800;900&family=Noto+Serif+TC:wght@600&family=Iansui&display=swap";

export type ComposeFontFace = {
  key: string;
  family: string;
  weight: number;
  /** Stylesheet that contains @font-face src for this family. */
  href: string;
  src: string;
};

export const COMPOSE_FONT_FACES: ComposeFontFace[] = [
  { key: "modern", family: "Noto Sans TC", weight: 700, href: COMPOSE_FONTS_STYLESHEET, src: COMPOSE_FONTS_STYLESHEET },
  { key: "solid", family: "Noto Sans TC", weight: 900, href: COMPOSE_FONTS_STYLESHEET, src: COMPOSE_FONTS_STYLESHEET },
  { key: "soft", family: "Noto Sans TC", weight: 400, href: COMPOSE_FONTS_STYLESHEET, src: COMPOSE_FONTS_STYLESHEET },
  { key: "lively", family: "Noto Sans TC", weight: 800, href: COMPOSE_FONTS_STYLESHEET, src: COMPOSE_FONTS_STYLESHEET },
  { key: "serif", family: "Noto Serif TC", weight: 600, href: COMPOSE_FONTS_STYLESHEET, src: COMPOSE_FONTS_STYLESHEET },
  // Iansui（芫荽）— OFL 繁中手寫，不是系統楷體碰運氣。
  { key: "hand", family: "Iansui", weight: 400, href: COMPOSE_FONTS_STYLESHEET, src: COMPOSE_FONTS_STYLESHEET },
];

export function composeFontFace(key: string): ComposeFontFace {
  return COMPOSE_FONT_FACES.find((face) => face.key === key) ?? COMPOSE_FONT_FACES[0];
}

export function composeFontStack(key: string): string {
  const face = composeFontFace(key);
  const fallback = key === "serif" || key === "hand" ? "serif" : "sans-serif";
  return `"${face.family}", "Noto Sans TC", ${fallback}`;
}

/** Inject the compose webfont stylesheet once. Safe to call from overlay/dock. */
export function ensureComposeFonts(doc: Document = document): void {
  if (doc.head.querySelector("link[data-compose-fonts='true']")) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = COMPOSE_FONTS_STYLESHEET;
  link.setAttribute("data-compose-fonts", "true");
  doc.head.appendChild(link);
}
