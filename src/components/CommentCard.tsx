import { useState } from "react";
import type { CommentPin } from "../lib/types";
import { hasSupported, pinNumber, repliesFor, supportCount, versionLabel, type WorkspaceApi } from "./api";

type Props = {
  api: WorkspaceApi;
  pin: CommentPin;
  selected?: boolean;
  compact?: boolean;
  onSelect?: () => void;
  onToggleResolve: () => void;
};

/**
 * One review item. Number / note / status / author stay primary; below them are
 * the two low-friction actions: 我也覺得 and 回覆 (a short thread, collapsed).
 */
export function CommentCard({ api, pin, selected, compact, onSelect, onToggleResolve }: Props) {
  const { room, guest } = api;
  const n = pinNumber(room, pin.id);
  const label = versionLabel(room, pin.versionId);
  const supports = supportCount(room, pin.id);
  const supported = hasSupported(room, pin.id, guest.id);
  const replies = repliesFor(room, pin.id);

  const [showReply, setShowReply] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [replyText, setReplyText] = useState("");

  const maxCollapsed = compact ? 1 : 2;
  const visibleReplies = expanded ? replies : replies.slice(-maxCollapsed);
  const hiddenCount = replies.length - visibleReplies.length;

  const submitReply = () => {
    const text = replyText.trim();
    if (!text) return;
    api.addReply(pin.id, text);
    setReplyText("");
  };

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <article
      className={`m-item ${pin.resolved ? "is-done" : ""} ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      id={`pin-card-${pin.id}`}
    >
      <div className="m-item-top">
        <span className={`m-item-no ${pin.resolved ? "is-done" : ""}`}>{pin.resolved ? "✓" : n}</span>
        <p className="m-item-body">{pin.body}</p>
      </div>
      <div className="m-item-meta">
        <span className="m-item-who" style={{ color: pin.authorColor }}>
          {pin.authorName}
        </span>
        {label && <span>{label}</span>}
        {pin.priority && pin.priority !== "一般" && <span className="m-item-urgent">{pin.priority}</span>}
        {!compact && pin.problemType && <span>{pin.problemType}</span>}
        <button
          type="button"
          className={`m-item-state ${pin.resolved ? "is-done" : ""}`}
          onClick={(e) => {
            stop(e);
            onToggleResolve();
          }}
        >
          {pin.resolved ? "重新開啟" : "標記完成"}
        </button>
      </div>
      {pin.suggestion && <p className="m-item-suggestion">我會這樣改：{pin.suggestion}</p>}

      <div className="m-item-actions">
        <button
          type="button"
          className={`m-support ${supported ? "is-on" : ""}`}
          aria-pressed={supported}
          onClick={(e) => {
            stop(e);
            api.toggleSupport(pin.id);
          }}
        >
          <span aria-hidden>👍</span> {supports > 0 ? `我也覺得 ${supports}` : "我也覺得"}
        </button>
        <button
          type="button"
          className="m-reply-toggle"
          onClick={(e) => {
            stop(e);
            setShowReply((v) => !v);
          }}
        >
          回覆{replies.length > 0 ? ` ${replies.length}` : ""}
        </button>
      </div>

      {(replies.length > 0 || showReply) && (
        <div className="m-replies" onClick={stop}>
          {hiddenCount > 0 && (
            <button type="button" className="m-link m-replies-more" onClick={() => setExpanded(true)}>
              查看更多 {hiddenCount} 則
            </button>
          )}
          {visibleReplies.map((r) => (
            <p key={r.id} className="m-reply">
              <span className="m-reply-who" style={{ color: r.authorColor }}>
                {r.authorName}
              </span>
              {r.body}
            </p>
          ))}
          {showReply && (
            <div className="m-reply-input">
              <input
                className="m-input"
                placeholder="回一句…"
                value={replyText}
                enterKeyHint="send"
                autoFocus
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submitReply();
                  }
                }}
              />
              <button
                type="button"
                className="m-btn m-btn-primary"
                onClick={submitReply}
                disabled={!replyText.trim()}
              >
                送出
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
