/**
 * Remembers which local (IndexedDB) room has already been migrated to a cloud
 * room, so re-opening it reconnects instead of creating a duplicate. Also keeps
 * the raw invite token for the owner so re-sharing yields the same link.
 */
export type CloudMapping = { roomId: string; token: string };

const PREFIX = "duigao.cloudmap.";

export function getCloudMapping(localRoomId: string): CloudMapping | null {
  try {
    const raw = localStorage.getItem(PREFIX + localRoomId);
    return raw ? (JSON.parse(raw) as CloudMapping) : null;
  } catch {
    return null;
  }
}

export function saveCloudMapping(localRoomId: string, mapping: CloudMapping): void {
  try {
    localStorage.setItem(PREFIX + localRoomId, JSON.stringify(mapping));
  } catch {
    /* storage may be unavailable */
  }
}
