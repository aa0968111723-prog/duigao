import type { Guest, Room } from "./types";

const DB_NAME = "duigao";
const DB_VERSION = 1;
const ROOMS = "rooms";
const GUEST_KEY = "duigao.guest";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROOMS)) {
        db.createObjectStore(ROOMS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
