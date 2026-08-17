import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ColorMode, CompareMode, Tool } from "../lib/types";
import type { CollabStatus } from "../lib/peer";
import { useViewport } from "../hooks/useViewport";
import { DragSheet, ModalSheet, type SheetSnap } from "./BottomSheet";
import { CommentCard } from "./CommentCard";
import { PinFields } from "./PinFields";
import { UploadZone } from "./UploadZone";
import { Viewer } from "./Stage";
import { IconChat, IconEraser, IconEye, IconMore, IconPen, IconPin } from "./icons";
import type { WorkspaceApi } from "./api";

const TOOLS: { id: Tool; label: string; icon: (p: { className?: string }) => ReactElement }[] = [
  { id: "pan", label: "看", icon: IconEye },
  { id: "pin", label: "修改點", icon: IconPin },
  { id: "draw", label: "圈畫", icon: IconPen },
  { id: "erase", label: "擦除", icon: IconEraser },
];

const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: "color", label: "彩色" },
  { id: "gray", label: "黑白" },
  { id: "split", label: "對切" },
];

const COMPARE_MODES: { id: CompareMode; label: string }[] = [
  { id: "single", label: "單張" },
  { id: "side", label: "並排" },
  { id: "wipe", label: "滑動" },
];

type Props = {
  api: WorkspaceApi;
  presence: { status: CollabStatus | null; peers: number };
};

export function MobileWorkspace({ api, presence }: Props) {
  const { room, view, draftPin, selectedPinId, tool } = api;
  const viewportHeight = useViewport();
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [tab, setTab] = useState<"items" | "chat">("items");
  const [more, setMore] = useState(false);
  const [composeInset, setComposeInset] = useState(0);
  const chatRef = useRef<HTMLInputElement>(null);

  const sendChat = () => {
    api.sendChat();
    chatRef.current?.focus();
  };

  const open = room.comments.filter((c) => !c.resolved).length;
  const hasThread = room.comments.length > 0 || room.messages.length > 0;

  // Tapping a pin opens that item, it never resolves it.
  useEffect(() => {
    if (!selectedPinId) return;
    setTab("items");
    setSnap((s) => (s === "peek" ? "half" : s));
    const id = window.setTimeout(() => {
      document.getElementById(`pin-card-${selectedPinId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 220);
    return () => window.clearTimeout(id);
  }, [selectedPinId]);

  useEffect(() => {
    if (draftPin) setSnap("peek");
    else setComposeInset(0);
  }, [draftPin]);

  const showHint = !draftPin && !api.coachSeen && room.comments.length === 0;

  return (
    <div
      className="m-app"
      style={{
        ["--m-peek" as string]: hasThread ? "52px" : "0px",
        ["--m-compose" as string]: `${composeInset}px`,
      }}
    >
      <header className="m-top">
        <button type="button" className="m-home" onClick={api.goHome} aria-label="回到文宣列表">
          <span className="m-home-dot" />
        </button>
        <input
          className="m-title"
          value={room.title}
          onChange={(e) => api.setTitle(e.target.value)}
          aria-label="文宣名稱"
        />
        {api.saveState !== "idle" && (
          <span className={`save-status save-${api.saveState}`} title="資料自動保存在這台裝置">
            {api.saveState === "saving" ? "儲存中…" : api.saveState === "saved" ? "已儲存" : "儲存失敗"}
          </span>
        )}
        {presence.status && (
          <span
            className={`m-presence is-${presence.status}`}
            title={presence.status === "online" ? `${presence.peers} 人同時在線` : "本機模式"}
          />
        )}
        <button type="button" className="m-icon-btn" onClick={() => setMore(true)} aria-label="更多">
          <IconMore />
        </button>
        <button type="button" className="m-share" onClick={api.openShare}>
          分享
        </button>
      </header>

      <div className="m-versions">
        {room.versions.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`m-vchip ${v.id === view.versionId ? "is-on" : ""}`}
            onClick={() => api.setView({ ...view, versionId: v.id, compareMode: "single" })}
          >
            {v.label}
          </button>
        ))}
        <UploadZone onFiles={api.addFiles} className="m-vchip m-vchip-add">
          <span aria-hidden>＋</span>
        </UploadZone>
      </div>

      <div className="m-stage-area">
        <Viewer api={api} compact />
        {showHint && (
          <p className="m-hint">
            {tool === "pin" ? "點文宣上要調整的位置" : "點下方「修改點」，再點文宣上要調整的位置"}
          </p>
        )}
      </div>

      <div className="m-bottom">
        {hasThread && (
          <DragSheet
            snap={snap}
            onSnap={setSnap}
            viewportHeight={viewportHeight}
            handle={
              <span className="m-sheet-summary">
                修改點 {room.comments.length}
                <em>·</em>
                待處理 {open}
              </span>
            }
          >
            <div className="m-sheet-tabs">
              <button type="button" className={tab === "items" ? "is-on" : ""} onClick={() => setTab("items")}>
                修改點
              </button>
              <button type="button" className={tab === "chat" ? "is-on" : ""} onClick={() => setTab("chat")}>
                聊天
              </button>
            </div>

            {tab === "items" ? (
              <div className="m-list">
                {room.comments.length === 0 && <p className="m-empty">還沒有修改點。</p>}
                {room.comments.map((c) => (
                  <CommentCard
                    key={c.id}
                    room={room}
                    pin={c}
                    compact
                    selected={c.id === selectedPinId}
                    onSelect={() => {
                      api.selectPin(c.id);
                      api.setView({ ...view, versionId: c.versionId, compareMode: "single" });
                    }}
                    onToggleResolve={() => api.toggleResolve(c.id)}
                  />
                ))}
              </div>
            ) : (
              <>
                <div className="m-list">
                  {room.messages.length === 0 && <p className="m-empty">還沒有訊息。</p>}
                  {room.messages.map((m) => (
                    <div key={m.id} className="m-msg">
                      <span className="m-msg-who" style={{ color: m.authorColor }}>
                        {m.authorName}
                      </span>
                      <p>{m.body}</p>
                    </div>
                  ))}
                </div>
                <div className="m-chatbar">
                  <input
                    ref={chatRef}
                    className="m-input"
                    placeholder="說點什麼…"
                    value={api.chatInput}
                    onChange={(e) => api.setChatInput(e.target.value)}
                    onFocus={() => setSnap("full")}
                    enterKeyHint="send"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        sendChat();
                      }
                    }}
                  />
                  <button type="button" className="m-btn m-btn-primary" onClick={sendChat} disabled={!api.chatInput.trim()}>
                    送出
                  </button>
                </div>
              </>
            )}
          </DragSheet>
        )}

        <nav className="m-toolbar" aria-label="主要操作">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                className={`m-tool ${tool === t.id ? "is-on" : ""} ${t.id === "pin" ? "is-primary" : ""}`}
                onClick={() => api.setTool(t.id)}
                aria-pressed={tool === t.id}
              >
                <Icon />
                <span>{t.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="m-tool"
            onClick={() => setSnap((s) => (s === "peek" ? "half" : "peek"))}
          >
            <span className="m-tool-badge-wrap">
              <IconChat />
              {open > 0 && <span className="m-tool-badge">{open}</span>}
            </span>
            <span>討論</span>
          </button>
        </nav>
      </div>

      {draftPin && (
        <ModalSheet
          title={`修改點 ${room.comments.length + 1}`}
          onClose={api.cancelPin}
          dismissible={!api.form.body.trim()}
          onHeight={setComposeInset}
          action={
            <button type="button" className="m-btn m-btn-primary m-btn-block" onClick={api.commitPin} disabled={!api.form.body.trim()}>
              送出修改點
            </button>
          }
        >
          <PinFields api={api} autoFocus />
        </ModalSheet>
      )}

      {more && (
        <ModalSheet title="更多" onClose={() => setMore(false)}>
          <div className="m-more">
            <div className="m-more-group">
              <span className="m-more-label">顯示</span>
              <div className="m-chiprow">
                {COLOR_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`m-chip ${view.colorMode === m.id ? "is-on" : ""}`}
                    onClick={() => api.setView({ ...view, colorMode: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="m-more-group">
              <span className="m-more-label">比較</span>
              <div className="m-chiprow">
                {COMPARE_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`m-chip ${view.compareMode === m.id ? "is-on" : ""}`}
                    disabled={m.id !== "single" && room.versions.length < 2}
                    onClick={() => api.setView({ ...view, compareMode: m.id })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {view.compareMode !== "single" && room.versions.length >= 2 && (
                <div className="m-chiprow">
                  {room.versions
                    .filter((v) => v.id !== view.versionId)
                    .map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        className={`m-chip ${view.compareId === v.id ? "is-on" : ""}`}
                        onClick={() => api.setView({ ...view, compareId: v.id })}
                      >
                        對照 {v.label}
                      </button>
                    ))}
                </div>
              )}
              {view.compareMode === "wipe" && room.versions.length >= 2 && (
                <input
                  className="m-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={view.wipe}
                  onChange={(e) => api.setView({ ...view, wipe: Number(e.target.value) })}
                  aria-label="滑動比較位置"
                />
              )}
            </div>

            <UploadZone onFiles={api.addFiles} className="m-row">
              加一個版本
            </UploadZone>
            {room.comments.length > 0 && (
              <button type="button" className="m-row" onClick={api.copySummary}>
                複製修改清單
              </button>
            )}
          </div>
        </ModalSheet>
      )}
    </div>
  );
}
