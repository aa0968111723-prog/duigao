/**
 * Legacy `#room=<6碼>` links predate cloud rooms (PR #12). They can only be
 * opened while the host keeps the page open on PeerJS, so they are never
 * produced as share links any more — but old links live on in LINE threads.
 *
 * When *this* device is the owner it already holds the local→cloud mapping for
 * that room, so the legacy link can be upgraded in place to the real
 * `#room=<uuid>&invite=<token>` URL before the app reads the address bar.
 */
import { isCloudConfigured } from "./config";
import { readRoomLink, replaceUrlWithInvite } from "./invite";
import { getCloudMapping } from "./mapping";

/** Returns true when the URL was rewritten to a cloud invite URL. */
export function upgradeLegacyShareUrl(): boolean {
  if (!isCloudConfigured) return false;
  const link = readRoomLink();
  if (link.kind !== "legacy") return false;
  const mapping = getCloudMapping(link.roomId);
  if (!mapping?.roomId || !mapping.token) return false;
  replaceUrlWithInvite(mapping.roomId, mapping.token);
  return true;
}
