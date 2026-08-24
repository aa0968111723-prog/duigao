/**
 * Invite tokens are high-entropy secrets generated with the Web Crypto API.
 * The raw token lives only in the share URL and the client; the database stores
 * only its sha256 hash (computed server-side in the join/create RPCs).
 */

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateInviteToken(): string {
  const bytes = new Uint8Array(24); // 192 bits
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export function newRoomId(): string {
  return crypto.randomUUID();
}

/**
 * The one and only share-URL builder. A shareable link always carries an
 * invite token — a bare `#room=<id>` is never produced anywhere in the app
 * (PR #16); it only survives as an inbound legacy format.
 */
export function buildInviteUrl(roomId: string, token: string): string {
  return `${location.origin}${location.pathname}#room=${encodeURIComponent(roomId)}&invite=${encodeURIComponent(token)}`;
}

export type UrlInvite = { roomId: string; invite: string | null };

/** Parse `#room=<id>&invite=<secret>` (or legacy `#room=<code>`). */
export function readInviteFromUrl(): UrlInvite | null {
  // Legacy room ids may still arrive in either place, but capability secrets
  // are parsed from the fragment only. Queries reach servers and referrers;
  // fragments do not.
  const roomSource = location.hash + location.search;
  const inviteSource = location.hash;
  const room = /[#?&]room=([^&]+)/i.exec(roomSource);
  if (!room) return null;
  const invite = /[#&]invite=([^&]+)/i.exec(inviteSource);
  return {
    roomId: decodeURIComponent(room[1]),
    invite: invite ? decodeURIComponent(invite[1]) : null,
  };
}

/**
 * What kind of link the app was opened with.
 *
 * - `none`   — no room in the URL: this device is starting/opening its own room
 * - `cloud`  — `#room=<uuid>&invite=<token>`: works with the host offline
 * - `legacy` — `#room=<6碼>`: predates cloud rooms, only works while the host
 *              is online on PeerJS. Kept readable for compatibility, never
 *              generated or offered as a share link again.
 */
export type RoomLink =
  | { kind: "none" }
  | { kind: "cloud"; roomId: string; invite: string }
  | { kind: "legacy"; roomId: string };

export function readRoomLink(): RoomLink {
  const url = readInviteFromUrl();
  if (!url) return { kind: "none" };
  if (url.invite) return { kind: "cloud", roomId: url.roomId, invite: url.invite };
  return { kind: "legacy", roomId: url.roomId };
}

/**
 * Swap the address bar over to a cloud invite URL without a reload, so a
 * legacy link the owner still has bookmarked (or in a LINE thread) upgrades
 * itself and every later re-share carries the invite token.
 */
export function replaceUrlWithInvite(roomId: string, token: string): void {
  const next = buildInviteUrl(roomId, token);
  if (location.href === next) return;
  try {
    history.replaceState(null, "", next);
  } catch {
    /* some in-app browsers restrict history; the app still works via state */
  }
}
