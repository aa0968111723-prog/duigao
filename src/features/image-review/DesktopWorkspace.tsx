import { useEffect, useRef, useState } from "react";
import type { ColorMode, CompareMode, Tool } from "../../lib/types";
import { ProposalControls } from "../visual-proposal/ProposalControls";
import { pruneProposalVersions } from "../visual-proposal/store";
import { CommentCard } from "../discussion/CommentCard";
import { PinFields } from "../discussion/PinFields";
import { UploadZone } from "../../components/UploadZone";
import { Viewer } from "./Stage";
import { nextPinNumber, type WorkspaceApi } from "../../components/api";

const TOOLS: { id: Tool; label: string }[] = [
  { id: "pan", label: "看" },
  { id: "pin", label: "修改點" },
  { id: "draw", label: "圈畫" },
  { id: "erase", label: "擦掉" },
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

/** Desktop keeps the familiar three-pane layout: stage, toolbar, side panel. */
export function DesktopWorkspace({ api }: { api: WorkspaceApi }) {
  const { room, view, tool, draftPin } = api;

  useEffect(() => {
    pruneProposalVersions(
      room.id,
      room.versions.map((v) => v.id),
    );
  }, [room.id, room.versions]);

  return (
    <main className="workspace">
      <Viewer api={api} />

      <div className="toolbar">
        <div className="versions">
          {room.versions.map((v) => (
            <button
              key={v.id}
              className={`chip ${v.id === view.versionId ? "chip-on" : ""}`}
              onClick={() => {
                api.selectPin(null);
                api.setView({ ...view, versionId: v.id });
              }}
            >
              {v.label}
            </button>
          ))}
          <UploadZone onFiles={api.addFiles} className="upload upload-inline">
            <span className="upload-icon">＋</span>
            <span className="upload-text">加一版</span>
          </UploadZone>
        </div>

        <div className="tool-group">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`seg ${tool === t.id ? "seg-on" : ""}`}
              onClick={() => {
                api.setTool(t.id);
                if (t.id === "pan") api.selectPin(null);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="tool-group">
          {COLOR_MODES.map((m) => (
            <button
              key={m.id}
              className={`seg ${view.colorMode === m.id ? "seg-on" : ""}`}
              onClick={() => api.setView({ ...view, colorMode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="tool-group">
          {COMPARE_MODES.map((m) => (
            <button
              key={m.id}
              className={`seg ${view.compareMode === m.id ? "seg-on" : ""}`}
              disabled={m.id !== "single" && room.versions.length < 2}
              onClick={() => api.setView({ ...view, compareMode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>

        {view.compareMode !== "single" && room.versions.length >= 2 && (
          <select
            className="compare-select"
            value={view.compareId}
            onChange={(e) => api.setView({ ...view, compareId: e.target.value })}
          >
            {room.versions.map((v) => (
              <option key={v.id} value={v.id}>
                對照：{v.label}
              </option>
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
            onChange={(e) => api.setView({ ...view, wipe: Number(e.target.value) })}
          />
        )}

        <details className="proposal-desktop-wrap">
          <summary
            className="btn btn-sm"
            onClick={() => {
              api.setTool("pan");
              api.selectPin(null);
            }}
          >
            視覺提案
          </summary>
          <div className="proposal-desktop-popover">
            <ProposalControls
              roomId={room.id}
              versionId={view.versionId}
              author={api.guest}
              showToast={api.showToast}
              pref={{
                prefs: room.proposalPrefs ?? [],
                userId: api.guest.id,
                onChoose: (choice) => api.setProposalPref(view.versionId, choice),
              }}
            />
          </div>
        </details>

        <button className="btn btn-sm" onClick={api.undo} disabled={!api.canUndo}>
          復原
        </button>
      </div>

      <SidePanel api={api} />

      {draftPin && (
        <div className="compose-backdrop" onPointerDown={() => !api.form.body.trim() && api.cancelPin()}>
          <div className="compose-card" onPointerDown={(e) => e.stopPropagation()}>
            <h3>修改點 {nextPinNumber(room, draftPin.versionId)}</h3>
            <PinFields api={api} autoFocus />
            <div className="compose-actions">
              <button className="btn" onClick={api.cancelPin}>
                取消
              </button>
              <button className="btn btn-primary" onClick={api.commitPin} disabled={!api.form.body.trim()}>
                送出修改點
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function SidePanel({ api }: { api: WorkspaceApi }) {
  const { room } = api;
  const [tab, setTab] = useState<"comments" | "chat">("comments");
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const chatRef = useRef<HTMLInputElement>(null);

  const sendChat = () => {
    api.sendChat();
    chatRef.current?.focus();
  };
  const openCount = room.comments.filter((c) => !c.resolved).length;
  const filtered = room.comments.filter((c) =>
    filter === "all" ? true : filter === "resolved" ? c.resolved : !c.resolved,
  );

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
          <div className="filter-row">
            <button className={`btn btn-sm ${filter === "open" ? "btn-primary" : ""}`} onClick={() => setFilter("open")}>
              待修改 {openCount}
            </button>
            <button
              className={`btn btn-sm ${filter === "resolved" ? "btn-primary" : ""}`}
              onClick={() => setFilter("resolved")}
            >
              已完成 {room.comments.length - openCount}
            </button>
            <button className={`btn btn-sm ${filter === "all" ? "btn-primary" : ""}`} onClick={() => setFilter("all")}>
              全部
            </button>
            {room.comments.length > 0 && (
              <button className="btn btn-sm" onClick={api.copySummary}>
                複製清單
              </button>
            )}
          </div>

          {room.comments.length === 0 && (
            <p className="empty">
              還沒有修改意見。
              <br />
              選「修改點」，再點文宣上需要調整的位置。
            </p>
          )}
          {room.comments.length > 0 && filtered.length === 0 && (
            <p className="empty">
              {filter === "resolved"
                ? "還沒有已完成的修改點。"
                : filter === "open"
                  ? "太好了，目前沒有待修改的項目。"
                  : "這個分類目前沒有修改點。"}
            </p>
          )}

          {filtered.map((c) => (
            <CommentCard
              key={c.id}
              api={api}
              pin={c}
              selected={c.id === api.selectedPinId}
              onSelect={() => {
                api.setTool("pan");
                api.selectPin(c.id);
                api.setView({ ...api.view, versionId: c.versionId, compareMode: "single" });
              }}
              onToggleResolve={() => api.toggleResolve(c.id)}
            />
          ))}
        </div>
      ) : (
        <>
          <div className="panel-body">
            {room.messages.length === 0 && (
              <p className="empty">
                還沒有討論。
                <br />
                可以直接留言給團隊。
              </p>
            )}
            {room.messages.map((m) => (
              <div key={m.id} className="m-msg">
                <span className="m-msg-who" style={{ color: m.authorColor }}>
                  {m.authorName}
                </span>
                <p>{m.body}</p>
              </div>
            ))}
          </div>
          <div className="chat-input">
            <input
              ref={chatRef}
              className="text-input"
              placeholder="輸入訊息…"
              value={api.chatInput}
              onChange={(e) => api.setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendChat();
                }
              }}
            />
            <button className="btn btn-sm btn-primary" onClick={sendChat} disabled={!api.chatInput.trim()}>
              送出
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
