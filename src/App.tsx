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
import { listRooms, loadGuest, loadRoom, saveGuest, saveRoom } from "./lib/store";
import { Collab, type CollabStatus } from "./lib/peer";
import { useIsMobile } from "./hooks/useIsMobile";
import { DesktopWorkspace } from "./components/DesktopWorkspace";
import { MobileWorkspace } from "./components/MobileWorkspace";
import { Home } from "./components/Home";
import { ShareSheet } from "./components/ShareSheet";
import type { PinDraft, PinForm, WorkspaceApi } from "./components/api";

const EMPTY_FORM: PinForm = { body: "", suggestion: "", type: "文字", priority: "一般" };

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

  const isMobile = useIsMobile();
  const collabRef = useRef<Collab | null>(null);
  const roomRef = useRef<Room | null>(null);
  const viewRef = useRef<ViewState>(view);
  roomRef.current = room;
  viewRef.current = view;

  const isGuestSession = useMemo(() => readRoomCodeFromUrl() != null, []);

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

    loadRoom(code).then((existing) => {
      if (existing) applyRemoteRoom(existing);
    });

    const collab = new Collab("guest", code, {
      onStatus: (status) => {
        setCollabStatus(status);
        setPeerCount(collab.peerCount);
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
  }, [guest, applyRemoteRoom]);

  const persist = useCallback((next: Room) => {
    saveRoom(next).catch(() => undefined);
    collabRef.current?.send({ t: "room", room: next });
  }, []);

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
  }, []);

  const addFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const current = roomRef.current ?? emptyRoom(roomCode(), "未命名文宣");
      const created = !roomRef.current;
      const newVersions: Version[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const dataUrl = await fileToDataUrl(file);
        const idx = current.versions.length + newVersions.length;
        newVersions.push({ id: uid("v_"), label: VERSION_LABELS[idx] ?? `改${idx}`, imageDataUrl: dataUrl });
      }
      if (newVersions.length === 0) return;
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
    },
    [persist],
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
    updateRoom((r) => ({ ...r, comments: [...r.comments, pin] }));
    cancelPin();
  }, [draftPin, guest, form, updateRoom, cancelPin]);

  const toggleResolve = useCallback(
    (pinId: string) => {
      updateRoom((r) => ({
        ...r,
        comments: r.comments.map((c) => (c.id === pinId ? { ...c, resolved: !c.resolved } : c)),
      }));
    },
    [updateRoom],
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
    (strokeId: string) => updateRoom((r) => ({ ...r, strokes: r.strokes.filter((s) => s.id !== strokeId) })),
    [updateRoom],
  );

  const sendChat = useCallback(() => {
    if (!guest || !chatInput.trim()) return;
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
  }, [guest, chatInput, updateRoom]);

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

  const shareUrl = useMemo(() => {
    if (!room) return "";
    return `${location.origin}${location.pathname}#room=${room.id}`;
  }, [room]);

  const copySummary = useCallback(async () => {
    const current = roomRef.current;
    if (!current) return;
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
    } catch {
      /* clipboard may be blocked */
    }
  }, []);

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
        openShare: () => {
          startHosting();
          setShareOpen(true);
        },
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
            onKeyDown={(e) => e.key === "Enter" && confirmName()}
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
      return (
        <div className="onboard">
          <div className="onboard-card">
            <h1 className="onboard-title">文宣討論區</h1>
            <p className="onboard-hint">
              {collabStatus === "error"
                ? "連不上主辦方，請對方重新打開連結後再試一次。"
                : "正在載入夥伴分享的文宣…"}
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="app">
        <Home recent={recent} isGuestSession={isGuestSession} onFiles={addFiles} onOpen={openRoom} />
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
              {collabStatus && (
                <span className={`badge badge-${collabStatus}`}>
                  {collabStatus === "online"
                    ? `連線中 · ${peerCount} 人`
                    : collabStatus === "connecting"
                      ? "連線中…"
                      : collabStatus === "error"
                        ? "本機模式"
                        : "已關閉"}
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
          <DesktopWorkspace api={api!} />
        </div>
      )}

      {shareOpen && room && (
        <ShareSheet title={room.title} url={shareUrl} onClose={() => setShareOpen(false)} />
      )}
    </>
  );
}
