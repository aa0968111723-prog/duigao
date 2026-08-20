import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLORS,
  VERSION_LABELS,
  VIDEO_VERSION_LABELS,
  roomMediaType,
  type AnnotationRegion,
  type ChatMessage,
  type CommentPin,
  type CommentReply,
  type Guest,
  type Point,
  type Room,
  type Stroke,
  type MediaType,
  type Tool,
  type Version,
  type VideoAnchor,
  type ViewState,
} from "./lib/types";
import { regionCenter } from "./lib/region";
import { roomCode, uid } from "./lib/id";
import { deleteRoom, listRooms, loadFlag, loadGuest, loadRoom, saveFlag, saveGuest, saveRoom } from "./lib/store";
import { Collab, type CollabStatus } from "./lib/peer";
import { isCloudConfigured } from "./cloud/config";
import { readRoomLink } from "./cloud/invite";
import { type SyncStatus } from "./cloud/types";
import { useCloudRoom } from "./cloud/useCloudRoom";
import { buildPreviewShareUrl, previewThumbnailUrl, type SharePreview } from "./cloud/sharePreview";
import { ToastStack, useToasts } from "./toast";
import { useIsMobile } from "./hooks/useIsMobile";
import { RoomWorkspace } from "./components/RoomWorkspace";
import { Home } from "./components/Home";
import { UploadZone } from "./components/UploadZone";
import { ShareSheet, type ShareState } from "./components/ShareSheet";
import {
  nextPinNumber,
  pinNumber,
  type PinDraft,
  type PinForm,
  type SaveState,
  type VideoApi,
  type VideoUploadState,
  type WorkspaceApi,
} from "./components/api";
import { VIDEO_ACCEPT, acceptVideoFile } from "./features/video-review/media";
import { anchorLabel, anchorStart } from "./features/video-review/anchors";
import { isUploadCancelled } from "./cloud/videoRoom";
import "./usability.css";

const EMPTY_FORM: PinForm = { body: "", suggestion: "", type: "文字", priority: "一般" };
const COACH_FLAG = "coach.firstPin";
const UNDO_LIMIT = 20;

function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

/** Distinguishes "the user cancelled" from a genuine upload failure. */
class CancelledUpload extends Error {}

/**
 * What to actually show someone when an upload fails.
 *
 * Backend text — PostgREST, Storage, Postgres constraint names, RLS wording —
 * is English, leaks schema details and never says what to do next, so it is not
 * copy. The messages this app authors are Traditional Chinese, and that is the
 * test: anything without a Han character came from a machine, not from us.
 */
function userFacingMessage(err: unknown): string {
  const fallback = "影片上傳失敗，請檢查網路後再試一次。";
  const raw = err instanceof Error ? err.message : "";
  if (!raw || raw === "cloud-room-failed") return fallback;
  if (!/[一-鿿]/.test(raw)) {
    // Keep the real reason where a developer can find it; show a sentence the
    // person can act on.
    console.warn("[video] upload failed:", raw);
    return fallback;
  }
  return raw;
}

function emptyRoom(id: string, title: string, mediaType: MediaType = "image"): Room {
  return {
    id,
    title,
    mediaType,
    versions: [],
    comments: [],
    strokes: [],
    messages: [],
    updatedAt: Date.now(),
  };
}

function initialView(room: Room | null): ViewState {
  const first = room?.versions[0]?.id ?? "";
  const second = room?.versions[1]?.id ?? first;
  return { versionId: first, compareId: second, colorMode: "color", compareMode: "single", split: 0.5, wipe: 0.5 };
}

/** Map cloud sync state onto the small presence dot the mobile UI already shows. */
function syncToPresence(status: SyncStatus): CollabStatus | null {
  if (status === "synced") return "online";
  if (status === "connecting" || status === "syncing") return "connecting";
  if (status === "offline-pending" || status === "error") return "error";
  return null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function App() {
  const [guest, setGuest] = useState<Guest | null>(() => loadGuest());
  const [nameInput, setNameInput] = useState("");
  const [room, setRoom] = useState<Room | null>(null);
  const [view, setView] = useState<ViewState>(() => initialView(null));
  const [tool, setTool] = useState<Tool>("pan");
  const [recent, setRecent] = useState<Room[]>([]);
  const [draftPin, setDraftPin] = useState<PinDraft | null>(null);
  const [form, setFormState] = useState<PinForm>(EMPTY_FORM);
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [previewStrokeId, setPreviewStrokeId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [collabStatus, setCollabStatus] = useState<CollabStatus | null>(null);
  const [peerCount, setPeerCount] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [coachSeen, setCoachSeen] = useState<boolean>(() => loadFlag(COACH_FLAG));
  const [undoCount, setUndoCount] = useState(0);
  const [videoUpload, setVideoUpload] = useState<VideoUploadState>({ state: "idle" });
  /** Cancels an upload in flight. Held in a ref so leaving the room can call it. */
  const videoCancelRef = useRef<(() => void) | null>(null);

  const { toasts, showToast, dismiss } = useToasts();
  const isMobile = useIsMobile();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const collabRef = useRef<Collab | null>(null);
  const roomRef = useRef<Room | null>(null);
  const viewRef = useRef<ViewState>(view);
  const saveSeq = useRef(0);
  const busy = useRef<Set<string>>(new Set());
  const offlineNotified = useRef(false);
  const undoStack = useRef<Room[]>([]);
  roomRef.current = room;
  viewRef.current = view;

  /**
   * How this tab was opened. Read once: `main.tsx` has already upgraded a
   * legacy owner link to its cloud invite URL before the first render.
   */
  const roomLink = useMemo(() => readRoomLink(), []);
  const isGuestSession = roomLink.kind !== "none";
  /** An old `#room=<6碼>` link this device cannot upgrade (a partner's phone). */
  const isLegacyLink = roomLink.kind === "legacy";
  /** Cloud drives this session; a legacy link can only ride the peer channel. */
  const cloudSession = isCloudConfigured && !isLegacyLink;

  const markCoachSeen = useCallback(() => {
    setCoachSeen((seen) => {
      if (!seen) saveFlag(COACH_FLAG);
      return true;
    });
  }, []);

  const clearUndo = useCallback(() => {
    undoStack.current = [];
    setUndoCount(0);
  }, []);

  const pushUndo = useCallback((snapshot: Room) => {
    undoStack.current.push(snapshot);
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    setUndoCount(undoStack.current.length);
  }, []);

  /**
   * Guards against a double tap producing two entries. The key carries the
   * payload's identity, so a genuinely different pin or message right after is
   * never swallowed — only a repeat of the same one is.
   */
  const claim = useCallback((key: string, ms = 450) => {
    if (busy.current.has(key)) return false;
    busy.current.add(key);
    window.setTimeout(() => busy.current.delete(key), ms);
    return true;
  }, []);

  const trackSave = useCallback(
    (next: Room) => {
      const seq = ++saveSeq.current;
      setSaveState("saving");
      saveRoom(next)
        .then(() => {
          if (seq === saveSeq.current) setSaveState("saved");
        })
        .catch(() => {
          if (seq !== saveSeq.current) return;
          setSaveState("error");
          showToast("儲存失敗，請再試一次", {
            tone: "error",
            action: { label: "重試", onClick: () => trackSave(roomRef.current ?? next) },
          });
        });
    },
    [showToast],
  );

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = window.setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
    return () => clearTimeout(timer);
  }, [saveState]);

  useEffect(() => {
    listRooms().then(setRecent).catch(() => setRecent([]));
  }, [room]);

  const applyRemoteRoom = useCallback((next: Room) => {
    setRoom(next);
    setView((v) => {
      const ids = next.versions.map((x) => x.id);
      const versionId = ids.includes(v.versionId) ? v.versionId : ids[0] ?? "";
      const compareId = ids.includes(v.compareId) ? v.compareId : versionId;
      return { ...v, versionId, compareId };
    });
  }, []);

  // Cloud persistence (only active when VITE_SUPABASE_* are set). Inert in
  // local-only mode, so the IndexedDB + PeerJS path below is unchanged.
  const cloud = useCloudRoom({ guest, room, isGuestSession, onSnapshot: applyRemoteRoom, showToast });
  const cloudRef = useRef(cloud);
  cloudRef.current = cloud;

  // Cache-first load for cloud guests: a room seen before renders instantly
  // from IndexedDB while auth + join + the fresh cloud snapshot catch up.
  useEffect(() => {
    if (!guest || !isCloudConfigured || roomLink.kind !== "cloud") return;
    loadRoom(roomLink.roomId).then((cached) => {
      if (cached && !roomRef.current) applyRemoteRoom(cached);
    });
  }, [guest, roomLink, applyRemoteRoom]);

  useEffect(() => {
    if (!guest) return;
    // Cloud is the source of truth when configured; PeerJS stays for local
    // mode and for legacy #room=<code> links that carry no invite token.
    if (isCloudConfigured && roomLink.kind === "cloud") return;
    const code = roomLink.kind === "none" ? null : roomLink.roomId;
    if (!code) return;

    loadRoom(code).then((existing) => {
      if (existing) applyRemoteRoom(existing);
    });

    const collab = new Collab("guest", code, {
      onStatus: (status) => {
        setCollabStatus(status);
        setPeerCount(collab.peerCount);
        if ((status === "error" || status === "closed") && !offlineNotified.current) {
          offlineNotified.current = true;
          showToast("目前離線，內容已保存在這台裝置。");
        }
        if (status === "online") offlineNotified.current = false;
      },
      onMessage: (msg) => {
        if (msg.t === "snapshot") {
          applyRemoteRoom(msg.room);
          setView(msg.view);
          saveRoom(msg.room).catch(() => undefined);
        } else if (msg.t === "room") {
          applyRemoteRoom(msg.room);
          saveRoom(msg.room).catch(() => undefined);
        } else if (msg.t === "view") {
          setView(msg.view);
        }
      },
      onOpenConn: (conn) => collab.sendTo(conn, { t: "hello", guest }),
    });
    collab.connect();
    collabRef.current = collab;
    return () => {
      collab.destroy();
      collabRef.current = null;
    };
  }, [guest, roomLink, applyRemoteRoom, showToast]);

  const persist = useCallback(
    (next: Room) => {
      trackSave(next);
      collabRef.current?.send({ t: "room", room: next });
    },
    [trackSave],
  );

  const updateRoom = useCallback(
    (mutate: (r: Room) => Room) => {
      setRoom((prev) => {
        if (!prev) return prev;
        const next = { ...mutate(prev), updatedAt: Date.now() };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const undoLast = useCallback(() => {
    const previous = undoStack.current.pop();
    setUndoCount(undoStack.current.length);
    if (!previous) {
      showToast("沒有可以復原的操作");
      return;
    }
    setRoom(previous);
    persist(previous);
    setSelectedPinId(null);
    setDraftPin(null);
    showToast("已復原", { tone: "success" });
  }, [persist, showToast]);

  /** Apply a change and offer a few-second Undo; history also remains in More. */
  const mutateWithUndo = useCallback(
    (mutate: (r: Room) => Room, toastMessage: string) => {
      const snapshot = roomRef.current;
      if (!snapshot) return;
      pushUndo(snapshot);
      const next = { ...mutate(snapshot), updatedAt: Date.now() };
      setRoom(next);
      persist(next);
      showToast(toastMessage, {
        action: { label: "復原", onClick: undoLast },
      });
    },
    [persist, pushUndo, showToast, undoLast],
  );

  const updateView = useCallback((next: ViewState) => {
    setView(next);
    collabRef.current?.send({ t: "view", view: next });
  }, []);

  const confirmName = () => {
    const name = nameInput.trim();
    if (!name) return;
    const g: Guest = { id: uid("g_"), name, color: pickColor() };
    saveGuest(g);
    setGuest(g);
  };

  const openRoom = useCallback(
    (r: Room) => {
      clearUndo();
      // An upload state belongs to the room it was started in; carrying it over
      // would show another room a red banner about something that never
      // happened there.
      setVideoUpload({ state: "idle" });
      setRoom(r);
      setView(initialView(r));
    },
    [clearUndo],
  );

  const addImageFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (busy.current.has("upload")) return;
      busy.current.add("upload");
      try {
        const current = roomRef.current ?? emptyRoom(roomCode(), "未命名文宣");
        const created = !roomRef.current;
        const newVersions: Version[] = [];
        for (const file of Array.from(files)) {
          if (!file.type.startsWith("image/")) continue;
          const dataUrl = await fileToDataUrl(file);
          const idx = current.versions.length + newVersions.length;
          newVersions.push({ id: uid("v_"), label: VERSION_LABELS[idx] ?? `改${idx}`, imageDataUrl: dataUrl });
        }
        if (newVersions.length === 0) {
          showToast("這個檔案不是圖片，換一張文宣試試。", { tone: "error" });
          return;
        }
        if (!created) pushUndo(current);
        const next: Room = { ...current, versions: [...current.versions, ...newVersions], updatedAt: Date.now() };
        setRoom(next);
        setView((v) => {
          if (created || !v.versionId) return initialView(next);
          if (v.compareId === v.versionId && next.versions.length >= 2) {
            const other = next.versions.find((x) => x.id !== v.versionId);
            if (other) return { ...v, compareId: other.id };
          }
          return v;
        });
        persist(next);
        newVersions.forEach((v, i) =>
          cloudRef.current.writes.addVersion(v.label, current.versions.length + i, v.imageDataUrl),
        );
        const added = newVersions[newVersions.length - 1];
        if (!created) {
          showToast(newVersions.length > 1 ? `已新增 ${newVersions.length} 版` : `已新增${added.label}`, {
            tone: "success",
            action: { label: "復原", onClick: undoLast },
          });
        }
      } finally {
        busy.current.delete("upload");
      }
    },
    [persist, pushUndo, showToast, undoLast],
  );

  /**
   * Add one cut to a video room, creating the room in the cloud first if this is
   * the first one.
   *
   * A poster room can live entirely on this device until someone taps 分享. A
   * video room cannot: Storage authorises an upload against `rooms/<room-id>/…`
   * and room membership, so the room has to exist in the cloud before the first
   * byte moves — which is also what makes the share link work after the host
   * closes the page, the whole point of the feature.
   */
  const addVideoFile = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      if (busy.current.has("upload")) return;

      const check = acceptVideoFile(file);
      if (!check.ok) {
        showToast(check.reason, { tone: "error" });
        return;
      }
      if (!isCloudConfigured) {
        showToast("影片對稿需要雲端設定，這台裝置目前是本機模式。", { tone: "error" });
        return;
      }

      // A guest whose join is still in flight has no bound room yet. Uploading
      // would fall through to "create a room", which for a room that already
      // holds a cut is refused with a sentence about migration — true, and
      // completely beside the point for the person waiting three seconds.
      if (isGuestSession && !cloudRef.current.boundRoomId && (roomRef.current?.versions.length ?? 0) > 0) {
        showToast("還在連線，等一下再試一次。");
        return;
      }

      busy.current.add("upload");
      const existing = roomRef.current;
      const isNewRoom = !existing;
      const base = existing ?? emptyRoom(roomCode(), "未命名影片", "video");
      if (isNewRoom) {
        setRoom(base);
        setView(initialView(base));
      }

      const versionId = crypto.randomUUID();
      const index = base.versions.length;
      const label = VIDEO_VERSION_LABELS[index] ?? `改${index}`;
      // Cancelling has to work from the first frame, not only once the XHR
      // exists: the cloud room is created first, and that takes a moment on a
      // slow connection.
      let abandoned = false;
      // Both ids the room may answer to while this upload is in flight; the
      // cloud id joins once the room exists (binding re-keys the room to it).
      const belongsToThisUpload = new Set([base.id]);
      let handleCancel: (() => void) | null = null;
      const cancel = () => {
        abandoned = true;
        handleCancel?.();
        setVideoUpload({ state: "idle" });
      };
      videoCancelRef.current = cancel;
      setVideoUpload({ state: "preparing", progress: 0, cancel });

      try {
        const cloudRoom = await cloudRef.current.ensureCloudRoom(base);
        if (!cloudRoom) throw new Error("cloud-room-failed");
        if (abandoned) throw new CancelledUpload();
        // Binding to the cloud swaps the room's identity from the local code to
        // the cloud UUID (the snapshot that lands next IS the room). Both ids
        // therefore mean "still the room this upload belongs to".
        belongsToThisUpload.add(cloudRoom.roomId);

        const handle = cloudRef.current.uploadVideo(
          {
            roomId: cloudRoom.roomId,
            versionId,
            label,
            sortOrder: index,
            file: check.file,
            mime: check.mime,
            roomTitle: base.title,
          },
          (phase, progress) => setVideoUpload({ state: phase, progress, cancel }),
        );
        if (!handle) throw new Error("cloud-room-failed");
        handleCancel = handle.cancel;

        const version = await handle.done;
        setVideoUpload({ state: "idle" });
        if (abandoned) {
          // Cancelled while the row was being written: the cut is in the cloud
          // and will be there next time, but the person is already somewhere
          // else and must not be dragged into a room they walked away from.
          showToast("已取消上傳");
          return;
        }

        // The user may have walked away while this was in flight. The cut is
        // safely in the cloud either way; what must NOT happen is yanking them
        // back into a room they left, or writing over the room they opened next.
        const stillHere = roomRef.current;
        if (!stillHere || !belongsToThisUpload.has(stillHere.id)) {
          showToast(`${label}已經上傳好了，之後打開這個影片就看得到。`, { tone: "success" });
          return;
        }

        // Adopt it locally right away so the player can start while the cloud
        // snapshot catches up; the snapshot then replaces this with the same
        // row, keyed by the same id.
        const next: Room = {
          ...stillHere,
          mediaType: "video",
          versions: [...stillHere.versions, version],
          updatedAt: Date.now(),
        };
        setRoom(next);
        setView((v) => (isNewRoom || !v.versionId ? initialView(next) : v));
        trackSave(next);
        showToast(isNewRoom ? "影片好了，開始留意見吧" : `已新增${label}`, { tone: "success" });
      } catch (err) {
        if (isUploadCancelled(err) || err instanceof CancelledUpload || abandoned) {
          setVideoUpload({ state: "idle" });
          showToast("已取消上傳");
          // A room created for an upload nobody wants must not keep the local
          // id tied to an empty cloud room — the next attempt would make a
          // second one and orphan this.
          if (isNewRoom) {
            // The bind already cached an empty snapshot; leaving it behind puts
            // a room in 最近討論 that opens to nothing.
            const cloudId = cloudRef.current.forgetCloudRoom(base.id);
            deleteRoom(base.id).catch(() => undefined);
            if (cloudId) deleteRoom(cloudId).catch(() => undefined);
            if ((roomRef.current?.versions.length ?? 0) === 0) setRoom(null);
          }
        } else if (!belongsToThisUpload.has(roomRef.current?.id ?? "")) {
          // The upload failed after the person had already moved on. Telling
          // whichever room they are in now that something failed there would be
          // a lie; the success path already knows this, and so must this one.
          showToast(userFacingMessage(err), { tone: "error" });
        } else {
          const message = userFacingMessage(err);
          setVideoUpload({ state: "error", message, progress: 0, cancel: () => setVideoUpload({ state: "idle" }) });
          showToast(message, { tone: "error" });
        }
        // The room stays: its cloud room and invite already exist, so keeping
        // it lets 再試一次 reuse them instead of creating a second empty room.
        // Leaving from the failure screen is what releases them.
      } finally {
        videoCancelRef.current = null;
        busy.current.delete("upload");
      }
    },
    [showToast, trackSave],
  );

  /** Picks route by what the room IS, so neither workspace has to check. */
  const addFiles = useCallback(
    (files: FileList | null) => {
      const current = roomRef.current;
      if (current && roomMediaType(current) === "video") {
        void addVideoFile(files);
        return;
      }
      void addImageFiles(files);
    },
    [addImageFiles, addVideoFile],
  );

  /**
   * File one piece of video feedback: same comment, same discussion, same cloud
   * write as a poster pin — only the coordinates are a time.
   */
  const commitVideoComment = useCallback(
    (anchor: VideoAnchor) => {
      const current = roomRef.current;
      if (!current || !guest || !form.body.trim()) return;
      const versionId = viewRef.current.versionId || current.versions[0]?.id;
      if (!versionId) return;
      const at = anchor.kind === "range" ? anchor.startTime : anchor.time;
      if (!claim(`video:${versionId}:${at.toFixed(2)}:${form.body.trim()}`)) return;

      const pin: CommentPin = {
        id: uid("c_"),
        versionId,
        authorId: guest.id,
        authorName: guest.name,
        authorColor: guest.color,
        // x/y are meaningless for time anchors; the columns keep their defaults
        // so a future on-screen position has somewhere to go.
        x: 0.5,
        y: 0.5,
        anchor,
        body: form.body.trim(),
        suggestion: form.suggestion.trim(),
        problemType: form.type,
        priority: form.priority,
        resolved: false,
        createdAt: Date.now(),
      };
      pushUndo(current);
      updateRoom((r) => ({ ...r, comments: [...r.comments, pin] }));
      cloudRef.current.writes.insertComment(pin);
      setFormState(EMPTY_FORM);
      showToast("已收到你的意見 ✓", { tone: "success", action: { label: "復原", onClick: undoLast } });
    },
    [guest, form, claim, pushUndo, updateRoom, showToast, undoLast],
  );

  /**
   * Give up on a video room that never got its first cut.
   *
   * Three things have to go, or the next attempt starts from a fresh local id
   * and quietly creates a SECOND empty cloud room: the mapping, the cached
   * snapshot the cloud bind already wrote, and the room in state.
   */
  const abandonEmptyVideoRoom = useCallback(() => {
    const current = roomRef.current;
    videoCancelRef.current?.();
    setVideoUpload({ state: "idle" });
    if (current) {
      const cloudId = cloudRef.current.forgetCloudRoom(current.id);
      deleteRoom(current.id).catch(() => undefined);
      if (cloudId && cloudId !== current.id) deleteRoom(cloudId).catch(() => undefined);
    }
    clearUndo();
    setRoom(null);
    location.hash = "";
  }, [clearUndo]);

  /** The playing version's signed URL expired; mint another for the same path. */
  const refreshVideoUrl = useCallback(async (): Promise<string | null> => {
    const current = roomRef.current;
    const version = current?.versions.find((v) => v.id === viewRef.current.versionId);
    if (!version?.videoPath) return null;
    const fresh = await cloudRef.current.refreshVideoUrl(version.videoPath);
    if (!fresh) return null;
    // Keep the room object honest too, so a later re-render does not hand the
    // player the stale URL again.
    setRoom((r) =>
      r
        ? { ...r, versions: r.versions.map((v) => (v.id === version.id ? { ...v, videoUrl: fresh } : v)) }
        : r,
    );
    return fresh;
  }, []);

  /**
   * Feedback tasks are one-shot on mobile: sent or cancelled, the app returns
   * to clean viewing. Desktop keeps its persistent pin tool; the region
   * gesture is one-shot everywhere.
   */
  const finishTask = useCallback(() => {
    setTool((t) => (t === "region" || (isMobileRef.current && t === "pin") ? "pan" : t));
  }, []);

  const cancelPin = useCallback(() => {
    setDraftPin(null);
    setFormState(EMPTY_FORM);
    finishTask();
  }, [finishTask]);

  const placePin = useCallback((versionId: string, x: number, y: number) => {
    setSelectedPinId(null);
    setPreviewStrokeId(null);
    setDraftPin({ versionId, x, y });
    setFormState(EMPTY_FORM);
  }, []);

  /** A finished 圈範圍 gesture: the freehand stroke is gone, only its region remains as a draft. */
  const placeRegion = useCallback((versionId: string, region: AnnotationRegion) => {
    const center = regionCenter(region);
    setSelectedPinId(null);
    setPreviewStrokeId(null);
    setDraftPin({ versionId, x: center.x, y: center.y, region });
    setFormState(EMPTY_FORM);
  }, []);

  const commitPin = useCallback(() => {
    if (!draftPin || !guest || !form.body.trim()) {
      cancelPin();
      return;
    }
    if (!claim(`pin:${draftPin.versionId}:${draftPin.x}:${draftPin.y}`)) return;
    const pin: CommentPin = {
      id: uid("c_"),
      versionId: draftPin.versionId,
      authorId: guest.id,
      authorName: guest.name,
      authorColor: guest.color,
      x: draftPin.x,
      y: draftPin.y,
      ...(draftPin.region ? { region: draftPin.region } : {}),
      body: form.body.trim(),
      suggestion: form.suggestion.trim(),
      problemType: form.type,
      priority: form.priority,
      resolved: false,
      createdAt: Date.now(),
    };
    const current = roomRef.current;
    const number = current ? nextPinNumber(current, draftPin.versionId) : 1;
    if (current) pushUndo(current);
    updateRoom((r) => ({ ...r, comments: [...r.comments, pin] }));
    cloudRef.current.writes.insertComment(pin);
    markCoachSeen();
    cancelPin();
    void number;
    const count = (current?.comments.length ?? 0) + 1;
    const people = new Set([...(current?.comments.map((c) => c.authorName) ?? []), guest.name]).size;
    showToast("已收到你的意見 ✓", {
      tone: "success",
      action: { label: "復原", onClick: undoLast },
    });
    showToast(`目前 ${people} 人提出 ${count} 個修改建議`);
  }, [draftPin, guest, form, claim, pushUndo, updateRoom, markCoachSeen, cancelPin, showToast, undoLast]);

  const toggleResolve = useCallback(
    (pinId: string) => {
      const current = roomRef.current;
      if (!current) return;
      const pin = current.comments.find((c) => c.id === pinId);
      if (!pin) return;
      const willResolve = !pin.resolved;
      const number = pinNumber(current, pinId);
      cloudRef.current.writes.setResolved(pinId, willResolve);
      mutateWithUndo(
        (r) => ({
          ...r,
          comments: r.comments.map((c) => (c.id === pinId ? { ...c, resolved: willResolve } : c)),
        }),
        `修改點 ${number} ${willResolve ? "已標記完成" : "已重新開啟"}`,
      );
    },
    [mutateWithUndo],
  );

  const addStroke = useCallback(
    (versionId: string, points: Point[]) => {
      if (!guest || points.length < 2) return;
      const current = roomRef.current;
      if (current) pushUndo(current);
      const stroke: Stroke = {
        id: uid("s_"),
        versionId,
        authorId: guest.id,
        color: guest.color,
        width: 4,
        points,
        createdAt: Date.now(),
      };
      updateRoom((r) => ({ ...r, strokes: [...r.strokes, stroke] }));
      cloudRef.current.writes.insertStroke(stroke);
    },
    [guest, pushUndo, updateRoom],
  );

  const eraseStroke = useCallback(
    (strokeId: string) => {
      const current = roomRef.current;
      if (!current || !current.strokes.some((s) => s.id === strokeId)) return;
      cloudRef.current.writes.deleteStroke(strokeId);
      mutateWithUndo((r) => ({ ...r, strokes: r.strokes.filter((s) => s.id !== strokeId) }), "已刪除圈畫");
    },
    [mutateWithUndo],
  );

  const sendChat = useCallback(() => {
    if (!guest || !chatInput.trim()) return;
    if (!claim(`chat:${chatInput.trim()}`, 300)) return;
    const msg: ChatMessage = {
      id: uid("m_"),
      authorId: guest.id,
      authorName: guest.name,
      authorColor: guest.color,
      body: chatInput.trim(),
      createdAt: Date.now(),
    };
    updateRoom((r) => ({ ...r, messages: [...r.messages, msg] }));
    cloudRef.current.writes.insertMessage(msg);
    setChatInput("");
  }, [guest, chatInput, claim, updateRoom]);

  // "我也覺得": one per user per comment; tapping again removes it.
  const toggleSupport = useCallback(
    (commentId: string) => {
      if (!guest) return;
      const current = roomRef.current;
      if (!current) return;
      const uidNow = guest.id;
      const existing = (current.supports ?? []).some((s) => s.commentId === commentId && s.userId === uidNow);
      updateRoom((r) => {
        const list = r.supports ?? [];
        return {
          ...r,
          supports: existing
            ? list.filter((s) => !(s.commentId === commentId && s.userId === uidNow))
            : [...list, { commentId, userId: uidNow }],
        };
      });
      cloudRef.current.writes.toggleSupport(commentId, !existing);
    },
    [guest, updateRoom],
  );

  const addReply = useCallback(
    (commentId: string, body: string) => {
      const text = body.trim();
      if (!guest || !text) return;
      if (!claim(`reply:${commentId}:${text}`, 300)) return;
      const reply: CommentReply = {
        id: uid("r_"),
        commentId,
        authorId: guest.id,
        authorName: guest.name,
        authorColor: guest.color,
        body: text,
        createdAt: Date.now(),
      };
      updateRoom((r) => ({ ...r, replies: [...(r.replies ?? []), reply] }));
      cloudRef.current.writes.insertReply(reply);
    },
    [guest, claim, updateRoom],
  );

  // One take per user per version; tapping the current choice clears it.
  const setProposalPref = useCallback(
    (versionId: string, choice: string) => {
      if (!guest) return;
      const uidNow = guest.id;
      const current = roomRef.current;
      const existing = (current?.proposalPrefs ?? []).find((p) => p.versionId === versionId && p.userId === uidNow);
      const clearing = existing?.choice === choice;
      updateRoom((r) => {
        const list = (r.proposalPrefs ?? []).filter((p) => !(p.versionId === versionId && p.userId === uidNow));
        return { ...r, proposalPrefs: clearing ? list : [...list, { versionId, userId: uidNow, choice }] };
      });
      cloudRef.current.writes.setProposalPref(versionId, clearing ? "" : choice);
    },
    [guest, updateRoom],
  );

  const startHosting = useCallback(() => {
    if (isCloudConfigured) return;
    const current = roomRef.current;
    if (!current || collabRef.current) return;
    const collab = new Collab("host", current.id, {
      onStatus: (status) => {
        setCollabStatus(status);
        setPeerCount(collab.peerCount);
      },
      onMessage: (msg, conn) => {
        if (msg.t === "hello") {
          collab.sendTo(conn, { t: "snapshot", room: roomRef.current!, view: viewRef.current });
          setPeerCount(collab.peerCount);
        } else if (msg.t === "room") {
          applyRemoteRoom(msg.room);
          saveRoom(msg.room).catch(() => undefined);
        }
      },
    });
    collab.connect();
    collabRef.current = collab;
  }, [applyRemoteRoom]);

  /**
   * Local mode serves the room straight from this device, so host whenever a
   * room is open — waiting for a 分享 tap left every reopened room unreachable
   * to partners. (With cloud configured, Supabase serves the room instead.)
   */
  useEffect(() => {
    if (isCloudConfigured || isGuestSession || !room?.id) return;
    startHosting();
    return () => {
      collabRef.current?.destroy();
      collabRef.current = null;
      setCollabStatus(null);
      setPeerCount(0);
    };
  }, [isGuestSession, room?.id, startHosting]);

  /**
   * Closing the tab mid-upload.
   *
   * The request would be killed by the browser anyway; aborting it ourselves is
   * what lets the cleanup path run, so a half-uploaded object does not sit in a
   * private bucket that nothing will ever reference.
   */
  useEffect(() => {
    const stop = () => videoCancelRef.current?.();
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, []);

  // Phones freeze background tabs and drop sockets; re-dial the peer link the
  // moment we are visible or online again. Harmless when no peer is in use.
  useEffect(() => {
    const revive = () => {
      if (document.visibilityState === "visible") collabRef.current?.retryNow();
    };
    const onOnline = () => collabRef.current?.retryNow();
    document.addEventListener("visibilitychange", revive);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", revive);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const [shareState, setShareState] = useState<ShareState>({ kind: "creating" });
  const shareStateRef = useRef<ShareState>(shareState);
  shareStateRef.current = shareState;
  /**
   * Guards against a late preview result landing on a share sheet the user has
   * since closed and reopened (or on a different room).
   */
  const shareSeq = useRef(0);

  /**
   * Fold a preview result into the sheet. The permanent `#room=…&invite=…` URL
   * stays the fallback in every branch: an Open Graph card is an enhancement,
   * never a prerequisite for sharing (PR #21).
   */
  const applyPreview = useCallback((seq: number, appUrl: string, preview: SharePreview | null) => {
    if (seq !== shareSeq.current) return;
    if (!preview) {
      setShareState({ kind: "ready", url: appUrl, appUrl, preview: { status: "unavailable" } });
      return;
    }
    setShareState({
      kind: "ready",
      url: buildPreviewShareUrl(preview.id, appUrl),
      appUrl,
      preview:
        preview.showThumbnail && preview.thumbnailPath
          ? { status: "on", thumbnailUrl: previewThumbnailUrl(preview.thumbnailPath, preview.updatedAt) }
          : { status: "off" },
    });
  }, []);

  const failPreview = useCallback((seq: number, appUrl: string) => {
    if (seq !== shareSeq.current) return;
    setShareState({ kind: "ready", url: appUrl, appUrl, preview: { status: "unavailable" } });
  }, []);

  /**
   * A share link is only worth handing out if it still opens after the host
   * closes the page — that means cloud `#room=<uuid>&invite=<token>` and
   * nothing else. When the cloud room cannot be created we say so and offer a
   * retry; we never quietly fall back to a legacy `#room=<6碼>` URL, which
   * dies the moment this device goes away (PR #16).
   */
  const openShare = useCallback(() => {
    const current = roomRef.current;
    if (!current) return;
    setShareOpen(true);

    if (isLegacyLink) {
      setShareState({ kind: "legacy-guest" });
      return;
    }
    if (isCloudConfigured) {
      const seq = ++shareSeq.current;
      setShareState({ kind: "creating" });
      cloudRef.current
        .ensureShared()
        .then((res) => {
          if (seq !== shareSeq.current) return;
          if (!res.ok) {
            setShareState({ kind: "failed" });
            return;
          }
          // Hand over the working link immediately; the card catches up.
          const appUrl = res.url;
          setShareState({ kind: "ready", url: appUrl, appUrl, preview: { status: "building" } });
          cloudRef.current.preview
            .ensure({ versionId: viewRef.current.versionId })
            .then((preview) => applyPreview(seq, appUrl, preview))
            .catch(() => failPreview(seq, appUrl));
        })
        .catch(() => {
          if (seq === shareSeq.current) setShareState({ kind: "failed" });
        });
      return;
    }
    if (import.meta.env.DEV) {
      // Dev-only peer link for local testing, labelled as temporary. Written
      // against `import.meta.env.DEV` on purpose: the legacy URL is compiled
      // out of production bundles entirely, not merely branched around.
      startHosting();
      setShareState({ kind: "local", url: `${location.origin}${location.pathname}#room=${current.id}` });
      return;
    }
    // Deployed without VITE_SUPABASE_* — there is no permanent link to give.
    setShareState({ kind: "unavailable" });
  }, [isLegacyLink, startHosting, applyPreview, failPreview]);

  /** 顯示文宣縮圖 toggle in the share sheet's 連結預覽 block. */
  const setPreviewThumbnail = useCallback(
    (next: boolean) => {
      const current = shareStateRef.current;
      if (current.kind !== "ready") return;
      const { appUrl } = current;
      const seq = ++shareSeq.current;
      setShareState({ ...current, preview: { status: "building" } });
      cloudRef.current.preview
        .ensure({ versionId: viewRef.current.versionId, showThumbnail: next })
        .then((preview) => applyPreview(seq, appUrl, preview))
        .catch(() => failPreview(seq, appUrl));
    },
    [applyPreview, failPreview],
  );

  /** Revoke the current preview id so links already in a chat stop showing the poster. */
  const rotatePreview = useCallback(() => {
    const current = shareStateRef.current;
    if (current.kind !== "ready") return;
    const { appUrl } = current;
    const seq = ++shareSeq.current;
    setShareState({ ...current, preview: { status: "building" } });
    cloudRef.current.preview
      .rotate({ versionId: viewRef.current.versionId })
      .then((preview) => {
        applyPreview(seq, appUrl, preview);
        // A null result means nothing was rotated (no readable version yet), so
        // saying "use the new link" would be a lie — applyPreview already put
        // the sheet back on the plain permanent URL.
        if (preview && seq === shareSeq.current) {
          showToast("已重新產生預覽連結，請改用新的分享連結。", { tone: "success" });
        }
      })
      .catch(() => failPreview(seq, appUrl));
  }, [applyPreview, failPreview, showToast]);

  const copySummary = useCallback(async () => {
    const current = roomRef.current;
    if (!current) return;
    if (current.comments.length === 0) {
      showToast("還沒有修改點可以複製。", { tone: "error" });
      return;
    }
    const openCount = current.comments.filter((c) => !c.resolved).length;
    const ordered =
      roomMediaType(current) === "video"
        ? [...current.comments].sort((a, b) => anchorStart(a) - anchorStart(b) || a.createdAt - b.createdAt)
        : current.comments;
    const lines = ordered.map((c) => {
      const status = c.resolved ? "已完成" : "待修改";
      const type = c.problemType ?? "修改";
      const priority = c.priority ?? "一般";
      const versionLabel = current.versions.find((v) => v.id === c.versionId)?.label ?? "";
      const suggestion = c.suggestion ? `\n   建議：${c.suggestion}` : "";
      const number = pinNumber(current, c.id);
      // A video note without its timecode cannot be found again; the whole list
      // is only useful if each line points back at a moment.
      const at = anchorLabel(c);
      const where = [versionLabel, at].filter(Boolean).join(" ");
      return `#${String(number).padStart(2, "0")} [${status}] [${priority}] [${type}] ${where}\n   問題：${c.body}${suggestion}`;
    });
    const summary = `${current.title}\n共 ${current.comments.length} 個修改點｜待修改 ${openCount}｜已完成 ${current.comments.length - openCount}\n\n${lines.join("\n\n")}`;
    try {
      await navigator.clipboard.writeText(summary);
      showToast("修改清單已複製", { tone: "success" });
    } catch {
      showToast("複製失敗，請再試一次。", { tone: "error" });
    }
  }, [showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Video rooms have their own Escape ladder (draft → range pick →
      // selection). Running both would cancel two things per press.
      if (roomRef.current && roomMediaType(roomRef.current) === "video") return;
      if (draftPin) cancelPin();
      else if (tool === "region") setTool("pan");
      else if (selectedPinId) setSelectedPinId(null);
      else if (previewStrokeId) setPreviewStrokeId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draftPin, selectedPinId, previewStrokeId, tool, cancelPin]);

  /** Switching tools always drops a legacy-stroke preview, keeping view mode clean. */
  const setToolAndClear = useCallback((t: Tool) => {
    setTool(t);
    setPreviewStrokeId(null);
  }, []);

  const selectPinAndClear = useCallback((id: string | null) => {
    setSelectedPinId(id);
    setPreviewStrokeId(null);
  }, []);

  const video: VideoApi | null =
    room && roomMediaType(room) === "video"
      ? { upload: videoUpload, commitVideoComment, refreshVideoUrl }
      : null;

  const api: WorkspaceApi | null = room
    ? {
        room,
        view,
        guest: guest!,
        tool,
        draftPin,
        form,
        selectedPinId,
        previewStrokeId,
        chatInput,
        saveState,
        coachSeen,
        canUndo: undoCount > 0,
        setTool: setToolAndClear,
        setView: updateView,
        setForm: (patch) => setFormState((f) => ({ ...f, ...patch })),
        placePin,
        placeRegion,
        commitPin,
        cancelPin,
        setPreviewStroke: setPreviewStrokeId,
        selectPin: selectPinAndClear,
        toggleResolve,
        addStroke,
        eraseStroke,
        toggleSupport,
        addReply,
        setProposalPref,
        undo: undoLast,
        setChatInput,
        sendChat,
        addFiles,
        setTitle: (title) => {
          updateRoom((r) => ({ ...r, title }));
          cloudRef.current.writes.setTitle(title);
        },
        copySummary,
        markCoachSeen,
        showToast,
        openShare,
        ...(video ? { video } : {}),
        goHome: () => {
          videoCancelRef.current?.();
          setVideoUpload({ state: "idle" });
          clearUndo();
          setRoom(null);
          setSelectedPinId(null);
          setPreviewStrokeId(null);
          location.hash = "";
        },
      }
    : null;

  if (!guest) {
    return (
      <div className="onboard">
        <div className="onboard-card">
          <h1 className="onboard-title">文宣討論區</h1>
          <p className="onboard-hint">
            {isGuestSession
              ? "夥伴邀你一起看文宣。點畫面上要調整的位置，留下你的意見就好。"
              : "把文宣傳給夥伴，直接在畫面上指出哪裡需要調整。"}
          </p>
          <input
            className="text-input"
            placeholder="你的名字"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && confirmName()}
            autoFocus
            enterKeyHint="go"
          />
          <button className="btn btn-primary btn-block" onClick={confirmName} disabled={!nameInput.trim()}>
            {isGuestSession ? "進入討論" : "開始"}
          </button>
        </div>
      </div>
    );
  }

  const hasVersions = (room?.versions.length ?? 0) > 0;
  const uploadingFirstVideo = Boolean(room) && roomMediaType(room!) === "video" && videoUpload.state !== "idle";

  if (!hasVersions && uploadingFirstVideo) {
    const pct = Math.round((videoUpload.state === "error" ? 0 : videoUpload.progress) * 100);
    const failed = videoUpload.state === "error";
    return (
      <div className="onboard">
        <div className="onboard-card">
          <h1 className="onboard-title">影片對稿</h1>
          <p className="onboard-hint">
            {videoUpload.state === "uploading"
              ? `正在上傳影片 ${pct}%`
              : videoUpload.state === "processing"
                ? "正在處理影片…"
                : videoUpload.state === "error"
                  ? videoUpload.message
                  : "正在準備影片…"}
          </p>
          {videoUpload.state === "uploading" && (
            <span className="v-upload-bar" aria-hidden>
              <span className="v-upload-fill" style={{ width: `${pct}%` }} />
            </span>
          )}
          <p className="onboard-note">
            {failed
              ? "影片沒有上傳成功。可以再選一次檔案，房間和分享連結會沿用這一間。"
              : "影片會直接存進雲端，夥伴用連結就能打開，你不用一直開著頁面。"}
          </p>
          {failed ? (
            <>
              <UploadZone
                onFiles={addVideoFile}
                accept={VIDEO_ACCEPT}
                multiple={false}
                className="btn btn-primary btn-block"
              >
                重新選一支影片
              </UploadZone>
              <button className="btn btn-block" onClick={abandonEmptyVideoRoom}>
                回首頁
              </button>
            </>
          ) : (
            <button className="btn btn-block" onClick={videoUpload.cancel}>
              取消
            </button>
          )}
        </div>
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  if (!hasVersions) {
    if (isGuestSession) {
      // Cloud serves invite links; legacy #room=<6碼> links ride the peer channel.
      const cloudGuest = cloudSession && roomLink.kind === "cloud";
      const stalled = cloudGuest
        ? cloud.status === "error"
        : collabStatus === "waiting" || collabStatus === "error";
      const badLink = cloudGuest && cloud.inviteInvalid;
      /**
       * A legacy link with the host offline can never load: there is no cloud
       * room behind it and no local mapping to upgrade it with. Say that once
       * instead of looping a generic retry the partner cannot win.
       */
      const legacyStalled = isLegacyLink && stalled;
      return (
        <div className="onboard">
          <div className="onboard-card">
            {/* The link does not say what is behind it, so the title stays the
                neutral one rather than promising a poster. */}
            <h1 className="onboard-title">對稿討論區</h1>
            <p className="onboard-hint">
              {!stalled
                ? "正在載入…"
                : legacyStalled
                  ? "這是舊版分享連結"
                  : badLink
                    ? "分享連結無效或已失效"
                    : "目前暫時無法載入這個討論，請稍後再試。"}
            </p>
            {stalled && (
              <>
                <p className="onboard-note">
                  {legacyStalled
                    ? "舊版連結需要主辦方保持頁面開著才打得開。請向主辦方取得新版分享連結，新版連結在主辦方關掉頁面後也能打開。"
                    : badLink
                      ? "請向分享的人要一個新的連結。"
                      : "可能是網路不太穩，會自動重試；稍後再打開這個連結也可以。"}
                </p>
                {legacyStalled ? (
                  <button className="btn btn-block" onClick={() => collabRef.current?.retryNow()}>
                    主辦方在線的話，再試一次
                  </button>
                ) : (
                  !badLink && (
                    <button
                      className="btn btn-primary btn-block"
                      onClick={() => {
                        if (cloudGuest) cloudRef.current.retry();
                        else collabRef.current?.retryNow();
                      }}
                    >
                      再試一次
                    </button>
                  )
                )}
              </>
            )}
          </div>
          <ToastStack toasts={toasts} onDismiss={dismiss} />
        </div>
      );
    }
    return (
      <div className="app">
        <Home
          recent={recent}
          isGuestSession={isGuestSession}
          onFiles={addImageFiles}
          onVideoFiles={addVideoFile}
          videoAvailable={isCloudConfigured}
          onOpen={openRoom}
        />
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  return (
    <>
      <RoomWorkspace
        api={api!}
        presence={{
          status: cloudSession ? syncToPresence(cloud.status) : collabStatus,
          peers: cloudSession ? cloud.online : peerCount,
        }}
        cloud={cloudSession ? { status: cloud.status, online: cloud.online } : null}
      />

      {shareOpen && room && (
        <ShareSheet
          title={room.title}
          state={shareState}
          onRetry={openShare}
          onClose={() => setShareOpen(false)}
          onToast={showToast}
          onPreviewThumbnail={setPreviewThumbnail}
          onRotatePreview={rotatePreview}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
