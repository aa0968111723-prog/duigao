import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { REVIEW_PRIORITIES, REVIEW_TYPES, type ReviewType } from "../../lib/types";
import type { WorkspaceApi } from "../../components/api";

/** Quick, soft reasons shown first; each maps to a review type behind the scenes. */
const QUICK_REASONS: { label: string; type: ReviewType }[] = [
  { label: "看不清楚", type: "文字" },
  { label: "位置怪怪的", type: "排版" },
  { label: "圖片／素材", type: "圖片" },
  { label: "資訊有誤", type: "資訊錯誤" },
  { label: "我會這樣改", type: "其他" },
  { label: "其他", type: "其他" },
];

const STARTERS = ["我覺得這裡可以…", "這裡有點看不清楚", "如果改成…可能更好", "我第一眼會注意到…"];

/**
 * The add-a-note form. First screen is just: a quick reason (optional), one
 * sentence, and send. Suggestion / type / priority stay folded under 補充 so a
 * one-line note takes a couple of taps.
 */
export function PinFields({ api, autoFocus }: { api: WorkspaceApi; autoFocus?: boolean }) {
  const { form } = api;
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const submitOnMetaEnter = (e: { metaKey: boolean; ctrlKey: boolean; key: string; preventDefault: () => void }) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      api.commitPin();
    }
  };

  const useStarter = (starter: string) => {
    const next = form.body.trim() ? `${form.body.trim()} ${starter}` : starter;
    api.setForm({ body: next });
    areaRef.current?.focus();
  };

  // Focus synchronously in the tap's own task — that is what iOS needs to raise
  // the keyboard. The timeout only covers browsers that drop it.
  useLayoutEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!autoFocus) return;
    const id = window.setTimeout(() => {
      if (document.activeElement !== areaRef.current) areaRef.current?.focus();
    }, 80);
    return () => window.clearTimeout(id);
  }, [autoFocus]);

  return (
    <div className="m-form">
      <div className="m-chiprow" role="group" aria-label="快速原因（可跳過）">
        {QUICK_REASONS.map((r) => (
          <button
            key={r.label}
            type="button"
            className={`m-chip ${reason === r.label ? "is-on" : ""}`}
            onClick={() => {
              // A chip alone is valid feedback: prefill the note with it, but
              // never clobber something the person typed themselves.
              const next = reason === r.label ? null : r.label;
              const body = form.body.trim();
              const untouched = !body || body === reason;
              setReason(next);
              if (next) {
                api.setForm(untouched ? { type: r.type, body: next } : { type: r.type });
              } else if (untouched) {
                api.setForm({ body: "" });
              }
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      <textarea
        ref={areaRef}
        className="m-textarea"
        rows={2}
        autoFocus={autoFocus}
        enterKeyHint="done"
        placeholder="想法是什麼？一句話就可以，例如：日期可以再放大一點"
        value={form.body}
        onChange={(e) => api.setForm({ body: e.target.value })}
        onKeyDown={submitOnMetaEnter}
        aria-label="你的想法"
      />

      <div className="m-starters" role="group" aria-label="一句話提示">
        {STARTERS.map((s) => (
          <button key={s} type="button" className="m-starter" onClick={() => useStarter(s)}>
            {s}
          </button>
        ))}
      </div>

      {!details ? (
        <button type="button" className="m-link" onClick={() => setDetails(true)}>
          ＋ 補充建議、分類與優先（可跳過）
        </button>
      ) : (
        <div className="m-form-more">
          <textarea
            className="m-textarea"
            rows={2}
            placeholder="我會這樣改：（可不填）"
            value={form.suggestion}
            onChange={(e) => api.setForm({ suggestion: e.target.value })}
            onKeyDown={submitOnMetaEnter}
            aria-label="我會這樣改"
          />
          <div className="m-chiprow" role="group" aria-label="類型">
            {REVIEW_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={`m-chip ${form.type === t ? "is-on" : ""}`}
                onClick={() => api.setForm({ type: t })}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="m-chiprow" role="group" aria-label="優先程度">
            {REVIEW_PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                className={`m-chip ${form.priority === p ? "is-on" : ""}`}
                onClick={() => api.setForm({ priority: p })}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
