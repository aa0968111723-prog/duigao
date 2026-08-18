import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COLORS,
  VERSION_LABELS,
  type ChatMessage,
  type CommentPin,
  type Guest,
  type Point,
  type Room,
  type Stroke,
  type Tool,
  type Version,
  type ViewState,
} from "./lib/types";
import { roomCode, uid } from "./lib/id";
import { listRooms, loadFlag, loadGuest, loadRoom, saveFlag, saveGuest, saveRoom } from "./lib/store";
import { Collab, type CollabStatus } from "./lib/peer";
import { cloudEnabled, fetchRoom, mergeRooms, publishRoom } from "./lib/cloud";
import { ToastStack, useToasts } from "./toast";
import { useIsMobile } from "./hooks/useIsMobile";
import { DesktopWorkspace } from "./components/DesktopWorkspace";
import { MobileWorkspace } from "./components/MobileWorkspace";
import { Home } from "./components/Home";
import { ShareSheet } from "./components/ShareSheet";
import type { PinDraft, PinForm, SaveState, WorkspaceApi } from "./components/api";
import "./usability.css";

const EMPTY_FORM: PinForm = { body: "", suggestion: "", type: "文字", priority: "一般" };
const COACH_FLAG = "coach.firstPin";

function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function emptyRoom(id: string, title: string): Room {
  return { id, title, versions: [], comments: [], strokes: [], messages: [], updatedAt: Date.now() };
}

function initialView(room: Room | null): ViewState {
  const first = room?.versions[0]?.id ?? "";
  const second = room?.versions[1]?.id ?? first;
  return { versionId: first, compareId: second, colorMode: "color", compareMode: "single", split: 0.5, wipe: 0.5 };
}

function readRoomCodeFromUrl(): string | null {
  const m = /[#?&]room=([a-z0-9]+)/i.exec(location.hash + location.search);
  return m ? m[1] : null;
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
  const [chatInput, setChatInput] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [collabStatus, setCollabStatus] = useState<CollabStatus | null>(null);
  const [peerCount, setPeerCount] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [coachSeen, setCoachSeen] = useState<boolean>(() => loadFlag(COACH_FLAG));
  const [cloudChecked, setCloudChecked] = useState(!cloudEnabled);

  const { toasts, showToast, dismiss } = useToasts();
  const isMobile = useIsMobile();
  const collabRef = useRef<Collab | null>(null);
  const roomRef = useRef<Room | null>(null);
  const viewRef = useRef<ViewState>(view);
  const saveSeq = useRef(0);
  const publishTimer = useRef<number | null>(null);
  const cloudRoomRef = useRef<Room | null>(null);
  const busy = useRef<Set<string>>(new Set());
  const offlineNotified = useRef(false);
  roomRef.current = room;
  viewRef.current = view;

  const isGuestSession = useMemo(() => readRoomCodeFromUrl() != null, []);

  const markCoachSeen = useCallback(() => {
    setCoachSeen((seen) => {
      if (!seen) saveFlag(COACH_FLAG);
      return true;
    });
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
    const timer = window.setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1500);
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

  useEffect(() => {
    if (!guest) return;
    const code = readRoomCodeFromUrl();
    if (!code) return;

    let cancelled = false;
    // Local copy first (instant on a revisit), then the cloud mirror.
    loadRoom(code).then((existing) => {
      if (existing && !cancelled) applyRemoteRoom(existing);
    });
    fetchRoom(code).then((cloud) => {
      if (cancelled) return;
      setCloudChecked(true);
      if (!cloud) return;
      const local = roomRef.current;
      const merged = local && local.id === cloud.id ? mergeRooms(local, cloud) : cloud;
      applyRemoteRoom(merged);
      saveRoom(merged).catch(() => undefined);
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
      cancelled = true;
      collab.destroy();
      collabRef.current = null;
    };
  }, [guest, applyRemoteRoom, showToast]);

  /**
   * Mirrors the room so partners can open the link even when this device is
   * asleep. Debounced because typing a title or dragging a stroke would
   * otherwise publish on every keystroke.
   */
  const publishSoon = useCallback((next: Room) => {
    if (!cloudEnabled) return;
    cloudRoomRef.current = next;
    if (publishTimer.current !== null) return;
    publishTimer.current = window.setTimeout(() => {
      publishTimer.current = null;
      const pending = cloudRoomRef.current;
      if (!pending) return;
      publishRoom(pending).then((saved) => {
        if (!saved) return;
        // Keep the storage URLs we just earned so later saves skip the upload.
        setRoom((prev) => {
          if (!prev || prev.id !== saved.id) return prev;
          const urls = new Map(saved.versions.map((v) => [v.id, v.imageUrl]));
          if (prev.versions.every((v) => v.imageUrl === urls.get(v.id))) return prev;
          const next2 = {
            ...prev,
            versions: prev.versions.map((v) => (urls.get(v.id) ? { ...v, imageUrl: urls.get(v.id) } : v)),
          };
          saveRoom(next2).catch(() => undefined);
          return next2;
        });
      });
    }, 900);
  }, []);

  const persist = useCallback(
    (next: Room) => {
      trackSave(next);
      collabRef.current?.send({ t: "room", room: next });
      publishSoon(next);
    },
    [trackSave, publishSoon],
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

  /** Apply a change and offer a few-second Undo that restores the prior room. */
  const mutateWithUndo = useCallback(
    (mutate: (r: Room) => Room, toastMessage: string) => {
      const snapshot = roomRef.current;
      if (!snapshot) return;
      const next = { ...mutate(snapshot), updatedAt: Date.now() };
      setRoom(next);
      persist(next);
      showToast(toastMessage, {
        action: {
          label: "復原",
          onClick: () => {
            setRoom(snapshot);
            persist(snapshot);
            showToast("已復原");
          },
        },
      });
    },
    [persist, showToast],
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

  const openRoom = useCallback((r: Room) => {
    setRoom(r);
    setView(initialView(r));
    // Partners may have added notes while this device was closed.
    fetchRoom(r.id).then((cloud) => {
      if (!cloud || cloud.id !== r.id) return;
      const merged = mergeRooms(r, cloud);
      setRoom((prev) => (prev?.id === merged.id ? merged : prev));
      saveRoom(merged).catch(() => undefined);
    });
  }, []);

  const addFiles = useCallback(
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
        const added = newVersions[newVersions.length - 1];
        if (!created) {
          showToast(newVersions.length > 1 ? `已新增 ${newVersions.length} 版` : `已新增${added.label}`, {
            tone: "success",
          });
        }
      } finally {
        busy.current.delete("upload");
      }
    },
    [persist, showToast],
  );

  const cancelPin = useCallback(() => {
    setDraftPin(null);
    setFormState(EMPTY_FORM);
  }, []);

  const placePin = useCallback((versionId: string, x: number, y: number) => {
    setSelectedPinId(null);
    setDraftPin({ versionId, x, y });
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
      body: form.body.trim(),
      suggestion: form.suggestion.trim(),
      problemType: form.type,
      priority: form.priority,
      resolved: false,
      createdAt: Date.now(),
    };
    const number = (roomRef.current?.comments.length ?? 0) + 1;
    updateRoom((r) => ({ ...r, comments: [...r.comments, pin] }));
    markCoachSeen();
    cancelPin();
    showToast(`已新增修改點 ${number}`, {
      tone: "success",
      action: {
        label: "復原",
        onClick: () => {
          updateRoom((r) => ({ ...r, comments: r.comments.filter((c) => c.id !== pin.id) }));
          showToast("已復原");
        },
      },
    });
  }, [draftPin, guest, form, claim, updateRoom, markCoachSeen, cancelPin, showToast]);

  const toggleResolve = useCallback(
    (pinId: string) => {
      const current = roomRef.current;
      if (!current) return;
      const index = current.comments.findIndex((c) => c.id === pinId);
      if (index < 0) return;
      const willResolve = !current.comments[index].resolved;
      mutateWithUndo(
        (r) => ({
          ...r,
          comments: r.comments.map((c) => (c.id === pinId ? { ...c, resolved: willResolve } : c)),
        }),
        `${index + 1} ${willResolve ? "已標記完成" : "已重新開啟"}`,
      );
    },
    [mutateWithUndo],
  );

  const addStroke = useCallback(
    (versionId: string, points: Point[]) => {
      if (!guest || points.length < 2) return;
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
    },
    [guest, updateRoom],
  );

  const eraseStroke = useCallback(
    (strokeId: string) => {
      const current = roomRef.current;
      if (!current || !current.strokes.some((s) => s.id === strokeId)) return;
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
    setChatInput("");
  }, [guest, chatInput, claim, updateRoom]);

  const startHosting = useCallback(() => {
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

  // The room is served straight from this device, so host whenever one is open
  // — waiting for a 分享 tap left every reopened room unreachable to partners.
  useEffect(() => {
    if (isGuestSession || !room?.id) return;
    startHosting();
    return () => {
      collabRef.current?.destroy();
      collabRef.current = null;
      setCollabStatus(null);
      setPeerCount(0);
    };
  }, [isGuestSession, room?.id, startHosting]);

  // Phones suspend background tabs; re-dial as soon as we are visible again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") collabRef.current?.retryNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, []);

  const shareUrl = useMemo(() => {
    if (!room) return "";
    return `${location.origin}${location.pathname}#room=${room.id}`;
  }, [room]);

  const copySummary = useCallback(async () => {
    const current = roomRef.current;
    if (!current) return;
    if (current.comments.length === 0) {
      showToast("還沒有修改點可以複製。", { tone: "error" });
      return;
    }
    const openCount = current.comments.filter((c) => !c.resolved).length;
    const lines = current.comments.map((c, index) => {
      const status = c.resolved ? "已完成" : "待修改";
      const type = c.problemType ?? "修改";
      const priority = c.priority ?? "一般";
      const versionLabel = current.versions.find((v) => v.id === c.versionId)?.label ?? "";
      const suggestion = c.suggestion ? `\n   建議：${c.suggestion}` : "";
      return `#${String(index + 1).padStart(2, "0")} [${status}] [${priority}] [${type}] ${versionLabel}\n   問題：${c.body}${suggestion}`;
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
      if (draftPin) cancelPin();
      else if (selectedPinId) setSelectedPinId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draftPin, selectedPinId, cancelPin]);

  const api: WorkspaceApi | null = room
    ? {
        room,
        view,
        guest: guest!,
        tool,
        draftPin,
        form,
        selectedPinId,
        chatInput,
        saveState,
        coachSeen,
        setTool,
        setView: updateView,
        setForm: (patch) => setFormState((f) => ({ ...f, ...patch })),
        placePin,
        commitPin,
        cancelPin,
        selectPin: setSelectedPinId,
        toggleResolve,
        addStroke,
        eraseStroke,
        setChatInput,
        sendChat,
        addFiles,
        setTitle: (title) => updateRoom((r) => ({ ...r, title })),
        copySummary,
        markCoachSeen,
        showToast,
        openShare: () => {
          startHosting();
          setShareOpen(true);
        },
        retryConnection: () => collabRef.current?.retryNow(),
        goHome: () => {
          setRoom(null);
          setSelectedPinId(null);
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

  if (!hasVersions) {
    if (isGuestSession) {
      const searching = !cloudChecked || (collabStatus !== "waiting" && collabStatus !== "error");
      return (
        <div className="onboard">
          <div className="onboard-card">
            <h1 className="onboard-title">文宣討論區</h1>
            <p className="onboard-hint">{searching ? "正在載入文宣…" : "找不到這份文宣"}</p>
            {!searching && (
              <>
                <p className="onboard-note">
                  連結可能不完整，或這份文宣還沒上傳完成。
                  請跟分享的人確認一次，或請對方重新分享。
                </p>
                <button
                  className="btn btn-primary btn-block"
                  onClick={() => {
                    setCloudChecked(false);
                    collabRef.current?.retryNow();
                    fetchRoom(readRoomCodeFromUrl() ?? "").then((cloud) => {
                      setCloudChecked(true);
                      if (cloud) {
                        applyRemoteRoom(cloud);
                        saveRoom(cloud).catch(() => undefined);
                      }
                    });
                  }}
                >
                  再試一次
                </button>
              </>
            )}
          </div>
          <ToastStack toasts={toasts} onDismiss={dismiss} />
        </div>
      );
    }
    return (
      <div className="app">
        <Home recent={recent} isGuestSession={isGuestSession} onFiles={addFiles} onOpen={openRoom} />
        <ToastStack toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  return (
    <>
      {isMobile ? (
        <MobileWorkspace api={api!} presence={{ status: collabStatus, peers: peerCount }} />
      ) : (
        <div className="app">
          <header className="topbar">
            <button className="brand" onClick={api!.goHome}>
              <span className="brand-dot" />
              文宣討論區
            </button>
            <input
              className="title-input"
              value={room!.title}
              onChange={(e) => api!.setTitle(e.target.value)}
              aria-label="文宣名稱"
            />
            <div className="topbar-right">
              {saveState !== "idle" && (
                <span className={`save-status save-${saveState}`} title="資料自動保存在這台裝置">
                  {saveState === "saving" ? "儲存中…" : saveState === "saved" ? "已儲存" : "儲存失敗"}
                </span>
              )}
              {collabStatus && (
                <span
                  className={`badge badge-${collabStatus}`}
                  title={
                    collabStatus === "online"
                      ? "已與其他人同步"
                      : collabStatus === "connecting"
                        ? "正在建立同步連線"
                        : "目前離線，內容已保存在這台裝置"
                  }
                >
                  {collabStatus === "online"
                    ? peerCount > 0
                      ? `已同步 · ${peerCount} 人`
                      : "已同步"
                    : collabStatus === "connecting"
                      ? "正在同步"
                      : collabStatus === "waiting"
                        ? "等待連線"
                        : "目前離線"}
                </span>
              )}
              <span className="me" style={{ background: guest.color }} title={guest.name}>
                {guest.name.slice(0, 1)}
              </span>
              <button className="btn btn-primary" onClick={api!.openShare}>
                分享
              </button>
            </div>
          </header>

          {!coachSeen && room!.comments.length === 0 && (
            <div className="coach" role="note">
              <span className="coach-icon">💡</span>
              <span className="coach-text">
                第一次用嗎？選「修改點」 → 點文宣上需要調整的位置 → 留下意見。
              </span>
              <button className="coach-dismiss" onClick={markCoachSeen}>
                知道了
              </button>
            </div>
          )}

          <DesktopWorkspace api={api!} />
        </div>
      )}

      {shareOpen && room && (
        <ShareSheet
          title={room.title}
          url={shareUrl}
          onClose={() => setShareOpen(false)}
          onToast={showToast}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
