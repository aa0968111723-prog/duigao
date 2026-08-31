import { useEffect, useMemo, useRef, useState } from "react";
import { UniversalIntake, type IntakeHandle } from "../../components/UniversalIntake";
import { anchorFromDiscussion, openTarget } from "../../lib/contextAnchor";
import { indexMessages, replySnippet, resolveReply, type ReplyReference } from "../collaboration/replies";
import {
  attachmentCiteReply,
  boardPollWrite,
  canEditDiscussion,
  canTombstoneDiscussion,
  decisionDraftTitle,
  discussionEditPatch,
  firstUnreadMessageId,
  messageIsEdited,
  messageIsTombstoned,
  unreadCount,
  workCiteFromBoard,
  workCiteFromBranch,
} from "../collaboration/discussionHonesty";
import type { Guest, Room, RoomPoll } from "../../lib/types";
import { voiceUnavailableReason } from "../collaboration/voice";
import type { DecisionRecord, DiscussionMessage, DiscussionSupport, Whiteboard } from "../collaboration/types";
import { shouldFollowLatest, shouldMarkLatestFromFeedEnd } from "./feed";
import { voiceDockShowsLeave } from "./voiceDockLeave";
import {
  colleagueBubbleClass,
  GROK_MENTION_LABEL,
  GROK_TOMBSTONE_COPY,
  insertGrokMention,
  isColleagueMessage,
  showsGrokMentionChip,
} from "../collaboration/agentColleague";
import { messagesForFocus } from "../whiteboard/boardFocus";
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
  onAddToSchedule?: (message: DiscussionMessage) => void;
  onOpenBoardNode: (whiteboardId: string, nodeId?: string) => void;
  onCreateDecision: (title: string) => void;
  onFinalizeDecision: (id: string) => void;
  /** 作者改自己的文字。0022 允許改 body，不改作者。 */
  onEditMessage?: (messageId: string, body: string) => void;
  /** 0031：作者或 can_manage 標 tombstone。列留下，畫面畫墓碑。 */
  onTombstoneMessage?: (messageId: string) => void;
  /** 0031：自己的未讀水位。只給自己用，不給別人看。 */
  readWatermark?: { lastReadMessageId?: string; lastReadAt?: number } | null;
  onMarkRead?: (messageId: string) => void;
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
  attachUpload?: import("../../cloud/discussionWrite").DiscussionAttachUpload | null;
  /** 手機討論輸入聚焦時，殼把搜尋／總覽／AI 收起來。 */
  onComposerActive?: (active: boolean) => void;
  onReject?: (reason: string) => void;
  /**
   * 貼上／送出偵測為純 URL 時建立連結卡；回 false 則按一般文字送出。
   * 第二個參數是「這則連結卡是誰的回覆」— 少了它，回覆某人時只貼一條網址
   * 會把回覆對象整個丟掉（稽核 FEA-5／MSG-10）。
   */
  onSendLink?: (url: string, reply?: { replyToId: string; quotedBody: string }) => boolean;
  /** 附件卡的 signed URL 解析（App 持有 client 與快取；本元件純呈現）。 */
  resolveAssetUrl?: (path: string) => Promise<string>;
  /**
   * 語音房（PR-03，LiveKit）。undefined 或 available=false → 顯示既有的
   * 「還在準備」誠實文案；available → VoiceDock（加入/離開/靜音/名單）。
   */
  voice?: import("../../hooks/useVoiceRoom").VoiceDockApi;
  focusNodeId?: string | null;
  onAskColleague?: (input: { prompt: string; replyToId?: string; nodeId?: string }) => void;
  onApplyColleagueProposal?: (proposalId: string) => void;
  onRejectColleagueProposal?: (proposalId: string) => void;
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


/**
 * 訊息卡上的引用列。解析結果由 `resolveReply` 提供 —— 這裡只負責呈現，
 * 而且對兩種狀態說不同的話：
 *   resolved → 原作者＋摘要，可以點回去看來源。
 *   missing  → 明講「來源不在這份對話裡」，當初的快照標成引述、不冒充現況。
 * 兩者都不會渲染成一段沒有出處的文字（十五：不得複製出失去來源的孤立內容）。
 */
function ReplyRef({ reference, onJump }: { reference: ReplyReference; onJump: (sourceId: string) => void }) {
  if (reference.state === "none") return null;
  if (reference.state === "missing") {
    return (
      <div className="rd-quote is-orphan" data-testid="reply-ref-missing">
        <span className="rd-quote-head">來源不在這份對話裡</span>
        {reference.snapshot ? <span className="rd-quote-body">「{reference.snapshot}」</span> : null}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="rd-quote rd-quote-link"
      data-testid="reply-ref"
      onClick={() => onJump(reference.sourceId)}
      aria-label={`回覆 ${reference.authorName}：${reference.snippet}。點擊回到來源訊息`}
    >
      <span className="rd-quote-head">
        <span className="rd-dot" style={{ background: reference.authorColor }} aria-hidden />
        {reference.authorName}
        {reference.edited ? <span className="rd-quote-edited">已編輯</span> : null}
      </span>
      <span className="rd-quote-body">{reference.snippet}</span>
    </button>
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [decisionDraft, setDecisionDraft] = useState("");
  const [decisionDraftOpen, setDecisionDraftOpen] = useState(false);
  const [citeSheet, setCiteSheet] = useState<"work" | "attachment" | null>(null);
  const [pollDraft, setPollDraft] = useState<{ question: string; options: string[] } | null>(null);

  const showDecisions = api.showDecisions ?? true;
  const showRoomActions = api.showRoomActions ?? true;
  const decided = api.decisions.filter((item) => item.status === "decided");
  const pending = api.decisions.filter((item) => item.status === "pending");
  const openPolls = (api.room.polls ?? []).filter((poll) => !poll.closedAt);

  const messages = useMemo(
    () => [...api.messages].sort((a, b) => a.createdAt - b.createdAt),
    [api.messages],
  );
  // 引用解析用的索引。ghost（尚未落地的樂觀列）已經併在 api.messages 裡，
  // 所以剛送出的回覆立刻就解析得到來源，不會先閃一下「來源不在」。
  const byId = useMemo(() => indexMessages(messages), [messages]);
  // 跳到來源之後短暫標記，讓使用者看得出「就是這一則」。
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const holdingFirstUnreadRef = useRef(false);
  const jumpToMessage = (sourceId: string) => {
    if (sourceId === firstUnreadIdRef.current) {
      pinnedToLatest.current = false;
      holdingFirstUnreadRef.current = true;
    }
    const el = typeof document !== "undefined" ? document.getElementById(`rd-msg-${sourceId}`) : null;
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlightId(sourceId);
    if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightId(null), 1600);
  };
  useEffect(() => () => { if (highlightTimer.current !== null) window.clearTimeout(highlightTimer.current); }, []);

  const feedEndRef = useRef<HTMLDivElement>(null);
  const pinnedToLatest = useRef(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);
  const feedCountRef = useRef(0);
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  const lastMessage = messages[messages.length - 1];
  const firstUnreadId = useMemo(
    () => firstUnreadMessageId(messages, api.readWatermark),
    [messages, api.readWatermark],
  );
  const firstUnreadIdRef = useRef(firstUnreadId);
  firstUnreadIdRef.current = firstUnreadId;
  const unread = useMemo(
    () => unreadCount(messages, api.readWatermark),
    [messages, api.readWatermark],
  );
  const lastMessageRef = useRef(lastMessage);
  lastMessageRef.current = lastMessage;

  const scrollToLatest = (behavior: ScrollBehavior) => {
    const id = lastMessage?.id;
    if (!id || typeof document === "undefined") return;
    document.getElementById(`rd-msg-${id}`)?.scrollIntoView({ block: "end", behavior });
    pinnedToLatest.current = true;
    holdingFirstUnreadRef.current = false;
    setShowJumpLatest(false);
    if (lastMessage) api.onMarkRead?.(lastMessage.id);
  };

  useEffect(() => {
    pinnedToLatest.current = true;
    holdingFirstUnreadRef.current = false;
    feedCountRef.current = 0;
    lastMessageIdRef.current = undefined;
    setShowJumpLatest(false);
  }, [api.room.id]);

  useEffect(() => {
    if (!api.focusNodeId) return;
    const node = (api.room.whiteboardNodes ?? []).find((item) => item.id === api.focusNodeId) ?? null;
    const related = messagesForFocus(messages, node);
    const target = related[related.length - 1];
    if (target) jumpToMessage(target.id);
    // 只在焦點切換時捲，不跟新訊息搶最新列。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意只跟 focusNodeId
  }, [api.focusNodeId]);

  const activePane = api.pane ?? pane;
  useEffect(() => {
    if (activePane === "board") return;
    const el = feedEndRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      const intersecting = Boolean(entry?.isIntersecting);
      if (!intersecting) {
        pinnedToLatest.current = false;
        holdingFirstUnreadRef.current = false;
        return;
      }
      const latest = lastMessageRef.current;
      const unreadId = firstUnreadIdRef.current;
      let firstUnreadInView = false;
      if (unreadId && typeof document !== "undefined") {
        const unreadEl = document.getElementById(`rd-msg-${unreadId}`);
        if (unreadEl) {
          const box = unreadEl.getBoundingClientRect();
          firstUnreadInView = box.bottom > 0 && box.top < window.innerHeight;
        }
      }
      if (!shouldMarkLatestFromFeedEnd({
        endIntersecting: true,
        firstUnreadInView,
        holdingFirstUnread: holdingFirstUnreadRef.current,
      })) {
        return;
      }
      pinnedToLatest.current = true;
      setShowJumpLatest(false);
      if (latest) api.onMarkRead?.(latest.id);
    }, { threshold: 0.01 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [api.room.id, activePane]);

  useEffect(() => {
    const nextLastId = lastMessage?.id;
    if (feedCountRef.current === 0 && firstUnreadId && firstUnreadId !== nextLastId) {
      jumpToMessage(firstUnreadId);
      feedCountRef.current = messages.length;
      lastMessageIdRef.current = nextLastId;
      setShowJumpLatest(true);
      return;
    }
    const follow = shouldFollowLatest({
      previousCount: feedCountRef.current,
      nextCount: messages.length,
      pinnedToLatest: pinnedToLatest.current,
      previousLastId: lastMessageIdRef.current,
      nextLastId,
    });
    if (follow) {
      scrollToLatest(feedCountRef.current === 0 ? "auto" : "smooth");
    } else if (nextLastId && nextLastId !== lastMessageIdRef.current) {
      setShowJumpLatest(true);
    }
    feedCountRef.current = messages.length;
    lastMessageIdRef.current = nextLastId;
  }, [messages, lastMessage?.id, firstUnreadId]);

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

      {/* 語音（PR-03）：可用時是真的 dock；未設定/本機房維持誠實文案。 */}
      {(api.showVoiceNote ?? true) && (
        api.voice?.available ? (
          <div className="rd-voice-dock" data-testid="voice-dock">
            {voiceDockShowsLeave(api.voice.phase ?? api.voice.state) ? (
              <>
                <span className="rd-voice-live" aria-hidden>●</span>
                <span className="rd-voice-roster" data-testid="voice-roster">
                  {api.voice.participants.map((p) => (
                    <span key={p.identity} className={p.speaking ? "is-speaking" : ""}>
                      {p.name}{p.muted ? "（靜音）" : ""}
                    </span>
                  ))}
                </span>
                <button type="button" className="rd-voice-btn" onClick={api.voice.toggleMute} data-testid="voice-mute">
                  {api.voice.muted ? "取消靜音" : "靜音"}
                </button>
                <button type="button" className="rd-voice-btn is-leave" onClick={api.voice.leave} data-testid="voice-leave">離開</button>
              </>
            ) : (
              <>
                <span>{api.voice.activeSessionTitle ? `語音進行中：${api.voice.activeSessionTitle}` : "語音房間"}</span>
                <button
                  type="button"
                  className="rd-voice-btn"
                  onClick={api.voice.join}
                  disabled={api.voice.state === "connecting"}
                  data-testid="voice-join"
                >
                  {api.voice.state === "connecting" ? "連線中…" : api.voice.activeSessionTitle ? "加入語音" : api.voice.canStart ? "開始語音" : "加入語音"}
                </button>
              </>
            )}
            {api.voice.error && <span className="rd-voice-error" role="alert">{api.voice.error}</span>}
          </div>
        ) : (
          <div className="rd-voice-note" data-testid="voice-boundary">
            {voiceUnavailableReason()}
          </div>
        )
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
            {api.canManage && !decisionDraftOpen && (
              <button
                type="button"
                className="project-text-button"
                aria-label="新增待決定"
                data-testid="decision-draft-open"
                onClick={() => setDecisionDraftOpen(true)}
              >新增</button>
            )}
          </div>
          {api.canManage && decisionDraftOpen && (
            <form
              className="rd-decision-draft"
              data-testid="decision-draft"
              onSubmit={(event) => {
                event.preventDefault();
                const title = decisionDraftTitle(decisionDraft);
                if (!title) return;
                api.onCreateDecision(title);
                setDecisionDraft("");
                setDecisionDraftOpen(false);
              }}
            >
              <input
                className="text-input"
                value={decisionDraft}
                onChange={(event) => setDecisionDraft(event.target.value)}
                aria-label="待決定草稿"
                placeholder="待決定標題"
                data-testid="decision-draft-input"
                autoFocus
              />
              <button type="submit" className="project-text-button" data-testid="decision-draft-add" disabled={!decisionDraftTitle(decisionDraft)}>新增</button>
              <button type="button" className="project-text-button" onClick={() => { setDecisionDraft(""); setDecisionDraftOpen(false); }}>取消</button>
            </form>
          )}
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

      {api.focusNodeId && messagesForFocus(messages, (api.room.whiteboardNodes ?? []).find((item) => item.id === api.focusNodeId) ?? null).length === 0 && (
        <button
          type="button"
          className="project-muted rd-focus-empty"
          data-testid="focus-discuss-empty"
          onClick={() => {
            const input = document.querySelector('[data-testid="discussion-composer"] input') as HTMLInputElement | null;
            input?.focus();
          }}
        >針對這張留言</button>
      )}
      <div className="rd-feed" data-testid="discussion-feed">
        {messages.map((message) => {
          const supportCount = api.supports.filter((item) => item.messageId === message.id).length;
          const supported = api.supports.some((item) => item.messageId === message.id && item.userId === api.userId);
          const sendState = api.sendStates?.[message.id];
          // legacy（0001 messages）唯讀：沒有討論表的列可以支持/回覆。
          const readOnly = Boolean((message.payload as { legacy?: boolean }).legacy);
          const tombstoned = messageIsTombstoned(message);
          const bubble = colleagueBubbleClass(message);
          const colleague = bubble === "colleague";
          const proposals = colleague ? (message.payload.proposals ?? []).slice(0, 3) : [];
          return (
            <article
              className={`rd-msg${sendState === "sending" ? " is-sending" : ""}${sendState === "failed" ? " is-failed" : ""}${highlightId === message.id ? " is-highlight" : ""}${tombstoned ? " is-tombstone" : ""}${colleague ? " is-colleague" : ""}${bubble === "audit" ? " is-audit" : ""}`}
              key={message.id}
              id={`rd-msg-${message.id}`}
              data-testid={`discussion-${message.id}`}
              data-colleague={colleague ? "true" : undefined}
              data-audit={bubble === "audit" ? "true" : undefined}
              data-latest={message.id === lastMessage?.id ? "true" : undefined}
              data-first-unread={message.id === firstUnreadId ? "true" : undefined}
              data-tombstone={tombstoned ? "true" : undefined}
              onContextMenu={(event) => { event.preventDefault(); if (!tombstoned) setMenuId(message.id); }}
            >
              <header>
                <span className="rd-dot" style={{ background: colleague ? "#6b5ce7" : message.authorColor }} />
                <b>{colleague ? "Grok" : message.authorName}</b>
                {colleague ? <span className="rd-ai-badge" data-testid="discussion-ai-badge">AI</span> : null}
                {messageIsEdited(message) && !tombstoned ? <span className="rd-edited" data-testid="discussion-edited">已編輯</span> : null}
                <time>{timeLabel(message.createdAt)}</time>
              </header>
              {tombstoned ? (
                <p className="rd-tombstone" data-testid="discussion-tombstone">{colleague ? GROK_TOMBSTONE_COPY : "這則討論已刪除"}</p>
              ) : editingId === message.id ? (
                <form
                  className="rd-edit-form"
                  data-testid="discussion-edit-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const typed = event.currentTarget.querySelector('[data-testid="discussion-edit-input"]');
                    const raw = typed instanceof HTMLTextAreaElement ? typed.value : editDraft;
                    const patch = discussionEditPatch(raw);
                    if (!patch || !api.onEditMessage) return;
                    api.onEditMessage(message.id, patch.body);
                    setEditingId(null);
                  }}
                >
                  <textarea
                    className="text-input"
                    value={editDraft}
                    onChange={(event) => setEditDraft(event.target.value)}
                    aria-label="編輯訊息"
                    data-testid="discussion-edit-input"
                    rows={3}
                  />
                  <div className="rd-actions">
                    <button type="submit" data-testid="discussion-edit-save" disabled={!discussionEditPatch(editDraft)}>儲存</button>
                    <button type="button" onClick={() => setEditingId(null)}>取消</button>
                  </div>
                </form>
              ) : (
                <p>{message.body}</p>
              )}
              {!tombstoned && <ReplyRef reference={resolveReply(message, byId)} onJump={jumpToMessage} />}
              {!tombstoned && (message.kind === "whiteboard" || message.kind === "node" || message.payload.nodeId) && (
                <button
                  type="button"
                  className="rd-ref"
                  data-testid="discussion-open-board-focus"
                  onClick={() => {
                    // 導航走 ContextAnchor 契約（PR-02d）；壞列（缺
                    // whiteboardId）維持舊行為送空字串，讓 App 端 no-op。
                    const target = openTarget(anchorFromDiscussion(message.payload));
                    if (target.surface === "board") api.onOpenBoardNode(target.whiteboardId, target.nodeId);
                    else api.onOpenBoardNode(message.payload.whiteboardId ?? "", message.payload.nodeId);
                  }}
                >
                  {message.payload.nodeId ? "打開白板並聚焦這張" : (message.payload.title ?? "打開白板")}
                </button>
              )}
              {!tombstoned && colleague && proposals.length > 0 && (
                <div className="rd-colleague-proposals" data-testid="colleague-proposals">
                  {proposals.map((proposal) => (
                    <div key={proposal.id} className="rd-proposal-card" data-testid="colleague-proposal-card">
                      <strong>{proposal.label}</strong>
                      <div className="rd-actions">
                        <button type="button" data-testid="colleague-proposal-apply" onClick={() => api.onApplyColleagueProposal?.(proposal.id)}>套用</button>
                        <button type="button" data-testid="colleague-proposal-reject" onClick={() => api.onRejectColleagueProposal?.(proposal.id)}>不用</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!tombstoned && (message.kind === "poster" || message.kind === "video" || message.kind === "plan") && message.payload.branchId && (
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
              {!tombstoned && message.kind === "attachment" && (
                <AttachmentCard message={message} resolve={api.resolveAssetUrl} />
              )}
              {!tombstoned && message.kind === "link" && (() => {
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
              {!readOnly && !tombstoned && (
              <div className="rd-actions">
                <button type="button" onClick={() => setReply(message)}>回覆</button>
                {!colleague && bubble !== "audit" && (
                <button type="button" onClick={() => api.onSupport(message.id, !supported)}>支持{supportCount ? ` ${supportCount}` : ""}</button>
                )}
                {api.onEditMessage && (canEditDiscussion(message, api.userId, sendState) || canEditDiscussion(message, api.guest.id, sendState)) && (
                  <button
                    type="button"
                    data-testid="discussion-edit"
                    onClick={() => { setEditingId(message.id); setEditDraft(message.body); }}
                  >編輯</button>
                )}
                {api.onTombstoneMessage && (canTombstoneDiscussion(message, api.userId, api.canManage, sendState) || canTombstoneDiscussion(message, api.guest.id, api.canManage, sendState)) && (
                  <button
                    type="button"
                    data-testid="discussion-tombstone-btn"
                    onClick={() => api.onTombstoneMessage?.(message.id)}
                  >刪除</button>
                )}
                {showRoomActions && api.canManage && !colleague && bubble !== "audit" && (
                  <button
                    type="button"
                    data-testid="discussion-create-poll"
                    onClick={() => setPollDraft({ question: message.body, options: ["", ""] })}
                  >建立投票</button>
                )}
                {showRoomActions && <button type="button" onClick={() => setBoardPick(message)}>加入白板</button>}
                {showRoomActions && api.onAddToSchedule && (
                  <button type="button" data-testid="discussion-add-schedule" onClick={() => api.onAddToSchedule?.(message)}>加入時程</button>
                )}
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
        <div ref={feedEndRef} className="rd-feed-end" data-testid="discussion-feed-end" aria-hidden />
      </div>

      {firstUnreadId && unread > 0 && (
        <button
          type="button"
          className="rd-jump-unread"
          data-testid="jump-first-unread"
          onClick={() => jumpToMessage(firstUnreadId)}
        >
          第一則未讀{unread > 1 ? ` ${unread}` : ""}
        </button>
      )}
      {showJumpLatest && lastMessage && (
        <button
          type="button"
          className="rd-jump-latest"
          data-testid="jump-latest"
          onClick={() => scrollToLatest("smooth")}
        >
          最新訊息
        </button>
      )}

      {api.canTalk && (
        <form
          className="rd-composer"
          data-testid="discussion-composer"
          onSubmit={(event) => {
            event.preventDefault();
            const text = api.draft.trim();
            if (!text) return;
            // 純 URL 送出成連結卡；其他一律文字。onSendLink 拒收就退回文字。
            // 回覆對象要一起帶過去 —— 舊版在這條分支直接 return，於是
            // 「回覆某人時只貼一條網址」會把回覆整個丟掉（稽核 FEA-5）。
            const replyPayload = reply ? { replyToId: reply.id, quotedBody: replySnippet(reply) } : undefined;
            if (/^https?:\/\/\S+$/i.test(text) && api.onSendLink?.(text, replyPayload)) {
              api.setDraft("");
              setReply(null);
              return;
            }
            const payload = {
              ...(reply ? { quotedBody: replySnippet(reply) } : {}),
              ...(api.focusNodeId ? { nodeId: api.focusNodeId } : {}),
            };
            api.onSend({
              body: text,
              replyToId: reply?.id,
              payload,
            });
            setReply(null);
          }}
        >
          {reply && (
            <div className="rd-reply-bar" data-testid="composer-reply-bar">
              <span className="rd-reply-bar-text">
                回覆 <b>{reply.authorName}</b>：{replySnippet(reply)}
              </span>
              <button
                type="button"
                className="rd-reply-cancel"
                aria-label="取消回覆"
                data-testid="composer-reply-cancel"
                onClick={() => setReply(null)}
              >
                ✕
              </button>
            </div>
          )}
          {showsGrokMentionChip(api.draft) && api.onAskColleague && (
            <button
              type="button"
              className="rd-grok-chip"
              data-testid="grok-mention-chip"
              onClick={() => api.setDraft(insertGrokMention(api.draft))}
            >{GROK_MENTION_LABEL}</button>
          )}
          {api.onAskColleague && (
            <button
              type="button"
              className="rd-attach-button"
              data-testid="rd-ask-colleague"
              aria-label="問同事"
              onClick={() => {
                const prompt = api.draft.trim() || "我們下一步做什麼？";
                api.onAskColleague?.({ prompt, replyToId: reply?.id, nodeId: api.focusNodeId ?? undefined });
                api.setDraft("");
              }}
            >問同事</button>
          )}
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
          <button
            type="button"
            className="rd-attach-button"
            aria-label="引用房間內容"
            title="引用房間內容"
            data-testid="composer-cite-work"
            onClick={() => setCiteSheet("work")}
          >引</button>
          {api.messages.some((item) => item.kind === "attachment") && (
            <button
              type="button"
              className="rd-attach-button"
              aria-label="引用附件"
              data-testid="composer-cite-attachment"
              onClick={() => setCiteSheet("attachment")}
            >附件</button>
          )}
          {api.attachUpload && (
            <div
              className={`rd-attach-progress${api.attachUpload.phase === "failed" ? " is-failed" : ""}`}
              data-testid="attach-upload"
              data-phase={api.attachUpload.phase}
              role="status"
            >
              {api.attachUpload.previewUrl ? (
                <img src={api.attachUpload.previewUrl} alt="" className="rd-attach-preview" />
              ) : null}
              <span>{api.attachUpload.message}</span>
              {api.attachUpload.phase === "uploading" ? (
                <progress max={100} value={api.attachUpload.percent} />
              ) : null}
            </div>
          )}
          <input
            className="text-input"
            data-testid="discussion-composer-input"
            value={api.draft}
            onFocus={() => api.onComposerActive?.(true)}
            onBlur={() => api.onComposerActive?.(false)}
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

      {pollDraft && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setPollDraft(null)}>
          <section className="project-sheet" role="dialog" aria-label="建立投票">
            <div className="wb-sheet" data-testid="discussion-poll-draft">
              <h3>建立投票</h3>
              <p className="project-muted">題目要人填。空正文不是投票。AI 不能代建。</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const write = boardPollWrite(pollDraft.question, pollDraft.options);
                  if (!write) return;
                  api.onCreatePoll(write.question, write.options);
                  setPollDraft(null);
                }}
              >
                <input
                  className="text-input"
                  autoFocus
                  value={pollDraft.question}
                  onChange={(event) => setPollDraft({ ...pollDraft, question: event.target.value })}
                  aria-label="投票題目"
                  placeholder="投票題目"
                  data-testid="discussion-poll-question"
                />
                {pollDraft.options.map((option, index) => (
                  <input
                    key={index}
                    className="text-input"
                    value={option}
                    onChange={(event) => {
                      const options = [...pollDraft.options];
                      options[index] = event.target.value;
                      setPollDraft({ ...pollDraft, options });
                    }}
                    aria-label={`選項 ${index + 1}`}
                    placeholder={`選項 ${index + 1}`}
                    data-testid={`discussion-poll-option-${index}`}
                  />
                ))}
                {pollDraft.options.length < 6 && (
                  <button
                    type="button"
                    className="project-text-button"
                    onClick={() => setPollDraft({ ...pollDraft, options: [...pollDraft.options, ""] })}
                  >加選項</button>
                )}
                <button
                  type="submit"
                  className="project-save-button project-submit"
                  data-testid="discussion-create-poll-save"
                  disabled={!boardPollWrite(pollDraft.question, pollDraft.options)}
                >建立投票</button>
              </form>
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setPollDraft(null)}>取消</button>
          </section>
        </div>
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
      {citeSheet === "work" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setCiteSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="引用房間內容">
            <div className="wb-sheet" data-testid="cite-work">
              <h3>引用房間內容</h3>
              <p className="project-muted">卡片只記既有分支／白板 id，不改原稿。</p>
              <div className="wb-options">
                {(api.room.branches ?? []).map((branch) => {
                  const cite = workCiteFromBranch(branch);
                  if (!cite) return null;
                  return (
                    <button
                      type="button"
                      className="wb-card"
                      key={branch.id}
                      data-testid={`cite-work-${branch.id}`}
                      onClick={() => {
                        api.onSend({ kind: cite.kind, body: cite.body, payload: cite.payload });
                        setCiteSheet(null);
                      }}
                    >
                      {branch.name}
                    </button>
                  );
                })}
                {api.boards.filter((board) => !board.archivedAt).map((board) => {
                  const cite = workCiteFromBoard(board);
                  return (
                    <button
                      type="button"
                      className="wb-card"
                      key={board.id}
                      data-testid={`cite-work-board-${board.id}`}
                      onClick={() => {
                        api.onSend({ kind: cite.kind, body: cite.body, payload: cite.payload });
                        setCiteSheet(null);
                      }}
                    >
                      {board.title}
                    </button>
                  );
                })}
              </div>
              {!(api.room.branches ?? []).some((branch) => workCiteFromBranch(branch)) && !api.boards.some((board) => !board.archivedAt) && (
                <p className="project-muted">這個房間還沒有文宣、影片、企劃或白板可以引用。</p>
              )}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setCiteSheet(null)}>取消</button>
          </section>
        </div>
      )}
      {citeSheet === "attachment" && (
        <div className="project-scrim" onMouseDown={(event) => event.currentTarget === event.target && setCiteSheet(null)}>
          <section className="project-sheet" role="dialog" aria-label="引用附件">
            <div className="wb-sheet" data-testid="cite-attachment">
              <h3>引用附件</h3>
              <p className="project-muted">回覆既有附件卡，不另建一列假附件。</p>
              {api.messages.filter((item) => item.kind === "attachment").map((item) => {
                const cite = attachmentCiteReply(item);
                if (!cite) return null;
                return (
                  <button
                    type="button"
                    className="wb-card"
                    key={item.id}
                    data-testid={`cite-attachment-${item.id}`}
                    onClick={() => {
                      const source = api.messages.find((row) => row.id === cite.replyToId);
                      if (source) setReply(source);
                      setCiteSheet(null);
                    }}
                  >
                    {cite.quotedBody}
                  </button>
                );
              })}
            </div>
            <button type="button" className="project-sheet-close" onClick={() => setCiteSheet(null)}>取消</button>
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
