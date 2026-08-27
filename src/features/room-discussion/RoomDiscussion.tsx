import { useMemo, useState } from "react";
import type { Guest, Room, RoomPoll } from "../../lib/types";
import { VOICE_ROOM_MVP, voiceUnavailableReason } from "../collaboration/voice";
import type { DecisionRecord, DiscussionMessage, DiscussionSupport, Whiteboard } from "../collaboration/types";
import "./discussion.css";

export type RoomDiscussionApi = {
  room: Room;
  guest: Guest;
  userId: string;
  canManage: boolean;
  canTalk: boolean;
  messages: DiscussionMessage[];
  supports: DiscussionSupport[];
  decisions: DecisionRecord[];
  boards: Whiteboard[];
  draft: string;
  setDraft: (value: string) => void;
  onSend: (input?: { body?: string; kind?: DiscussionMessage["kind"]; payload?: DiscussionMessage["payload"]; replyToId?: string }) => void;
  onSupport: (messageId: string, add: boolean) => void;
  onCreatePoll: (question: string, options: string[]) => void;
  onAddToBoard: (message: DiscussionMessage, whiteboardId: string) => void;
  onOpenBoardNode: (whiteboardId: string, nodeId?: string) => void;
  onCreateDecision: (title: string) => void;
  onFinalizeDecision: (id: string) => void;
  onOpenContent?: (branchId: string) => void;
  hideTabs?: boolean;
  pane?: "chat" | "board";
  /** 每則訊息的送出狀態（sending/failed）；來自 App 的 outbox。 */
  sendStates?: Record<string, "sending" | "failed">;
  /** 失敗訊息的重試（id 冪等，duplicate-key 視為成功）。 */
  onRetry?: (messageId: string) => void;
  /** 決定條預設顯示；single 房 drawer 對 reviewer 關閉。 */
  showDecisions?: boolean;
  /** 白板/投票等房間層動作；single 房 drawer 對 reviewer 關閉。 */
  showRoomActions?: boolean;
};

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-Hant", { hour: "2-digit", minute: "2-digit" });
}

function PollMini({ poll, room }: { poll: RoomPoll; room: Room }) {
  const count = (room.pollVotes ?? []).filter((vote) => vote.pollId === poll.id).length;
  return <div className="rd-ref">{poll.question} · {count} 人已投</div>;
}

export function RoomDiscussion({ api }: { api: RoomDiscussionApi }) {
  const [pane, setPane] = useState<"chat" | "board">(api.pane ?? "chat");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [boardPick, setBoardPick] = useState<DiscussionMessage | null>(null);
  const [reply, setReply] = useState<DiscussionMessage | null>(null);

  const showDecisions = api.showDecisions ?? true;
  const showRoomActions = api.showRoomActions ?? true;
  const decided = api.decisions.filter((item) => item.status === "decided");
  const pending = api.decisions.filter((item) => item.status === "pending");
  const openPolls = (api.room.polls ?? []).filter((poll) => !poll.closedAt);

  const messages = useMemo(
    () => [...api.messages].sort((a, b) => a.createdAt - b.createdAt),
    [api.messages],
  );

  if ((api.pane ?? pane) === "board") {
    return null;
  }

  return (
    <div className="rd-shell" data-testid="room-discussion">
      {!api.hideTabs && (
      <div className="rd-tabs" role="tablist" aria-label="討論">
        <button type="button" className={pane === "chat" ? "is-active" : ""} onClick={() => setPane("chat")}>對話</button>
        <button type="button" onClick={() => setPane("board")}>白板</button>
      </div>
      )}

      {/* 語音在 provider 落地前是一行不可互動的說明，不佔 pane（Grok pr00 F1）。 */}
      <div className="rd-voice-note" data-testid="voice-boundary">
        {VOICE_ROOM_MVP ? "語音已開啟" : voiceUnavailableReason()}
      </div>

      {showDecisions && (
      <section className="rd-decisions" data-testid="decision-area">
        <div>
          <div className="project-section-title-row"><h3>已決定</h3><span>{decided.length}</span></div>
          {decided.map((item) => (
            <article className="rd-decision is-done" key={item.id} data-testid={`decision-${item.id}`}>
              <strong>✓ {item.title}</strong>
              {item.body ? <p>{item.body}</p> : null}
            </article>
          ))}
          {!decided.length && <p className="project-muted">還沒有收斂的決定</p>}
        </div>
        <div>
          <div className="project-section-title-row">
            <h3>待決定</h3>
            {api.canManage && <button type="button" className="project-text-button" onClick={() => api.onCreateDecision("待決定：主視覺")}>＋</button>}
          </div>
          {pending.map((item) => (
            <article className="rd-decision" key={item.id} data-testid={`decision-${item.id}`}>
              <strong>{item.title}</strong>
              {api.canManage && <button type="button" className="project-text-button" onClick={() => api.onFinalizeDecision(item.id)}>標成已決定</button>}
            </article>
          ))}
          {openPolls.map((poll) => <PollMini key={poll.id} poll={poll} room={api.room} />)}
          {!pending.length && !openPolls.length && <p className="project-muted">目前沒有待決定</p>}
        </div>
      </section>
      )}

      <div className="rd-feed" data-testid="discussion-feed">
        {messages.map((message) => {
          const supportCount = api.supports.filter((item) => item.messageId === message.id).length;
          const supported = api.supports.some((item) => item.messageId === message.id && item.userId === api.userId);
          const sendState = api.sendStates?.[message.id];
          return (
            <article
              className={`rd-msg${sendState === "sending" ? " is-sending" : ""}${sendState === "failed" ? " is-failed" : ""}`}
              key={message.id}
              data-testid={`discussion-${message.id}`}
              onContextMenu={(event) => { event.preventDefault(); setMenuId(message.id); }}
            >
              <header>
                <span className="rd-dot" style={{ background: message.authorColor }} />
                <b>{message.authorName}</b>
                <time>{timeLabel(message.createdAt)}</time>
              </header>
              <p>{message.body}</p>
              {message.payload.quotedBody ? <div className="rd-quote">{message.payload.quotedBody}</div> : null}
              {(message.kind === "whiteboard" || message.kind === "node") && (
                <button type="button" className="rd-ref" onClick={() => api.onOpenBoardNode(message.payload.whiteboardId ?? "", message.payload.nodeId)}>
                  {message.payload.title ?? "打開白板"}
                </button>
              )}
              {(message.kind === "poster" || message.kind === "video" || message.kind === "plan") && message.payload.branchId && (
                <button type="button" className="rd-ref" onClick={() => api.onOpenContent?.(message.payload.branchId!)}>
                  {message.payload.title ?? "房間內容"}
                </button>
              )}
              {sendState === "failed" && api.onRetry && (
                <button type="button" className="rd-retry" data-testid="discussion-retry" onClick={() => api.onRetry?.(message.id)}>
                  未送出 · 重試
                </button>
              )}
              <div className="rd-actions">
                <button type="button" onClick={() => setReply(message)}>回覆</button>
                <button type="button" onClick={() => api.onSupport(message.id, !supported)}>支持{supportCount ? ` ${supportCount}` : ""}</button>
                {showRoomActions && api.canManage && <button type="button" onClick={() => api.onCreatePoll(message.body || "要不要這樣做？", ["贊成", "再想想"])}>建立投票</button>}
                {showRoomActions && <button type="button" onClick={() => setBoardPick(message)}>加入白板</button>}
              </div>
              {menuId === message.id && showRoomActions && (
                <div className="rd-actions">
                  <button type="button" onClick={() => { setBoardPick(message); setMenuId(null); }}>加入白板</button>
                </div>
              )}
            </article>
          );
        })}
        {!messages.length && <p className="project-muted">先留一句房間層級的討論。文宣圈選和影片時間點回饋會留在各自內容裡。</p>}
      </div>

      {api.canTalk && (
        <form
          className="rd-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!api.draft.trim()) return;
            api.onSend({ body: api.draft.trim(), replyToId: reply?.id, payload: reply ? { quotedBody: reply.body } : {} });
            setReply(null);
          }}
        >
          <input
            className="text-input"
            value={api.draft}
            onChange={(event) => api.setDraft(event.target.value)}
            placeholder={reply ? `回覆 ${reply.authorName}` : "這週先主推哪一份？"}
            aria-label="房間討論"
          />
          <button type="submit" className="btn btn-primary" disabled={!api.draft.trim()}>送出</button>
        </form>
      )}

      {boardPick && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setBoardPick(null)}>
          <section className="project-sheet" role="dialog" aria-label="加入白板">
            <h2>加到哪一塊白板？</h2>
            <div className="wb-options">
              {api.boards.filter((board) => !board.archivedAt).map((board) => (
                <button type="button" key={board.id} onClick={() => { api.onAddToBoard(boardPick, board.id); setBoardPick(null); }}>
                  {board.title}
                </button>
              ))}
              {!api.boards.some((board) => !board.archivedAt) && <p className="project-muted">先建立一塊白板</p>}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setBoardPick(null)}>取消</button>
          </section>
        </div>
      )}
    </div>
  );
}

export function DiscussionPaneTabs({
  pane,
  onPane,
}: {
  pane: "chat" | "board" | "voice";
  onPane: (pane: "chat" | "board" | "voice") => void;
}) {
  return (
    <div className="rd-tabs" role="tablist" aria-label="討論">
      <button type="button" className={pane === "chat" ? "is-active" : ""} onClick={() => onPane("chat")}>對話</button>
      <button type="button" className={pane === "board" ? "is-active" : ""} onClick={() => onPane("board")}>白板</button>
      <button type="button" className={pane === "voice" ? "is-active" : ""} onClick={() => onPane("voice")}>語音</button>
    </div>
  );
}
