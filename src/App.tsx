import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  COLORS,
  VERSION_LABELS,
  type ChatMessage,
  type ColorMode,
  type CommentPin,
  type CompareMode,
  type Guest,
  type PeerMsg,
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

function pickColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function emptyRoom(id: string, title: string): Room {
  return {
    id,
    title,
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
  return {
    versionId: first,
    compareId: second,
    colorMode: "color",
    compareMode: "single",
    split: 0.5,
    wipe: 0.5,
  };
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
  const [draftPin, setDraftPin] = useState<{ versionId: string; x: number; y: number } | null>(null);
  const [pinText, setPinText] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [collabStatus, setCollabStatus] = useState<CollabStatus | null>(null);
  const [peerCount, setPeerCount] = useState(0);

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

  const startNewRoom = useCallback(() => {
    const r = emptyRoom(roomCode(), "未命名活動");
    setRoom(r);
    setView(initialView(r));
    saveRoom(r).catch(() => undefined);
  }, []);

  const openRoom = useCallback((r: Room) => {
    setRoom(r);
    setView(initialView(r));
  }, []);

  const addVersions = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      let current = roomRef.current ?? emptyRoom(roomCode(), "未命名活動");
      const created = !roomRef.current;
      const newVersions: Version[] = [];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const dataUrl = await fileToDataUrl(file);
        const idx = current.versions.length + newVersions.length;
        newVersions.push({
          id: uid("v_"),
          label: VERSION_LABELS[idx] ?? `改${idx}`,
          imageDataUrl: dataUrl,
        });
      }
      if (newVersions.length === 0) return;
      const next: Room = {
        ...current,
        versions: [...current.versions, ...newVersions],
        updatedAt: Date.now(),
      };
      setRoom(next);
      setView((v) => {
        if (created || !v.versionId) return initialView(next);
        return v;
      });
      persist(next);
    },
    [persist],
  );

  const commitPin = () => {
    if (!draftPin || !guest || !pinText.trim()) {
      setDraftPin(null);
      setPinText("");
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
      body: pinText.trim(),
      resolved: false,
      createdAt: Date.now(),
    };
    updateRoom((r) => ({ ...r, comments: [...r.comments, pin] }));
    setDraftPin(null);
    setPinText("");
  };

  const toggleResolve = (pinId: string) => {
    updateRoom((r) => ({
      ...r,
      comments: r.comments.map((c) => (c.id === pinId ? { ...c, resolved: !c.resolved } : c)),
    }));
  };

  const addStroke = (versionId: string, points: Point[]) => {
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
  };

  const eraseStroke = (strokeId: string) => {
    updateRoom((r) => ({ ...r, strokes: r.strokes.filter((s) => s.id !== strokeId) }));
  };

  const sendChat = () => {
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
  };

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
          collab.sendTo(conn, {
            t: "snapshot",
            room: roomRef.current!,
            view: viewRef.current,
          });
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

  const openShare = () => {
    if (!room) return;
    startHosting();
    setShareOpen(true);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      /* clipboard may be blocked; user can copy manually */
    }
  };

  const lineShareUrl = useMemo(() => {
    const text = `一起看「${room?.title ?? "活動海報"}」： ${shareUrl}`;
    return `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
  }, [room, shareUrl]);

  if (!guest) {
    return (
      <div className="onboard">
        <div className="onboard-card">
          <div className="brand">
            <span className="brand-dot" />對稿
          </div>
          <p className="onboard-hint">
            {isGuestSession ? "夥伴邀你一起看海報，輸入名字加入。" : "把活動海報變成一條連結，傳給夥伴一起看。"}
          </p>
          <input
            className="text-input"
            placeholder="你的名字"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmName()}
            autoFocus
          />
          <button className="btn btn-primary" onClick={confirmName} disabled={!nameInput.trim()}>
            進入
          </button>
        </div>
      </div>
    );
  }

  const hasRoom = room != null;
  const hasVersions = (room?.versions.length ?? 0) > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => { setRoom(null); location.hash = ""; }}>
          <span className="brand-dot" />對稿
        </div>
        {hasRoom && (
          <input
            className="title-input"
            value={room!.title}
            onChange={(e) => updateRoom((r) => ({ ...r, title: e.target.value }))}
            aria-label="活動名稱"
          />
        )}
        <div className="topbar-right">
          {collabStatus && (
            <span className={`badge badge-${collabStatus}`}>
              {collabStatus === "online" ? `連線中 · ${peerCount} 人` : collabStatus === "connecting" ? "連線中…" : collabStatus === "error" ? "本機模式" : "已關閉"}
            </span>
          )}
          <span className="me" style={{ background: guest.color }} title={guest.name}>
            {guest.name.slice(0, 1)}
          </span>
          {hasVersions && (
            <button className="btn btn-primary" onClick={openShare}>
              建立連結
            </button>
          )}
        </div>
      </header>

      {!hasVersions ? (
        <main className="landing">
          <UploadZone onFiles={addVersions} big />
          {!isGuestSession && recent.length > 0 && (
            <div className="recent">
              <div className="recent-title">最近的活動</div>
              <div className="recent-list">
                {recent.map((r) => (
                  <button key={r.id} className="recent-item" onClick={() => openRoom(r)}>
                    <span className="recent-name">{r.title}</span>
                    <span className="recent-meta">{r.versions.length} 版 · {new Date(r.updatedAt).toLocaleDateString()}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </main>
      ) : (
        <main className="workspace">
          <Viewer
            room={room!}
            view={view}
            tool={tool}
            guest={guest}
            draftPin={draftPin}
            pinText={pinText}
            onPinTextChange={setPinText}
            onCommitPin={commitPin}
            onCancelPin={() => { setDraftPin(null); setPinText(""); }}
            onPlacePin={(versionId, x, y) => { setDraftPin({ versionId, x, y }); setPinText(""); }}
            onAddStroke={addStroke}
            onEraseStroke={eraseStroke}
            onToggleResolve={toggleResolve}
          />

          <Toolbar
            room={room!}
            view={view}
            tool={tool}
            onTool={setTool}
            onView={updateView}
            onAddFiles={addVersions}
          />

          <SidePanel
            room={room!}
            chatInput={chatInput}
            onChatInput={setChatInput}
            onSendChat={sendChat}
            onToggleResolve={toggleResolve}
            onFocusVersion={(vid) => updateView({ ...view, versionId: vid, compareMode: "single" })}
          />
        </main>
      )}

      {shareOpen && room && (
        <div className="modal-backdrop" onClick={() => setShareOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>分享這份對稿</h3>
            <p className="modal-hint">傳連結給夥伴，大家用手機打開就能一起看、留言。</p>
            <div className="link-row">
              <input className="text-input" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" onClick={copyLink}>複製</button>
            </div>
            <a className="btn btn-line" href={lineShareUrl} target="_blank" rel="noreferrer">
              傳到 LINE
            </a>
            <button className="btn btn-ghost" onClick={() => setShareOpen(false)}>關閉</button>
          </div>
        </div>
      )}
    </div>
  );
}

function UploadZone({ onFiles, big }: { onFiles: (f: FileList | null) => void; big?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`upload ${big ? "upload-big" : ""} ${drag ? "upload-drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }}
      />
      <div className="upload-icon">＋</div>
      <div className="upload-text">{big ? "上傳活動海報" : "加一版"}</div>
      {big && <div className="upload-sub">支援多版本：初稿、改一、改二…</div>}
    </div>
  );
}

type ViewerProps = {
  room: Room;
  view: ViewState;
  tool: Tool;
  guest: Guest;
  draftPin: { versionId: string; x: number; y: number } | null;
  pinText: string;
  onPinTextChange: (v: string) => void;
  onCommitPin: () => void;
  onCancelPin: () => void;
  onPlacePin: (versionId: string, x: number, y: number) => void;
  onAddStroke: (versionId: string, points: Point[]) => void;
  onEraseStroke: (strokeId: string) => void;
  onToggleResolve: (pinId: string) => void;
};

function Viewer(props: ViewerProps) {
  const { room, view } = props;
  const primary = room.versions.find((v) => v.id === view.versionId) ?? room.versions[0];
  const compare = room.versions.find((v) => v.id === view.compareId) ?? primary;
  if (!primary) return null;

  if (view.compareMode === "side") {
    return (
      <div className="stage-wrap stage-side">
        <Stage {...props} version={primary} interactive />
        <Stage {...props} version={compare} interactive={false} />
      </div>
    );
  }

  if (view.compareMode === "wipe") {
    return (
      <div className="stage-wrap">
        <Stage {...props} version={primary} interactive wipeWith={compare} />
      </div>
    );
  }

  return (
    <div className="stage-wrap">
      <Stage {...props} version={primary} interactive />
    </div>
  );
}

type StageProps = ViewerProps & {
  version: Version;
  interactive: boolean;
  wipeWith?: Version;
};

function Stage(props: StageProps) {
  const {
    room, view, tool, version, interactive, wipeWith,
    draftPin, pinText, onPinTextChange, onCommitPin, onCancelPin, onPlacePin,
    onAddStroke, onEraseStroke, onToggleResolve,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<Point[]>([]);
  const drawing = useRef(false);

  const pins = room.comments.filter((c) => c.versionId === version.id);
  const strokes = room.strokes.filter((s) => s.versionId === version.id);

  const relative = (e: ReactPointerEvent): Point => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onDown = (e: ReactPointerEvent) => {
    if (!interactive) return;
    const p = relative(e);
    if (tool === "pin") {
      onPlacePin(version.id, p.x, p.y);
    } else if (tool === "draw") {
      drawing.current = true;
      setLive([p]);
      ref.current?.setPointerCapture(e.pointerId);
    }
  };

  const onMove = (e: ReactPointerEvent) => {
    if (!interactive || !drawing.current) return;
    setLive((pts) => [...pts, relative(e)]);
  };

  const onUp = (e: ReactPointerEvent) => {
    if (!interactive || !drawing.current) return;
    drawing.current = false;
    const pts = [...live, relative(e)];
    setLive([]);
    onAddStroke(version.id, pts);
  };

  const toPolyline = (pts: Point[]) => pts.map((p) => `${p.x * 100},${p.y * 100}`).join(" ");

  const colorClass = `stage-img mode-${view.colorMode}`;

  return (
    <div
      ref={ref}
      className={`stage tool-${tool} ${interactive ? "is-interactive" : ""}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <img className={colorClass} src={version.imageDataUrl} alt={version.label} draggable={false} />
      {view.colorMode === "split" && (
        <img className="stage-img split-gray" src={version.imageDataUrl} alt="" draggable={false} />
      )}
      {wipeWith && wipeWith.id !== version.id && (
        <img
          className="stage-img wipe-top"
          src={wipeWith.imageDataUrl}
          alt={wipeWith.label}
          draggable={false}
          style={{ clipPath: `inset(0 0 0 ${view.wipe * 100}%)` }}
        />
      )}

      <svg className="overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
        {strokes.map((s) => (
          <polyline
            key={s.id}
            points={toPolyline(s.points)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className={tool === "erase" && interactive ? "stroke-erasable" : ""}
            onPointerDown={(e) => {
              if (tool === "erase" && interactive) { e.stopPropagation(); onEraseStroke(s.id); }
            }}
          />
        ))}
        {live.length > 1 && (
          <polyline
            points={toPolyline(live)}
            fill="none"
            stroke={props.guest.color}
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {pins.map((pin) => (
        <button
          key={pin.id}
          className={`pin ${pin.resolved ? "pin-resolved" : ""}`}
          style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, ["--pin" as string]: pin.authorColor }}
          onClick={(e) => { e.stopPropagation(); onToggleResolve(pin.id); }}
          title={`${pin.authorName}: ${pin.body}`}
        >
          <span className="pin-body">{pin.body}</span>
        </button>
      ))}

      {draftPin && draftPin.versionId === version.id && (
        <div
          className="pin-compose"
          style={{ left: `${draftPin.x * 100}%`, top: `${draftPin.y * 100}%` }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <textarea
            className="pin-input"
            placeholder="留言…"
            value={pinText}
            onChange={(e) => onPinTextChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onCommitPin(); } }}
            autoFocus
          />
          <div className="pin-compose-actions">
            <button className="btn btn-sm" onClick={onCancelPin}>取消</button>
            <button className="btn btn-sm btn-primary" onClick={onCommitPin}>釘上</button>
          </div>
        </div>
      )}

      <span className="stage-label">{version.label}</span>
    </div>
  );
}

type ToolbarProps = {
  room: Room;
  view: ViewState;
  tool: Tool;
  onTool: (t: Tool) => void;
  onView: (v: ViewState) => void;
  onAddFiles: (f: FileList | null) => void;
};

function Toolbar({ room, view, tool, onTool, onView, onAddFiles }: ToolbarProps) {
  const tools: { id: Tool; label: string }[] = [
    { id: "pan", label: "看" },
    { id: "pin", label: "留言" },
    { id: "draw", label: "塗鴉" },
    { id: "erase", label: "擦掉" },
  ];
  const colorModes: { id: ColorMode; label: string }[] = [
    { id: "color", label: "彩色" },
    { id: "gray", label: "黑白" },
    { id: "split", label: "對切" },
  ];
  const compareModes: { id: CompareMode; label: string }[] = [
    { id: "single", label: "單張" },
    { id: "side", label: "並排" },
    { id: "wipe", label: "滑動" },
  ];

  return (
    <div className="toolbar">
      <div className="versions">
        {room.versions.map((v) => (
          <button
            key={v.id}
            className={`chip ${v.id === view.versionId ? "chip-on" : ""}`}
            onClick={() => onView({ ...view, versionId: v.id })}
          >
            {v.label}
          </button>
        ))}
        <UploadZone onFiles={onAddFiles} />
      </div>

      <div className="tool-group">
        {tools.map((t) => (
          <button key={t.id} className={`seg ${tool === t.id ? "seg-on" : ""}`} onClick={() => onTool(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="tool-group">
        {colorModes.map((m) => (
          <button
            key={m.id}
            className={`seg ${view.colorMode === m.id ? "seg-on" : ""}`}
            onClick={() => onView({ ...view, colorMode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="tool-group">
        {compareModes.map((m) => (
          <button
            key={m.id}
            className={`seg ${view.compareMode === m.id ? "seg-on" : ""}`}
            disabled={m.id !== "single" && room.versions.length < 2}
            onClick={() => onView({ ...view, compareMode: m.id })}
          >
            {m.label}
          </button>
        ))}
      </div>

      {view.compareMode !== "single" && room.versions.length >= 2 && (
        <select
          className="compare-select"
          value={view.compareId}
          onChange={(e) => onView({ ...view, compareId: e.target.value })}
        >
          {room.versions.map((v) => (
            <option key={v.id} value={v.id}>對照：{v.label}</option>
          ))}
        </select>
      )}

      {view.compareMode === "wipe" && (
        <input
          className="wipe-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={view.wipe}
          onChange={(e) => onView({ ...view, wipe: Number(e.target.value) })}
        />
      )}
    </div>
  );
}

type SidePanelProps = {
  room: Room;
  chatInput: string;
  onChatInput: (v: string) => void;
  onSendChat: () => void;
  onToggleResolve: (id: string) => void;
  onFocusVersion: (versionId: string) => void;
};

function SidePanel({ room, chatInput, onChatInput, onSendChat, onToggleResolve, onFocusVersion }: SidePanelProps) {
  const [tab, setTab] = useState<"comments" | "chat">("comments");
  const labelFor = (versionId: string) => room.versions.find((v) => v.id === versionId)?.label ?? "";

  return (
    <aside className="panel">
      <div className="panel-tabs">
        <button className={tab === "comments" ? "on" : ""} onClick={() => setTab("comments")}>
          留言 {room.comments.length > 0 && <b>{room.comments.length}</b>}
        </button>
        <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
          聊天 {room.messages.length > 0 && <b>{room.messages.length}</b>}
        </button>
      </div>

      {tab === "comments" ? (
        <div className="panel-body">
          {room.comments.length === 0 && <p className="empty">用「留言」工具點在海報上留下想法。</p>}
          {room.comments.map((c) => (
            <div key={c.id} className={`comment ${c.resolved ? "done" : ""}`}>
              <div className="comment-head">
                <span className="dot" style={{ background: c.authorColor }} />
                <span className="who">{c.authorName}</span>
                <button className="ver-tag" onClick={() => onFocusVersion(c.versionId)}>{labelFor(c.versionId)}</button>
              </div>
              <div className="comment-body">{c.body}</div>
              <button className="resolve" onClick={() => onToggleResolve(c.id)}>
                {c.resolved ? "重開" : "完成"}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel-body">
          {room.messages.length === 0 && <p className="empty">還沒有訊息，說點什麼吧。</p>}
          {room.messages.map((m) => (
            <div key={m.id} className="msg">
              <span className="dot" style={{ background: m.authorColor }} />
              <div>
                <div className="who">{m.authorName}</div>
                <div className="msg-body">{m.body}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "chat" && (
        <div className="chat-input">
          <input
            className="text-input"
            placeholder="輸入訊息…"
            value={chatInput}
            onChange={(e) => onChatInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSendChat()}
          />
          <button className="btn btn-sm btn-primary" onClick={onSendChat}>送出</button>
        </div>
      )}
    </aside>
  );
}
