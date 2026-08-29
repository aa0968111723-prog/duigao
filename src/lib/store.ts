import type { DiscussionMessage } from "../features/collaboration/types";
import type { Guest, Room } from "./types";
import type { RoomContextResponse } from "./assetIntelligence";

const DB_NAME = "duigao";
const DB_VERSION = 5;
const ROOMS = "rooms";
const AI_CONTEXTS = "ai-contexts";
const UPLOAD_SESSIONS = "upload-sessions";
const DISCUSSION_OUTBOX = "discussion-outbox";
const DISCUSSION_DRAFTS = "discussion-drafts";
const DISCUSSION_READS = "discussion-reads";
const GUEST_KEY = "duigao.guest";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROOMS)) {
        db.createObjectStore(ROOMS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(AI_CONTEXTS)) {
        db.createObjectStore(AI_CONTEXTS, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(UPLOAD_SESSIONS)) {
        db.createObjectStore(UPLOAD_SESSIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(DISCUSSION_OUTBOX)) {
        db.createObjectStore(DISCUSSION_OUTBOX, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(DISCUSSION_DRAFTS)) {
        db.createObjectStore(DISCUSSION_DRAFTS, { keyPath: "roomKey" });
      }
      if (!db.objectStoreNames.contains(DISCUSSION_READS)) {
        db.createObjectStore(DISCUSSION_READS, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export type VideoUploadSession = {
  id: string;
  roomId: string;
  versionId: string;
  objectName: string;
  uploadUrl?: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  mime: string;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  state: string;
};

export async function saveUploadSession(session: VideoUploadSession): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(UPLOAD_SESSIONS, "readwrite");
      tx.objectStore(UPLOAD_SESSIONS).put({ ...session, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listUploadSessions(): Promise<VideoUploadSession[]> {
  const db = await openDb();
  try {
    return await new Promise<VideoUploadSession[]>((resolve, reject) => {
      const tx = db.transaction(UPLOAD_SESSIONS, "readonly");
      const req = tx.objectStore(UPLOAD_SESSIONS).getAll();
      req.onsuccess = () => resolve((req.result as VideoUploadSession[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function deleteUploadSession(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(UPLOAD_SESSIONS, "readwrite");
      tx.objectStore(UPLOAD_SESSIONS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function uploadSessionMatchesFile(session: VideoUploadSession, file: File): boolean {
  return session.fileName === file.name && session.fileSize === file.size && session.lastModified === file.lastModified;
}

type StoredOutboxRow = {
  id: string;
  message: DiscussionMessage;
  state: "sending" | "failed" | "acked";
  autoRetried?: boolean;
  ownerId?: string;
};

function rowVisibleToOwner(row: StoredOutboxRow, ownerId: string | null): boolean {
  if (!ownerId) return false;
  if (row.ownerId) return row.ownerId === ownerId;
  return row.message?.authorId === ownerId;
}

export async function saveOutboxEntries(
  ownerId: string,
  entries: Record<string, Omit<StoredOutboxRow, "id">>,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DISCUSSION_OUTBOX, "readwrite");
      const store = tx.objectStore(DISCUSSION_OUTBOX);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as StoredOutboxRow[]) ?? [];
        const keep = new Set(Object.keys(entries));
        for (const row of rows) {
          if (!rowVisibleToOwner(row, ownerId)) continue;
          if (!keep.has(row.id)) store.delete(row.id);
        }
        for (const [id, entry] of Object.entries(entries)) {
          store.put({
            id,
            message: entry.message,
            state: entry.state,
            autoRetried: entry.autoRetried,
            ownerId,
          } satisfies StoredOutboxRow);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadOutboxEntries(ownerId: string | null): Promise<Record<string, Omit<StoredOutboxRow, "id">>> {
  if (!ownerId) return {};
  const db = await openDb();
  try {
    const rows = await new Promise<StoredOutboxRow[]>((resolve, reject) => {
      const tx = db.transaction(DISCUSSION_OUTBOX, "readonly");
      const req = tx.objectStore(DISCUSSION_OUTBOX).getAll();
      req.onsuccess = () => resolve((req.result as StoredOutboxRow[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    const entries: Record<string, Omit<StoredOutboxRow, "id">> = {};
    for (const row of rows) {
      if (!row?.id || !row.message) continue;
      if (!rowVisibleToOwner(row, ownerId)) continue;
      entries[row.id] = { message: row.message, state: row.state, autoRetried: row.autoRetried, ownerId: row.ownerId ?? ownerId };
    }
    return entries;
  } finally {
    db.close();
  }
}

export async function saveDiscussionDraft(roomKey: string, body: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DISCUSSION_DRAFTS, "readwrite");
      if (body.trim()) {
        tx.objectStore(DISCUSSION_DRAFTS).put({ roomKey, body, updatedAt: Date.now() });
      } else {
        tx.objectStore(DISCUSSION_DRAFTS).delete(roomKey);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export type StoredDiscussionRead = {
  key: string;
  roomId: string;
  userId: string;
  lastReadMessageId?: string;
  lastReadAt: number;
};

function discussionReadKey(roomId: string, userId: string): string {
  return `${roomId}:${userId}`;
}

export async function saveDiscussionRead(entry: Omit<StoredDiscussionRead, "key">): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(DISCUSSION_READS, "readwrite");
      tx.objectStore(DISCUSSION_READS).put({
        key: discussionReadKey(entry.roomId, entry.userId),
        ...entry,
      } satisfies StoredDiscussionRead);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadDiscussionReadLocal(roomId: string, userId: string): Promise<StoredDiscussionRead | null> {
  const db = await openDb();
  try {
    return await new Promise<StoredDiscussionRead | null>((resolve, reject) => {
      const tx = db.transaction(DISCUSSION_READS, "readonly");
      const req = tx.objectStore(DISCUSSION_READS).get(discussionReadKey(roomId, userId));
      req.onsuccess = () => resolve((req.result as StoredDiscussionRead | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function loadDiscussionDraft(roomKey: string): Promise<string> {
  const db = await openDb();
  try {
    const row = await new Promise<{ roomKey: string; body: string } | undefined>((resolve, reject) => {
      const tx = db.transaction(DISCUSSION_DRAFTS, "readonly");
      const req = tx.objectStore(DISCUSSION_DRAFTS).get(roomKey);
      req.onsuccess = () => resolve(req.result as { roomKey: string; body: string } | undefined);
      req.onerror = () => reject(req.error);
    });
    return typeof row?.body === "string" ? row.body : "";
  } finally {
    db.close();
  }
}

type CachedAiContext = { key: string; response: RoomContextResponse; savedAt: number };

/** Cache bounded, permission-filtered answers only; never cache binaries or secrets. */
export async function saveAiContext(key: string, response: RoomContextResponse): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AI_CONTEXTS, "readwrite");
      tx.objectStore(AI_CONTEXTS).put({ key, response, savedAt: Date.now() } satisfies CachedAiContext);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadAiContext(key: string, maxAgeMs = 5 * 60_000): Promise<RoomContextResponse | undefined> {
  const db = await openDb();
  try {
    const value = await new Promise<CachedAiContext | undefined>((resolve, reject) => {
      const tx = db.transaction(AI_CONTEXTS, "readonly");
      const req = tx.objectStore(AI_CONTEXTS).get(key);
      req.onsuccess = () => resolve(req.result as CachedAiContext | undefined);
      req.onerror = () => reject(req.error);
    });
    if (!value || Date.now() - value.savedAt > maxAgeMs) return undefined;
    return value.response;
  } finally {
    db.close();
  }
}

export async function deleteAiContext(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AI_CONTEXTS, "readwrite");
      tx.objectStore(AI_CONTEXTS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function saveRoom(room: Room): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROOMS, "readwrite");
      tx.objectStore(ROOMS).put(room);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadRoom(id: string): Promise<Room | undefined> {
  const db = await openDb();
  try {
    return await new Promise<Room | undefined>((resolve, reject) => {
      const tx = db.transaction(ROOMS, "readonly");
      const req = tx.objectStore(ROOMS).get(id);
      req.onsuccess = () => resolve(req.result as Room | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Drop a cached room.
 *
 * Used when a room is abandoned before it ever held anything — an empty video
 * room left in the cache would show up in 最近討論 as a room that cannot be
 * opened, because there is nothing in it to open.
 */
export async function deleteRoom(id: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ROOMS, "readwrite");
      tx.objectStore(ROOMS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listRooms(): Promise<Room[]> {
  const db = await openDb();
  try {
    const rooms = await new Promise<Room[]>((resolve, reject) => {
      const tx = db.transaction(ROOMS, "readonly");
      const req = tx.objectStore(ROOMS).getAll();
      req.onsuccess = () => resolve((req.result as Room[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    return rooms.sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    db.close();
  }
}

export function loadGuest(): Guest | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    return raw ? (JSON.parse(raw) as Guest) : null;
  } catch {
    return null;
  }
}

export function saveGuest(guest: Guest): void {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(guest));
  } catch {
    /* storage may be unavailable in private mode */
  }
}

const FLAG_PREFIX = "duigao.flag.";

export function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(FLAG_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

export function saveFlag(key: string): void {
  try {
    localStorage.setItem(FLAG_PREFIX + key, "1");
  } catch {
    /* storage may be unavailable in private mode */
  }
}
