import { useEffect, useRef, useState } from "react";
import { ModalSheet } from "../../components/BottomSheet";
import {
  MAX_BRIEF_QUESTIONS,
  VIDEO_CATEGORIES,
  type ReviewBrief as Brief,
  type VideoCategory,
} from "../../lib/types";
import type { BriefInput } from "../../cloud/videoReview";

/**
 * 作者說明 — what this cut is, and what the author actually wants looked at.
 *
 * The first thing a partner sees after the player, and deliberately the
 * smallest: one line collapsed, everything else behind 展開. A reviewer who
 * opens the link from LINE should be able to start watching without reading a
 * brief at all; the brief is there for the ones who ask "what am I looking for".
 *
 * Per VERSION, never per room. 初剪 and 二剪 want different things, and a brief
 * that silently carries over is worse than no brief — it sends people hunting
 * for a problem that was fixed two cuts ago.
 *
 * Only the one-line summary lives inline. Reading the whole thing, and writing
 * it, happen in a sheet: the strip between the timeline and the discussion sheet
 * is a few dozen pixels on a phone, and a form that tall inside it ends up with
 * its own save button underneath the drag sheet — unreachable.
 */

type Props = {
  brief: Brief | null;
  /** owner/editor. A reviewer sees the same card without any way to edit it. */
  canEdit: boolean;
  /** A local-only room has nowhere to store a brief. */
  online: boolean;
  onSave: (input: BriefInput) => void;
};

/** The one-line gist for the collapsed state. */
function summarize(brief: Brief | null): string | null {
  if (!brief) return null;
  const firstLine = brief.body.split("\n").map((l) => l.trim()).find(Boolean);
  if (firstLine) return firstLine;
  if (brief.focusTags.length) return `想請大家看：${brief.focusTags.join("、")}`;
  if (brief.questions.length) return brief.questions[0];
  return null;
}

function hasContent(brief: Brief | null): boolean {
  return Boolean(brief && (brief.body.trim() || brief.focusTags.length || brief.questions.length));
}

export function ReviewBrief({ brief, canEdit, online, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(brief?.body ?? "");
  const [tags, setTags] = useState<VideoCategory[]>(brief?.focusTags ?? []);
  const [questions, setQuestions] = useState<string[]>(brief?.questions ?? []);

  // The server is the source of truth. Re-sync when it changes underneath —
  // another editor saving, or a version switch handing us a different brief —
  // but never while this person is mid-sentence.
  const savedRef = useRef(brief);
  useEffect(() => {
    if (editing) return;
    savedRef.current = brief;
    setBody(brief?.body ?? "");
    setTags(brief?.focusTags ?? []);
    setQuestions(brief?.questions ?? []);
  }, [brief, editing]);

  const summary = summarize(brief);
  const filled = hasContent(brief);

  // Nothing written and nobody who could write it: show nothing at all rather
  // than an empty card explaining its own emptiness.
  if (!filled && !canEdit) return null;

  const startEdit = () => {
    setEditing(true);
    setOpen(true);
  };

  // Both exits land back on the collapsed card. Dropping the author into the
  // read-only sheet after they just pressed 儲存 would make them close the same
  // brief twice to get back to the video.
  const cancelEdit = () => {
    setEditing(false);
    setOpen(false);
    setBody(brief?.body ?? "");
    setTags(brief?.focusTags ?? []);
    setQuestions(brief?.questions ?? []);
  };

  const save = () => {
    onSave({
      body: body.trim(),
      focusTags: tags,
      questions: questions.map((q) => q.trim()).filter(Boolean).slice(0, MAX_BRIEF_QUESTIONS),
    });
    setEditing(false);
    setOpen(false);
  };

  const toggleTag = (tag: VideoCategory) => {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  };

  const setQuestion = (index: number, value: string) => {
    setQuestions((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  if (editing) {
    return (
      <ModalSheet title="作者說明" onClose={cancelEdit} dismissible={false}>
      <section className="v-brief is-editing" aria-label="編輯作者說明">
        <label className="v-brief-field">
          <span>這一版說明</span>
          <textarea
            className="m-input v-brief-body"
            rows={3}
            maxLength={500}
            value={body}
            placeholder="例如：這是招生短片第一剪。這次主要想確認節奏、笑點，以及 0:42 後面的社團段會不會太快。"
            onChange={(e) => setBody(e.target.value)}
          />
        </label>

        <div className="v-brief-field">
          <span>這次想請大家特別看</span>
          <div className="v-brief-tags">
            {VIDEO_CATEGORIES.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`v-tag ${tags.includes(tag) ? "is-on" : ""}`}
                aria-pressed={tags.includes(tag)}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        <div className="v-brief-field">
          <span>想問的問題（最多 {MAX_BRIEF_QUESTIONS} 個）</span>
          {Array.from({ length: MAX_BRIEF_QUESTIONS }, (_, i) => (
            <input
              key={i}
              className="m-input v-brief-q"
              value={questions[i] ?? ""}
              maxLength={80}
              placeholder={
                i === 0 ? "前 10 秒有吸引你嗎？" : i === 1 ? "0:35 的轉場會不會太突兀？" : "結尾 CTA 看得懂嗎？"
              }
              onChange={(e) => setQuestion(i, e.target.value)}
            />
          ))}
        </div>

        <div className="v-brief-actions">
          <button type="button" className="m-btn m-btn-primary m-btn-sm" onClick={save} disabled={!online}>
            儲存說明
          </button>
          <button type="button" className="m-link" onClick={cancelEdit}>
            取消
          </button>
        </div>
        {!online && <p className="v-brief-note">這個房間還沒連上雲端，作者說明暫時存不了。</p>}
      </section>
      </ModalSheet>
    );
  }

  return (
    <section className="v-brief" aria-label="作者說明">
      <div className="v-brief-head">
        <span className="v-brief-label">作者說明</span>
        {filled ? (
          <button
            type="button"
            className="m-link v-brief-toggle"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            {open ? "收合" : "展開"}
          </button>
        ) : (
          <button type="button" className="m-link v-brief-toggle" onClick={startEdit}>
            寫一段
          </button>
        )}
      </div>

      {!open && summary && <p className="v-brief-summary">{summary}</p>}
      {!open && !summary && canEdit && (
        <p className="v-brief-summary is-empty">告訴夥伴這一版想請他們看什麼，回饋會準很多。</p>
      )}

      {open && (
        <ModalSheet title="作者說明" onClose={() => setOpen(false)}>
        <div className="v-brief-body-open">
          {brief?.body.trim() && <p className="v-brief-text">{brief.body}</p>}

          {Boolean(brief?.focusTags.length) && (
            <div className="v-brief-field">
              <span>這次想請大家特別看</span>
              <div className="v-brief-tags">
                {brief!.focusTags.map((tag) => (
                  <span key={tag} className="v-tag is-static">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {Boolean(brief?.questions.length) && (
            <ol className="v-brief-questions">
              {brief!.questions.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ol>
          )}

          {canEdit && (
            <div className="v-brief-actions">
              <button type="button" className="m-link" onClick={startEdit}>
                編輯說明
              </button>
            </div>
          )}
        </div>
        </ModalSheet>
      )}
    </section>
  );
}
