import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { REVIEW_PRIORITIES, REVIEW_TYPES } from "../lib/types";
import type { WorkspaceApi } from "./api";

/**
 * The add-a-note form. Only "哪裡需要調整" is required — type, priority and the
 * suggested fix stay folded away so a one-sentence note takes one tap.
 */
export function PinFields({ api, autoFocus }: { api: WorkspaceApi; autoFocus?: boolean }) {
  const { form } = api;
  const [details, setDetails] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Focus synchronously in the tap's own task — that is what iOS needs in order
  // to raise the keyboard. The timeout only covers browsers that drop it.
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
      <textarea
        ref={areaRef}
        className="m-textarea"
        rows={2}
        autoFocus={autoFocus}
        enterKeyHint="done"
        placeholder="哪裡需要調整？例如：日期太小看不清楚"
        value={form.body}
        onChange={(e) => api.setForm({ body: e.target.value })}
        aria-label="哪裡需要調整"
      />

      {!details ? (
        <button type="button" className="m-link" onClick={() => setDetails(true)}>
          ＋ 補充建議、分類與優先
        </button>
      ) : (
        <div className="m-form-more">
          <textarea
            className="m-textarea"
            rows={2}
            placeholder="建議怎麼改？（可不填）"
            value={form.suggestion}
            onChange={(e) => api.setForm({ suggestion: e.target.value })}
            aria-label="建議怎麼改"
          />
          <div className="m-chiprow" role="group" aria-label="問題類型">
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
