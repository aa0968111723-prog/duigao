import type { Room, Version } from "./types";

/**
 * Cloud mirror for rooms.
 *
 * Peer-to-peer alone means a partner can only open a shared link while the host
 * device is awake with the page open — on phones that is almost never true. So
 * every room is also mirrored to Supabase: posters go to storage, the rest of
 * the room to a `rooms` row reached through SECURITY DEFINER functions that
 * always require the room code, so the table is never listable.
 *
 * The mirror is best-effort. If it is unreachable the app keeps working exactly
 * as before, on IndexedDB plus PeerJS.
 */
const URL_BASE =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "https://uanurolzzgshxrqbooix.supabase.co";
const API_KEY =
  (import.meta.env.VITE_SUPABASE_KEY as string | undefined) ?? "sb_publishable_qbR0-Ogr5EIQiTMsTI5niA_ffWl33Gz";

const BUCKET = "posters";
/** Matches the server-side guard in save_room. */
const MAX_PAYLOAD = 1_800_000;

export const cloudEnabled = Boolean(URL_BASE && API_KEY);

/** The poster to render: the cloud copy when we have one, else the local blob. */
export function posterSrc(version: Version): string {
  return version.imageUrl || version.imageDataUrl;
}

function jsonHeaders(): HeadersInit {
  return {
    apikey: API_KEY,
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const [, type, base64, payload] = match;
  try {
    if (!base64) return new Blob([decodeURIComponent(payload)], { type });
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

async function uploadPoster(roomId: string, version: Version): Promise<string | null> {
  const blob = dataUrlToBlob(version.imageDataUrl);
  const ext = blob && EXTENSIONS[blob.type];
  if (!blob || !ext) return null; // e.g. SVG, which the bucket does not accept
  const path = `${roomId}/${version.id}.${ext}`;
  try {
    const res = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: {
        apikey: API_KEY,
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": blob.type,
        "x-upsert": "true",
      },
      body: blob,
    });
    if (!res.ok) return null;
    return `${URL_BASE}/storage/v1/object/public/${BUCKET}/${path}`;
  } catch {
    return null;
  }
}

/** Strips the inline blob from versions that already live in storage. */
function toCloudShape(room: Room): Room {
  return {
    ...room,
    versions: room.versions.map((v) => (v.imageUrl ? { ...v, imageDataUrl: "" } : v)),
  };
}

/**
 * Uploads any posters that are not in storage yet and saves the room. Returns
 * the room with the storage URLs filled in so the caller can keep them locally,
 * or null when the mirror could not be updated.
 */
export async function publishRoom(room: Room): Promise<Room | null> {
  if (!cloudEnabled) return null;
  const versions: Version[] = [];
  for (const version of room.versions) {
    if (version.imageUrl) {
      versions.push(version);
      continue;
    }
    const imageUrl = await uploadPoster(room.id, version);
    versions.push(imageUrl ? { ...version, imageUrl } : version);
  }

  const withUrls: Room = { ...room, versions };
  const payload = toCloudShape(withUrls);
  if (JSON.stringify(payload).length > MAX_PAYLOAD) return null;

  try {
    const res = await fetch(`${URL_BASE}/rest/v1/rpc/save_room`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ room_id: room.id, room_data: payload }),
    });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  return withUrls;
}

export async function fetchRoom(id: string): Promise<Room | null> {
  if (!cloudEnabled) return null;
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/rpc/get_room`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ room_id: id }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Room | null;
    if (!data || !Array.isArray(data.versions)) return null;
    return data;
  } catch {
    return null;
  }
}

function mergeById<T extends { id: string }>(mine: T[], theirs: T[], preferTheirs: boolean): T[] {
  const out = new Map<string, T>();
  for (const item of preferTheirs ? mine : theirs) out.set(item.id, item);
  for (const item of preferTheirs ? theirs : mine) out.set(item.id, item);
  const order = [...mine, ...theirs];
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of order) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const value = out.get(item.id);
    if (value) merged.push(value);
  }
  return merged;
}

/**
 * Union of two copies of the same room. Two people can both add notes while
 * offline, so entries are merged by id rather than the newer copy winning
 * outright; only per-entry state (like resolved) follows the newer copy.
 */
export function mergeRooms(mine: Room, theirs: Room): Room {
  const theirsIsNewer = (theirs.updatedAt ?? 0) > (mine.updatedAt ?? 0);
  const versions = mergeById(mine.versions, theirs.versions, false).map((v) => {
    const local = mine.versions.find((x) => x.id === v.id);
    const remote = theirs.versions.find((x) => x.id === v.id);
    return {
      ...v,
      // Keep whichever source actually carries the pixels.
      imageDataUrl: local?.imageDataUrl || remote?.imageDataUrl || "",
      imageUrl: local?.imageUrl || remote?.imageUrl,
    };
  });

  return {
    ...(theirsIsNewer ? theirs : mine),
    versions,
    comments: mergeById(mine.comments, theirs.comments, theirsIsNewer),
    strokes: mergeById(mine.strokes, theirs.strokes, theirsIsNewer),
    messages: mergeById(mine.messages, theirs.messages, theirsIsNewer),
    updatedAt: Math.max(mine.updatedAt ?? 0, theirs.updatedAt ?? 0),
  };
}
