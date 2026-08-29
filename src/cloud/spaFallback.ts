/**
 * App-origin routing: client routes may fall back to index.html.
 * `/functions`, `/api`, and `/rest` on this origin are not APIs — they must
 * not be rewritten to the SPA (HTTP 200 HTML looks like a successful invoke).
 */

export const APP_ORIGIN_API_PREFIXES = ["/functions", "/api", "/rest"] as const;

export function isAppOriginApiPath(pathname: string): boolean {
  const path = pathname.split("?")[0] || "/";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return APP_ORIGIN_API_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

/** Client-side routes (onboard, room, login) still need the SPA. */
export function shouldSpaFallback(pathname: string): boolean {
  return !isAppOriginApiPath(pathname);
}
