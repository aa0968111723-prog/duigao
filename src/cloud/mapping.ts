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

/**
 * Drop the local→cloud mapping for a room this device gave up on.
 *
 * Only used when a room was created for an upload that never completed: keeping
 * the mapping would tie the local id to an empty cloud room forever.
 */
export function clearCloudMapping(localRoomId: string): void {
  try {
    localStorage.removeItem(`${PREFIX}${localRoomId}`);
  } catch {
    /* storage may be unavailable in private mode */
  }
}
