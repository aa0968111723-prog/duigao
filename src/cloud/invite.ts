/**
 * Invite tokens are high-entropy secrets generated with the Web Crypto API.
 * The raw token lives only in the share URL and the client; the database stores
 * only its sha256 hash (computed server-side in the join/create RPCs).
 */

import { uuid } from "../lib/id";

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
  // 不是秘密（秘密是上面那個 token，走 getRandomValues），所以舊瀏覽器沒有
  // crypto.randomUUID 時退回 uuid() 是安全的 — 但「拿不到 id 就整條建房
  // 靜靜失敗」不是。
  return uuid();
}

/**
 * The one and only share-URL builder. A shareable link always carries an
 * invite token — a bare `#room=<id>` is never produced anywhere in the app
 * (PR #16); it only survives as an inbound legacy format.
 */
export type RoomTarget = { branchId?: string; versionId?: string; whiteboardId?: string; nodeId?: string };

/**
 * Build the only share URL shape the app emits. Content targeting deliberately
 * stays in the fragment with the invite: fragments never reach servers,
 * previews, access logs, or referrers.
 */
export function buildInviteUrl(roomId: string, token: string, target?: RoomTarget): string {
  const params = new URLSearchParams({ room: roomId, invite: token });
  if (target?.branchId) params.set("branch", target.branchId);
  if (target?.versionId) params.set("item", target.versionId);
  if (target?.whiteboardId) params.set("board", target.whiteboardId);
  if (target?.nodeId) params.set("node", target.nodeId);
  return `${location.origin}${location.pathname}#${params.toString()}`;
}

/** Add a branch/version target without moving any share data into the query. */
export function addRoomTarget(url: string, target?: RoomTarget): string {
  if (!target?.branchId && !target?.versionId && !target?.whiteboardId && !target?.nodeId) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const currentHash = hashAt >= 0 ? url.slice(hashAt + 1) : "";
  const params = new URLSearchParams(currentHash);
  if (target.branchId) params.set("branch", target.branchId);
  if (target.versionId) params.set("item", target.versionId);
  if (target.whiteboardId) params.set("board", target.whiteboardId);
  if (target.nodeId) params.set("node", target.nodeId);
  return `${base}#${params.toString()}`;
}

export type UrlInvite = { roomId: string; invite: string | null; branchId?: string; versionId?: string; whiteboardId?: string; nodeId?: string };

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
  const branch = /[#&]branch=([^&]+)/i.exec(inviteSource);
  const item = /[#&]item=([^&]+)/i.exec(inviteSource);
  const board = /[#&]board=([^&]+)/i.exec(inviteSource);
  const node = /[#&]node=([^&]+)/i.exec(inviteSource);
  return {
    roomId: decodeURIComponent(room[1]),
    invite: invite ? decodeURIComponent(invite[1]) : null,
    branchId: branch ? decodeURIComponent(branch[1]) : undefined,
    versionId: item ? decodeURIComponent(item[1]) : undefined,
    whiteboardId: board ? decodeURIComponent(board[1]) : undefined,
    nodeId: node ? decodeURIComponent(node[1]) : undefined,
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
  | { kind: "cloud"; roomId: string; invite: string; branchId?: string; versionId?: string; whiteboardId?: string; nodeId?: string }
  | { kind: "legacy"; roomId: string };

export function readRoomLink(): RoomLink {
  const url = readInviteFromUrl();
  if (!url) return { kind: "none" };
  if (url.invite) {
    return {
      kind: "cloud",
      roomId: url.roomId,
      invite: url.invite,
      branchId: url.branchId,
      versionId: url.versionId,
      whiteboardId: url.whiteboardId,
      nodeId: url.nodeId,
    };
  }
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
