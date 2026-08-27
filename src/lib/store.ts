import type { Guest, Room } from "./types";
import type { RoomContextResponse } from "./assetIntelligence";

const DB_NAME = "duigao";
const DB_VERSION = 2;
const ROOMS = "rooms";
const AI_CONTEXTS = "ai-contexts";
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
