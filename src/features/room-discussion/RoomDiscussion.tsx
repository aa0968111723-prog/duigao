import { useMemo, useRef, useState } from "react";
import { UniversalIntake, type IntakeHandle } from "../../components/UniversalIntake";
import { anchorFromDiscussion, openTarget } from "../../lib/contextAnchor";
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
  /** 語音邊界說明；single 房 drawer 不顯示（語音是房間殼的事）。 */
  showVoiceNote?: boolean;
  /** 附件（PR-01b）：有提供才渲染迴紋針；上傳中由 attachBusy 鎖住。 */
  onAttach?: (files: File[]) => void;
  attachBusy?: boolean;
  onReject?: (reason: string) => void;
  /** 貼上／送出偵測為純 URL 時建立連結卡；回 false 則按一般文字送出。 */
  onSendLink?: (url: string) => boolean;
  /** 附件卡的 signed URL 解析（App 持有 client 與快取；本元件純呈現）。 */
  resolveAssetUrl?: (path: string) => Promise<string>;
};

function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** http/https 之外（javascript:/data:…）一律拒開 — href 是成員任意輸入。 */
function safeHref(href?: string): string | null {
  if (!href) return null;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function AttachmentCard({ message, resolve }: { message: DiscussionMessage; resolve?: (path: string) => Promise<string> }) {
  const [failed, setFailed] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const path = message.payload.path ?? "";
  const mime = message.payload.mime ?? "";
  const name = message.payload.name ?? message.payload.title ?? "附件";
  const size = humanSize(message.payload.size);
  const isAudio = mime.startsWith("audio/");
  const open = async () => {
    if (!resolve || !path) return;
    try {
      const url = await resolve(path);
      if (isAudio) setAudioUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
      setFailed(false);
    } catch {
      setFailed(true); // 簽名失敗（物件不見／離線）：與未送出的 is-failed 視覺區分
    }
  };
  const planform = message.payload.planform;
  return (
    <div className="rd-attachment" data-testid="attachment-card">
      <span className="rd-attachment-name">{planform ? "🗺️" : "📎"} {name}</span>
      {size ? <span className="rd-attachment-size">{size}</span> : null}
      {planform ? (
        // 場佈摘要（PR-06）：payload 的 client 主張，顯示用。原始 JSON
        // 原樣存在 storage — 開啟＝拿原檔，可匯回 planform 繼續編。
        <span className="rd-attachment-planform" data-testid="planform-chip">
          場佈 v{planform.version} · {planform.zoneCount} 區 · {planform.objectCount} 物件 · {planform.routeCount} 動線
        </span>
      ) : null}
      {audioUrl ? (
        <audio controls src={audioUrl} className="rd-attachment-audio" />
      ) : (
        <button type="button" className="rd-ref" onClick={open} disabled={!resolve || !path}>
          {isAudio ? "播放" : "開啟"}
        </button>
      )}
      {failed && <span className="rd-attachment-broken">目前打不開這個附件</span>}
    </div>
  );
}


function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-Hant", { hour: "2-digit", minute: "2-digit" });
}

function PollMini({ poll, room }: { poll: RoomPoll; room: Room }) {
  const count = (room.pollVotes ?? []).filter((vote) => vote.pollId === poll.id).length;
  return <div className="rd-ref">{poll.question} · {count} 人已投</div>;
}

export function RoomDiscussion({ api }: { api: RoomDiscussionApi }) {
  const [pane, setPane] = useState<"chat" | "board">(api.pane ?? "chat");
  const attachRef = useRef<IntakeHandle>(null);
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
      {(api.showVoiceNote ?? true) && (
      <div className="rd-voice-note" data-testid="voice-boundary">
        {VOICE_ROOM_MVP ? "語音已開啟" : voiceUnavailableReason()}
      </div>
      )}

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
          // legacy（0001 messages）唯讀：沒有討論表的列可以支持/回覆。
          const readOnly = Boolean((message.payload as { legacy?: boolean }).legacy);
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
                <button
                  type="button"
                  className="rd-ref"
                  onClick={() => {
                    // 導航走 ContextAnchor 契約（PR-02d）；壞列（缺
                    // whiteboardId）維持舊行為送空字串，讓 App 端 no-op。
                    const target = openTarget(anchorFromDiscussion(message.payload));
                    if (target.surface === "board") api.onOpenBoardNode(target.whiteboardId, target.nodeId);
                    else api.onOpenBoardNode(message.payload.whiteboardId ?? "", message.payload.nodeId);
                  }}
                >
                  {message.payload.title ?? "打開白板"}
                </button>
              )}
              {(message.kind === "poster" || message.kind === "video" || message.kind === "plan") && message.payload.branchId && (
                <button
                  type="button"
                  className="rd-ref"
                  onClick={() => {
                    const target = openTarget(anchorFromDiscussion(message.payload));
                    api.onOpenContent?.(target.surface === "content" ? target.branchId : message.payload.branchId!);
                  }}
                >
                  {message.payload.title ?? "房間內容"}
                </button>
              )}
              {message.kind === "attachment" && (
                <AttachmentCard message={message} resolve={api.resolveAssetUrl} />
              )}
              {message.kind === "link" && (() => {
                const href = safeHref(message.payload.href);
                return href ? (
                  <a className="rd-ref rd-link" href={href} target="_blank" rel="noopener noreferrer" data-testid="link-card">
                    🔗 {message.payload.title ?? href}
                  </a>
                ) : (
                  <span className="rd-ref">（不支援的連結）</span>
                );
              })()}
              {sendState === "failed" && api.onRetry && (
                <button type="button" className="rd-retry" data-testid="discussion-retry" onClick={() => api.onRetry?.(message.id)}>
                  未送出 · 重試
                </button>
              )}
              {!readOnly && (
              <div className="rd-actions">
                <button type="button" onClick={() => setReply(message)}>回覆</button>
                <button type="button" onClick={() => api.onSupport(message.id, !supported)}>支持{supportCount ? ` ${supportCount}` : ""}</button>
                {showRoomActions && api.canManage && <button type="button" onClick={() => api.onCreatePoll(message.body || "要不要這樣做？", ["贊成", "再想想"])}>建立投票</button>}
                {showRoomActions && <button type="button" onClick={() => setBoardPick(message)}>加入白板</button>}
              </div>
              )}
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
            const text = api.draft.trim();
            if (!text) return;
            // 純 URL 送出成連結卡；其他一律文字。onSendLink 拒收就退回文字。
            if (/^https?:\/\/\S+$/i.test(text) && api.onSendLink?.(text)) {
              api.setDraft("");
              setReply(null);
              return;
            }
            api.onSend({ body: text, replyToId: reply?.id, payload: reply ? { quotedBody: reply.body } : {} });
            setReply(null);
          }}
        >
          {api.onAttach && (
            <>
              <UniversalIntake ref={attachRef} profile="attachment" mode="trigger" onFiles={(files) => files && api.onAttach?.([...files])} onReject={api.onReject} />
              <button
                type="button"
                className="rd-attach-button"
                aria-label="附加檔案"
                data-testid="composer-attach"
                disabled={api.attachBusy}
                onClick={() => attachRef.current?.open()}
              >
                {api.attachBusy ? "…" : "📎"}
              </button>
            </>
          )}
          <input
            className="text-input"
            value={api.draft}
            onChange={(event) => api.setDraft(event.target.value)}
            onPaste={(event) => {
              // 只攔檔案貼上；文字貼上不動。
              const files = event.clipboardData?.files;
              if (files?.length && api.onAttach) {
                event.preventDefault();
                api.onAttach([...files]);
              }
            }}
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
