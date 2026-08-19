import { useState } from "react";
import type { ProposalStatus, VisualProposal } from "./store";
import { PROPOSAL_STATUSES, proposalStatusLabel, proposalTypeLabel } from "./helpers";

/** Lets the proposal card name / open the 修改點 it came from without importing the room model. */
export type ProposalPinBinding = {
  /** e.g. "修改點 3"; null when the pin is gone or lives on another version. */
  labelFor: (commentId: string) => string | null;
  onOpen: (commentId: string) => void;
};

type Props = {
  doc: VisualProposal;
  active: boolean;
  userId: string;
  pin?: ProposalPinBinding;
  onSelect: () => void;
  onToggleSupport: () => void;
  onComment: (body: string) => void;
  onStatus: (status: ProposalStatus) => void;
};

function when(ts: number): string {
  return new Date(ts).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
}

/**
 * One proposal, as a card you can read, back, discuss and mark — the discussion
 * unit of 視覺提案 2.0. Editing the artwork itself happens on the poster, not here.
 */
export function ProposalCard({ doc, active, userId, pin, onSelect, onToggleSupport, onComment, onStatus }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const supported = doc.supports.some((s) => s.userId === userId);
  const pinLabel = doc.linkedCommentId ? pin?.labelFor(doc.linkedCommentId) : null;

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onComment(text);
    setDraft("");
  };

  return (
    <article className={`pcard ${active ? "is-active" : ""} is-${doc.status}`}>
      <button type="button" className="pcard-main" onClick={onSelect} aria-pressed={active}>
        <span className="pcard-head">
          <strong className="pcard-title">{doc.title}</strong>
          <span className={`pcard-status is-${doc.status}`}>{proposalStatusLabel(doc.status)}</span>
        </span>
        <span className="pcard-meta">
          <span className="pcard-type">{proposalTypeLabel(doc.type)}</span>
          <span>{doc.authorName}</span>
          <span>{when(doc.createdAt)}</span>
        </span>
        {doc.description && <span className="pcard-desc">{doc.description}</span>}
      </button>

      {pinLabel && doc.linkedCommentId && (
        <button
          type="button"
          className="pcard-from"
          onClick={() => pin?.onOpen(doc.linkedCommentId!)}
        >
          來自{pinLabel}
        </button>
      )}

      <div className="pcard-actions">
        <button
          type="button"
          className={`pcard-support ${supported ? "is-on" : ""}`}
          aria-pressed={supported}
          onClick={onToggleSupport}
        >
          <span aria-hidden>👍</span> {doc.supports.length > 0 ? `支持 ${doc.supports.length}` : "我支持"}
        </button>
        <button type="button" className="pcard-quiet" onClick={() => setOpen((v) => !v)}>
          留言{doc.comments.length > 0 ? ` ${doc.comments.length}` : ""}
        </button>
      </div>

      {open && (
        <div className="pcard-thread">
          <div className="pcard-statusrow" role="group" aria-label="提案狀態">
            {PROPOSAL_STATUSES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`pcard-chip ${doc.status === s.key ? "is-on" : ""}`}
                aria-pressed={doc.status === s.key}
                onClick={() => onStatus(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {doc.comments.length === 0 && <p className="pcard-empty">還沒有人留言，說一句最直接。</p>}
          {doc.comments.map((c) => (
            <p key={c.id} className="pcard-comment">
              <span className="pcard-who" style={{ color: c.authorColor }}>
                {c.authorName}
              </span>
              {c.body}
            </p>
          ))}
          <div className="pcard-reply">
            <input
              className="m-input"
              placeholder="對這個提案說一句…"
              value={draft}
              enterKeyHint="send"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button type="button" className="m-btn m-btn-primary" onClick={submit} disabled={!draft.trim()}>
              送出
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
