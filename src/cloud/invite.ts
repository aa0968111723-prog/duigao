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

export function buildInviteUrl(roomId: string, token: string): string {
  return `${location.origin}${location.pathname}#room=${roomId}&invite=${token}`;
}

export type UrlInvite = { roomId: string; invite: string | null };

/** Parse `#room=<id>&invite=<secret>` (or legacy `#room=<code>`). */
export function readInviteFromUrl(): UrlInvite | null {
  const source = location.hash + location.search;
  const room = /[#?&]room=([^&]+)/i.exec(source);
  if (!room) return null;
  const invite = /[#?&]invite=([^&]+)/i.exec(source);
  return {
    roomId: decodeURIComponent(room[1]),
    invite: invite ? decodeURIComponent(invite[1]) : null,
  };
}
