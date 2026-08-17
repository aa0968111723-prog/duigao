import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  COLORS,
  VERSION_LABELS,
  type ChatMessage,
  type ColorMode,
  type CommentPin,
  type CompareMode,
  type Guest,
  type Point,
  type ReviewPriority,
  type ReviewType,
  type Room,
  type Stroke,
  type Tool,
  type Version,
  type ViewState,
} from "./lib/types";
import { roomCode, uid } from "./lib/id";
import { listRooms, loadFlag, loadGuest, loadRoom, saveFlag, saveGuest, saveRoom } from "./lib/store";
import { Collab, type CollabStatus } from "./lib/peer";
import { ToastStack, useToasts } from "./toast";
import "./usability.css";

type SaveState = "idle" | "saving" | "saved" | "error";
const COACH_FLAG = "coach.firstPin";

function humanSyncText(status: CollabStatus, peerCount: number): string {
  if (status === "online") return peerCount > 0 ? `已同步 · ${peerCount} 人` : "已同步";
  if (status === "connecting") return "正在同步";
  return "目前離線";
}

function syncBadgeClass(status: CollabStatus): string {
  if (status === "online") return "badge-online";
  if (status === "connecting") return "badge-connecting";
  return "badge-error";
}

const REVIEW_TYPES: ReviewType[] = ["文字", "排版", "圖片", "顏色", "資訊錯誤", "其他"];
const REVIEW_PRIORITIES: ReviewPriority[] = ["一般", "重要", "急"];

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
  const [pinSuggestion, setPinSuggestion] = useState("");
  const [pinType, setPinType] = useState<ReviewType>("文字");
  const [pinPriority, setPinPriority] = useState<ReviewPriority>("一般");
  const [chatInput, setChatInput] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [collabStatus, setCollabStatus] = useState<CollabStatus | null>(null);
  const [peerCount, setPeerCount] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [coachSeen, setCoachSeen] = useState<boolean>(() => loadFlag(COACH_FLAG));

  const { toasts, showToast, dismiss } = useToasts();

  const collabRef = useRef<Collab | null>(null);
  const roomRef = useRef<Room | null>(null);
  const viewRef = useRef<ViewState>(view);
  const saveSeq = useRef(0);
  const busy = useRef<Set<string>>(new Set());
  const offlineNotified = useRef(false);
  const chatInputRef = useRef<HTMLInputElement>(null);
  roomRef.current = room;
  viewRef.current = view;

  const isGuestSession = useMemo(() => readRoomCodeFromUrl() != null, []);

  const markCoachSeen = useCallback(() => {
    setCoachSeen((seen) => {
      if (!seen) saveFlag(COACH_FLAG);
      return true;
    });
  }, []);

  const runOnce = useCallback((key: string, fn: () => void) => {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    try {
      fn();
    } finally {
      window.setTimeout(() => busy.current.delete(key), 450);
    }
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
  }, [guest, applyRemoteRoom, showToast]);

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

  // Apply a change and offer a few-second Undo that restores the prior room.
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

  const startNewRoom = useCallback(() => {
    const r = emptyRoom(roomCode(), "未命名活動");
    setRoom(r);
    setView(initialView(r));
    trackSave(r);
  }, [trackSave]);

  const openRoom = useCallback((r: Room) => {
    setRoom(r);
    setView(initialView(r));
  }, []);

  const addVersions = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (busy.current.has("upload")) return;
      busy.current.add("upload");
      try {
        const current = roomRef.current ?? emptyRoom(roomCode(), "未命名活動");
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
        if (newVersions.length === 0) {
          showToast("這個檔案不是圖片，換一張海報試試。", { tone: "error" });
          return;
        }
        const next: Room = {
          ...current,
          versions: [...current.versions, ...newVersions],
          updatedAt: Date.now(),
        };
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
        showToast(newVersions.length > 1 ? `已新增 ${newVersions.length} 版` : `已新增${added.label}`, {
          tone: "success",
        });
      } finally {
        busy.current.delete("upload");
      }
    },
    [persist, showToast],
  );

  const resetPinDraft = useCallback(() => {
    setDraftPin(null);
    setPinText("");
    setPinSuggestion("");
    setPinType("文字");
    setPinPriority("一般");
  }, []);

  const commitPin = () => {
    if (!draftPin || !guest || !pinText.trim()) {
      resetPinDraft();
      return;
    }
    if (busy.current.has("pin")) return;
    busy.current.add("pin");
    const pin: CommentPin = {
      id: uid("c_"),
      versionId: draftPin.versionId,
      authorId: guest.id,
      authorName: guest.name,
      authorColor: guest.color,
      x: draftPin.x,
      y: draftPin.y,
      body: pinText.trim(),
      suggestion: pinSuggestion.trim(),
      problemType: pinType,
      priority: pinPriority,
      resolved: false,
      createdAt: Date.now(),
    };
    const number = (roomRef.current?.comments.length ?? 0) + 1;
    updateRoom((r) => ({ ...r, comments: [...r.comments, pin] }));
    markCoachSeen();
    resetPinDraft();
    showToast(`已新增修改點 #${number}`, {
      tone: "success",
      action: {
        label: "復原",
        onClick: () => {
          updateRoom((r) => ({ ...r, comments: r.comments.filter((c) => c.id !== pin.id) }));
          showToast("已復原");
        },
      },
    });
    window.setTimeout(() => busy.current.delete("pin"), 450);
  };

  const toggleResolve = (pinId: string) => {
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
      `#${index + 1} ${willResolve ? "已標記完成" : "已重新開啟"}`,
    );
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
    const current = roomRef.current;
    if (!current || !current.strokes.some((s) => s.id === strokeId)) return;
    mutateWithUndo((r) => ({ ...r, strokes: r.strokes.filter((s) => s.id !== strokeId) }), "已刪除圈畫");
  };

  const sendChat = () => {
    if (!guest || !chatInput.trim()) return;
    if (busy.current.has("chat")) return;
    busy.current.add("chat");
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
    window.setTimeout(() => {
      busy.current.delete("chat");
      chatInputRef.current?.focus();
    }, 0);
  };

  const selectPin = useCallback(
    (comment: CommentPin) => {
      setSelectedPinId(comment.id);
      updateView({ ...viewRef.current, versionId: comment.versionId, compareMode: "single" });
    },
    [updateView],
  );

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
      showToast("分享連結已複製", { tone: "success" });
    } catch {
      showToast("複製失敗，請長按連結手動複製。", { tone: "error" });
    }
  };

  const copyReviewSummary = async () => {
    if (!room) return;
    if (room.comments.length === 0) {
      showToast("還沒有修改點可以複製。", { tone: "error" });
      return;
    }
    const openCount = room.comments.filter((c) => !c.resolved).length;
    const lines = room.comments.map((c, index) => {
      const status = c.resolved ? "已完成" : "待修改";
      const type = c.problemType ?? "修改";
      const priority = c.priority ?? "一般";
      const versionLabel = room.versions.find((v) => v.id === c.versionId)?.label ?? "";
      const suggestion = c.suggestion ? `\n   建議：${c.suggestion}` : "";
      return `#${String(index + 1).padStart(2, "0")} [${status}] [${priority}] [${type}] ${versionLabel}\n   問題：${c.body}${suggestion}`;
    });
    const summary = `${room.title}\n共 ${room.comments.length} 個修改點｜待修改 ${openCount}｜已完成 ${room.comments.length - openCount}\n\n${lines.join("\n\n")}`;
    try {
      await navigator.clipboard.writeText(summary);
      showToast("修改清單已複製", { tone: "success" });
    } catch {
      showToast("複製失敗，請再試一次。", { tone: "error" });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (shareOpen) setShareOpen(false);
      else if (draftPin) resetPinDraft();
      else if (selectedPinId) setSelectedPinId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shareOpen, draftPin, selectedPinId, resetPinDraft]);

  const lineShareUrl = useMemo(() => {
    const text = `一起對稿「${room?.title ?? "活動海報"}」： ${shareUrl}`;
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
            {isGuestSession
              ? "夥伴邀你一起對稿。你不需要改設計，只要指出哪裡要改、建議怎麼改。"
              : "把活動海報變成清楚的修改清單，讓團隊只標記、不直接改原稿。"}
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
        <div
          className="brand"
          onClick={() => {
            setRoom(null);
            location.hash = "";
          }}
        >
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
          {saveState !== "idle" && (
            <span className={`save-status save-${saveState}`} title="資料自動保存在這台裝置">
              {saveState === "saving" ? "儲存中…" : saveState === "saved" ? "已儲存" : "儲存失敗"}
            </span>
          )}
          {collabStatus && (
            <span
              className={`badge ${syncBadgeClass(collabStatus)}`}
              title={
                collabStatus === "online"
                  ? "已與其他人同步"
                  : collabStatus === "connecting"
                    ? "正在建立同步連線"
                    : "目前離線，內容已保存在這台裝置"
              }
            >
              {humanSyncText(collabStatus, peerCount)}
            </span>
          )}
          <span className="me" style={{ background: guest.color }} title={guest.name}>
            {guest.name.slice(0, 1)}
          </span>
          {hasVersions && (
            <button className="btn btn-primary" onClick={openShare}>
              分享
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
                    <span className="recent-meta">
                      {r.versions.length} 版 · {new Date(r.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </main>
      ) : (
        <>
          {!coachSeen && (room?.comments.length ?? 0) === 0 && (
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
          <main className="workspace">
            <Viewer
              room={room!}
              view={view}
              tool={tool}
              guest={guest}
              draftPin={draftPin}
              pinText={pinText}
              pinSuggestion={pinSuggestion}
              pinType={pinType}
              pinPriority={pinPriority}
              selectedPinId={selectedPinId}
              onPinTextChange={setPinText}
              onPinSuggestionChange={setPinSuggestion}
              onPinTypeChange={setPinType}
              onPinPriorityChange={setPinPriority}
              onCommitPin={commitPin}
              onCancelPin={resetPinDraft}
              onPlacePin={(versionId, x, y) => {
                setDraftPin({ versionId, x, y });
                setPinText("");
                setPinSuggestion("");
                setPinType("文字");
                setPinPriority("一般");
              }}
              onAddStroke={addStroke}
              onEraseStroke={eraseStroke}
              onSelectPin={selectPin}
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
              chatInputRef={chatInputRef}
              selectedPinId={selectedPinId}
              onChatInput={setChatInput}
              onSendChat={sendChat}
              onToggleResolve={toggleResolve}
              onSelectPin={selectPin}
              onCopySummary={copyReviewSummary}
            />
          </main>
        </>
      )}

      {shareOpen && room && (
        <div className="modal-backdrop" onClick={() => setShareOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>分享這份對稿</h3>
            <p className="modal-hint">
              傳連結給夥伴。大家用手機打開後，只要點出修改位置並寫清楚建議，不會直接改到原稿。
            </p>
            <div className="link-row">
              <input className="text-input" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" onClick={copyLink}>
                複製
              </button>
            </div>
            <a className="btn btn-line" href={lineShareUrl} target="_blank" rel="noreferrer">
              傳到 LINE
            </a>
            <button className="btn btn-ghost" onClick={() => setShareOpen(false)}>
              關閉
            </button>
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function UploadZone({ onFiles, big }: { onFiles: (f: FileList | null) => void; big?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`upload ${big ? "upload-big" : ""} ${drag ? "upload-drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        onFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
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
  pinSuggestion: string;
  pinType: ReviewType;
  pinPriority: ReviewPriority;
  selectedPinId: string | null;
  onPinTextChange: (v: string) => void;
  onPinSuggestionChange: (v: string) => void;
  onPinTypeChange: (v: ReviewType) => void;
  onPinPriorityChange: (v: ReviewPriority) => void;
  onCommitPin: () => void;
  onCancelPin: () => void;
  onPlacePin: (versionId: string, x: number, y: number) => void;
  onAddStroke: (versionId: string, points: Point[]) => void;
  onEraseStroke: (strokeId: string) => void;
  onSelectPin: (comment: CommentPin) => void;
};

function Viewer(props: ViewerProps) {
  const { room, view } = props;
  const primary = room.versions.find((v) => v.id === view.versionId) ?? room.versions[0];
  if (!primary) return null;
  let compare = room.versions.find((v) => v.id === view.compareId) ?? primary;
  if (compare.id === primary.id && room.versions.length >= 2) {
    compare = room.versions.find((v) => v.id !== primary.id) ?? primary;
  }

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
    room,
    view,
    tool,
    version,
    interactive,
    wipeWith,
    draftPin,
    pinText,
    pinSuggestion,
    pinType,
    pinPriority,
    selectedPinId,
    onPinTextChange,
    onPinSuggestionChange,
    onPinTypeChange,
    onPinPriorityChange,
    onCommitPin,
    onCancelPin,
    onPlacePin,
    onAddStroke,
    onEraseStroke,
    onSelectPin,
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
              if (tool === "erase" && interactive) {
                e.stopPropagation();
                onEraseStroke(s.id);
              }
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

      {pins.map((pin) => {
        const number = room.comments.findIndex((item) => item.id === pin.id) + 1;
        const isSelected = selectedPinId === pin.id;
        const dimmed = selectedPinId != null && !isSelected;
        return (
          <button
            key={pin.id}
            className={`pin ${pin.resolved ? "pin-resolved" : ""} ${isSelected ? "pin-selected" : ""} ${dimmed ? "pin-dim" : ""}`}
            style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%`, ["--pin" as string]: pin.authorColor }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelectPin(pin);
            }}
            title={`${pin.authorName}｜${pin.problemType ?? "修改"}｜${pin.body}${pin.suggestion ? `｜建議：${pin.suggestion}` : ""}`}
          >
            <span className="pin-body">#{number} {pin.body}</span>
          </button>
        );
      })}

      {draftPin && draftPin.versionId === version.id && (
        <div
          className="pin-compose"
          style={{
            left: `${draftPin.x * 100}%`,
            top: `${draftPin.y * 100}%`,
            width: "min(310px, calc(100vw - 32px))",
          }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div style={{ display: "grid", gap: 7 }}>
            <select
              className="text-input"
              value={pinType}
              onChange={(e) => onPinTypeChange(e.target.value as ReviewType)}
              aria-label="問題類型"
            >
              {REVIEW_TYPES.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <textarea
              className="pin-input"
              placeholder="哪裡需要改？例如：日期太小，看不清楚"
              value={pinText}
              onChange={(e) => onPinTextChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  onCommitPin();
                }
              }}
              autoFocus
            />
            <textarea
              className="pin-input"
              placeholder="建議怎麼改？例如：日期放大 20%，移到標題下方"
              value={pinSuggestion}
              onChange={(e) => onPinSuggestionChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  onCommitPin();
                }
              }}
            />
            <select
              className="text-input"
              value={pinPriority}
              onChange={(e) => onPinPriorityChange(e.target.value as ReviewPriority)}
              aria-label="優先程度"
            >
              {REVIEW_PRIORITIES.map((item) => (
                <option key={item} value={item}>優先：{item}</option>
              ))}
            </select>
          </div>
          <div className="pin-compose-actions">
            <button className="btn btn-sm" onClick={onCancelPin}>取消</button>
            <button className="btn btn-sm btn-primary" onClick={onCommitPin} disabled={!pinText.trim()}>
              新增修改點
            </button>
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
    { id: "pin", label: "修改點" },
    { id: "draw", label: "圈畫" },
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
  chatInputRef: RefObject<HTMLInputElement | null>;
  selectedPinId: string | null;
  onChatInput: (v: string) => void;
  onSendChat: () => void;
  onToggleResolve: (id: string) => void;
  onSelectPin: (comment: CommentPin) => void;
  onCopySummary: () => void;
};

function SidePanel({
  room,
  chatInput,
  chatInputRef,
  selectedPinId,
  onChatInput,
  onSendChat,
  onToggleResolve,
  onSelectPin,
  onCopySummary,
}: SidePanelProps) {
  const [tab, setTab] = useState<"comments" | "chat">("comments");
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastLocated = useRef<string | null>(null);
  const labelFor = (versionId: string) => room.versions.find((v) => v.id === versionId)?.label ?? "";
  const openCount = room.comments.filter((c) => !c.resolved).length;
  const filteredComments = room.comments.filter((c) => {
    if (filter === "all") return true;
    return filter === "resolved" ? c.resolved : !c.resolved;
  });

  // Locate the selected pin's card: reveal it (switch tab/filter if hidden),
  // scroll it into view and focus it once per selection. Focusing also expands
  // the mobile bottom sheet via mobile.css `.panel:focus-within`.
  useEffect(() => {
    if (!selectedPinId) {
      lastLocated.current = null;
      return;
    }
    setTab("comments");
    const comment = room.comments.find((c) => c.id === selectedPinId);
    if (!comment) return;
    const visible = filter === "all" || (filter === "resolved" ? comment.resolved : !comment.resolved);
    if (!visible) {
      setFilter("all");
      return;
    }
    if (lastLocated.current === selectedPinId) return;
    lastLocated.current = selectedPinId;
    const el = itemRefs.current.get(selectedPinId);
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      el.focus({ preventScroll: true });
    }
  }, [selectedPinId, filter, room.comments]);

  return (
    <aside className="panel">
      <div className="panel-tabs">
        <button className={tab === "comments" ? "on" : ""} onClick={() => setTab("comments")}>
          修改點 {room.comments.length > 0 && <b>{room.comments.length}</b>}
        </button>
        <button className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>
          聊天 {room.messages.length > 0 && <b>{room.messages.length}</b>}
        </button>
      </div>

      {tab === "comments" ? (
        <div className="panel-body">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button
              className={`btn btn-sm ${filter === "open" ? "btn-primary" : ""}`}
              onClick={() => setFilter("open")}
            >
              待修改 {openCount}
            </button>
            <button
              className={`btn btn-sm ${filter === "resolved" ? "btn-primary" : ""}`}
              onClick={() => setFilter("resolved")}
            >
              已完成 {room.comments.length - openCount}
            </button>
            <button
              className={`btn btn-sm ${filter === "all" ? "btn-primary" : ""}`}
              onClick={() => setFilter("all")}
            >
              全部
            </button>
            {room.comments.length > 0 && (
              <button className="btn btn-sm" onClick={onCopySummary}>
                複製清單
              </button>
            )}
          </div>

          {room.comments.length === 0 && (
            <p className="empty">
              還沒有修改意見。<br />選「修改點」，再點文宣上需要調整的位置。
            </p>
          )}
          {room.comments.length > 0 && filteredComments.length === 0 && (
            <p className="empty">
              {filter === "resolved"
                ? "還沒有已完成的修改點。"
                : filter === "open"
                  ? "太好了，目前沒有待修改的項目。"
                  : "這個分類目前沒有修改點。"}
            </p>
          )}

          {filteredComments.map((c) => {
            const number = room.comments.findIndex((item) => item.id === c.id) + 1;
            const isSelected = selectedPinId === c.id;
            return (
              <div
                key={c.id}
                ref={(el) => {
                  if (el) itemRefs.current.set(c.id, el);
                  else itemRefs.current.delete(c.id);
                }}
                tabIndex={-1}
                className={`comment ${c.resolved ? "done" : ""} ${isSelected ? "selected" : ""}`}
                onClick={() => onSelectPin(c)}
                title="點一下在文宣上定位這個修改點"
              >
                <div className="comment-head">
                  <span className="dot" style={{ background: c.authorColor }} />
                  <span className="who">#{number} · {c.authorName}</span>
                  <span className="ver-tag">{labelFor(c.versionId)}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 7 }}>
                  <span className="badge">{c.problemType ?? "修改"}</span>
                  <span className="badge">{c.priority ?? "一般"}</span>
                  <span className={`badge ${c.resolved ? "badge-online" : ""}`}>
                    {c.resolved ? "已完成" : "待修改"}
                  </span>
                </div>
                <div className="comment-body"><strong>問題：</strong>{c.body}</div>
                {c.suggestion && (
                  <div className="comment-body" style={{ marginTop: 6, color: "var(--ink-dim)" }}>
                    <strong style={{ color: "var(--ink)" }}>建議：</strong>{c.suggestion}
                  </div>
                )}
                <button
                  className="resolve"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleResolve(c.id);
                  }}
                >
                  {c.resolved ? "重新開啟" : "標記完成"}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="panel-body">
          {room.messages.length === 0 && (
            <p className="empty">
              還沒有討論。<br />可以直接留言給團隊。
            </p>
          )}
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
            ref={chatInputRef}
            className="text-input"
            placeholder="輸入訊息…"
            value={chatInput}
            onChange={(e) => onChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSendChat();
              }
            }}
          />
          <button className="btn btn-sm btn-primary" onClick={onSendChat} disabled={!chatInput.trim()}>
            送出
          </button>
        </div>
      )}
    </aside>
  );
}
